import type { AutomationService } from "../automation/service.js";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { AutomationTask, ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import { getDirectCommandArgText } from "../utils/direct-command.js";
import { errorMessage } from "../utils/error.js";
import { normalizeWhitespace, truncate } from "../utils/text.js";
import { createToolInput } from "../utils/tool-input.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface AutomationToolDependencies {
    config: AppConfig;
    logger: Logger;
    automation: AutomationService;
}

interface ParsedDelay {
    text: string;
    runAt: Date;
}

interface ParsedRecurring {
    prompt: string;
    intervalMs: number;
}

export class AutomationTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly automation: AutomationService;

    public constructor(dependencies: AutomationToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.automation = dependencies.automation;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "automation",
            description:
                "Create, list, and cancel scheduled reminders or recurring AI prompt jobs. Use when the user wants Jarvis to remind them later, repeat a task, or run a saved prompt on a schedule.",
            command: "automation",
            argsHint: "<remind|every|tasks|cancel>",
            examples: [
                "remind submit assignment in 2h",
                "remind call mentor at 2026-05-08 18:00",
                "every 1d do summarize today's AI news",
                "tasks",
                "cancel task task_abc",
            ],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["create-reminder", "create-recurring", "list", "cancel"],
                    },
                    prompt: {
                        type: "string",
                        description: "Reminder text or recurring prompt to save.",
                    },
                    runAt: {
                        type: "string",
                        description: "Future date/time for a reminder, preferably ISO 8601.",
                    },
                    delayMinutes: {
                        type: "number",
                        description: "Relative delay in minutes from now.",
                    },
                    intervalMinutes: {
                        type: "number",
                        description: "Recurring interval in minutes.",
                    },
                    taskId: {
                        type: "string",
                        description: "Automation task id to cancel.",
                    },
                },
                required: ["action"],
            },
        };
    }

    public isEnabled(channel: ChannelKind): boolean {
        return (
            this.config.automation.enabled &&
            this.config.tools.automation.enabled &&
            this.config.tools.automation.perChannel[channel]
        );
    }

    public matchDirectInvocation(request: UserRequest): CommandToolInvocation | null {
        if (!this.isEnabled(request.channel)) {
            return null;
        }

        const automationArg = getDirectCommandArgText(request.message, this.describe().command);
        const commandText = automationArg != null ? automationArg || "tasks" : request.message;
        const parsed = this.parseDirectCommand(commandText, new Date());

        if (!parsed) {
            return null;
        }

        return {
            request,
            source: "direct-command",
            arguments: parsed,
        };
    }

    public async execute(invocation: CommandToolInvocation): Promise<ToolCallRecord> {
        const action = this.readString(invocation.arguments.action);
        const input = createToolInput(invocation.source, invocation.request.message, invocation.arguments);

        try {
            switch (action) {
                case "create-reminder":
                    return await this.createReminder(invocation, input);
                case "create-recurring":
                    return await this.createRecurring(invocation, input);
                case "list":
                    return await this.listTasks(invocation, input);
                case "cancel":
                    return await this.cancelTask(invocation, input);
                default:
                    return createToolRecord("automation", input, false, this.helpText());
            }
        } catch (error) {
            const text = errorMessage(error);
            this.logger.warn("Automation tool failed", { error: text });
            return createToolRecord("automation", input, false, `Automation failed: ${text}`);
        }
    }

    private async createReminder(
        invocation: CommandToolInvocation,
        input: ReturnType<typeof createToolInput>,
    ): Promise<ToolCallRecord> {
        const prompt = this.cleanPrompt(this.readString(invocation.arguments.prompt));
        const runAt = this.resolveRunAt(invocation.arguments, new Date());

        if (!prompt || !runAt) {
            return createToolRecord(
                "automation",
                input,
                false,
                "Please include reminder text and a future time. Example: remind submit assignment in 2h",
            );
        }

        const task = await this.automation.createReminder({
            request: invocation.request,
            prompt,
            title: prompt,
            nextRunAt: runAt,
        });

        return createToolRecord("automation", input, true, this.formatCreatedTask("Created reminder", task));
    }

    private async createRecurring(
        invocation: CommandToolInvocation,
        input: ReturnType<typeof createToolInput>,
    ): Promise<ToolCallRecord> {
        const prompt = this.cleanPrompt(this.readString(invocation.arguments.prompt));
        const intervalMinutes = this.readNumber(invocation.arguments.intervalMinutes);
        const intervalMs = intervalMinutes && intervalMinutes > 0 ? intervalMinutes * MINUTE_MS : null;

        if (!prompt || !intervalMs) {
            return createToolRecord(
                "automation",
                input,
                false,
                "Please include a recurring interval and prompt. Example: every 1d do summarize today's AI news",
            );
        }

        const task = await this.automation.createRecurringPrompt({
            request: invocation.request,
            prompt,
            title: prompt,
            nextRunAt: new Date(Date.now() + intervalMs),
            intervalMs,
        });

        return createToolRecord("automation", input, true, this.formatCreatedTask("Created recurring job", task));
    }

    private async listTasks(
        invocation: CommandToolInvocation,
        input: ReturnType<typeof createToolInput>,
    ): Promise<ToolCallRecord> {
        const tasks = await this.automation.listTasks(invocation.request.userId, true);
        if (tasks.length === 0) {
            return createToolRecord("automation", input, true, "No automation tasks found.");
        }

        const lines = tasks.map((task) => {
            const interval = task.intervalMs ? ` every ${this.formatInterval(task.intervalMs)}` : "";
            return `- ${task.id} [${task.status}] ${task.title} -> ${task.nextRunAt.toISOString()}${interval}`;
        });

        return createToolRecord("automation", input, true, `Automation tasks\n${lines.join("\n")}`);
    }

    private async cancelTask(
        invocation: CommandToolInvocation,
        input: ReturnType<typeof createToolInput>,
    ): Promise<ToolCallRecord> {
        const taskId = this.readString(invocation.arguments.taskId);
        if (!taskId) {
            return createToolRecord("automation", input, false, "Please provide a task id. Example: cancel task task_abc");
        }

        const canceled = await this.automation.cancelTask(invocation.request.userId, taskId);
        return createToolRecord(
            "automation",
            input,
            canceled,
            canceled ? `Canceled automation task ${taskId}.` : `Could not cancel active task ${taskId}.`,
        );
    }

    private parseDirectCommand(text: string, now: Date): Record<string, unknown> | null {
        const cleaned = normalizeWhitespace(text);

        if (/^tasks$/i.test(cleaned) || /^list\s+tasks$/i.test(cleaned)) {
            return { action: "list" };
        }

        const cancel = cleaned.match(/^cancel\s+task\s+(\S+)$/i);
        if (cancel) {
            return { action: "cancel", taskId: cancel[1] };
        }

        const recurring = this.parseRecurring(cleaned);
        if (recurring) {
            return {
                action: "create-recurring",
                prompt: recurring.prompt,
                intervalMinutes: recurring.intervalMs / MINUTE_MS,
            };
        }

        const reminder = cleaned.match(/^remind(?:\s+me)?\s+(.+)$/i);
        if (reminder) {
            const parsed = this.parseReminderDelay(reminder[1] ?? "", now);
            if (!parsed) {
                return { action: "create-reminder", prompt: this.cleanPrompt(reminder[1] ?? "") };
            }

            return {
                action: "create-reminder",
                prompt: parsed.text,
                runAt: parsed.runAt.toISOString(),
            };
        }

        return null;
    }

    private parseRecurring(text: string): ParsedRecurring | null {
        const match = text.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)\s+do\s+(.+)$/i);
        if (!match) {
            return null;
        }

        const value = Number(match[1]);
        const intervalMs = this.intervalToMs(value, match[2] ?? "");
        const prompt = this.cleanPrompt(match[3] ?? "");

        if (!intervalMs || !prompt) {
            return null;
        }

        return { prompt, intervalMs };
    }

    private parseReminderDelay(text: string, now: Date): ParsedDelay | null {
        const relative = text.match(/^(.+?)\s+in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/i);
        if (relative) {
            const delayMs = this.intervalToMs(Number(relative[2]), relative[3] ?? "");
            const reminderText = this.cleanPrompt(relative[1] ?? "");
            return delayMs && reminderText
                ? { text: reminderText, runAt: new Date(now.getTime() + delayMs) }
                : null;
        }

        const absolute = text.match(/^(.+?)\s+at\s+(.+)$/i);
        if (absolute) {
            const reminderText = this.cleanPrompt(absolute[1] ?? "");
            const runAt = this.parseDate(this.readString(absolute[2]));
            return reminderText && runAt && runAt.getTime() > now.getTime()
                ? { text: reminderText, runAt }
                : null;
        }

        return null;
    }

    private resolveRunAt(args: Record<string, unknown>, now: Date): Date | null {
        const delayMinutes = this.readNumber(args.delayMinutes);
        if (delayMinutes && delayMinutes > 0) {
            return new Date(now.getTime() + delayMinutes * MINUTE_MS);
        }

        const runAt = this.parseDate(this.readString(args.runAt));
        if (!runAt || runAt.getTime() <= now.getTime()) {
            return null;
        }

        return runAt;
    }

    private parseDate(value: string | null): Date | null {
        if (!value) {
            return null;
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    private intervalToMs(value: number, unit: string): number | null {
        if (!Number.isFinite(value) || value <= 0) {
            return null;
        }

        const normalized = unit.toLowerCase();
        if (["m", "min", "mins", "minute", "minutes"].includes(normalized)) {
            return value * MINUTE_MS;
        }
        if (["h", "hour", "hours"].includes(normalized)) {
            return value * HOUR_MS;
        }
        if (["d", "day", "days"].includes(normalized)) {
            return value * DAY_MS;
        }

        return null;
    }

    private readString(value: unknown): string | null {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    private readNumber(value: unknown): number | null {
        if (typeof value === "number") {
            return Number.isFinite(value) ? value : null;
        }

        if (typeof value === "string" && value.trim()) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }

        return null;
    }

    private cleanPrompt(value: string | null): string | null {
        if (!value) {
            return null;
        }

        const cleaned = normalizeWhitespace(value)
            .replace(/^to\s+/i, "")
            .replace(/[.!]+$/g, "")
            .trim();

        return cleaned || null;
    }

    private formatCreatedTask(prefix: string, task: AutomationTask): string {
        const interval = task.intervalMs ? `\n- interval: ${this.formatInterval(task.intervalMs)}` : "";
        return [
            `${prefix}: ${task.id}`,
            `- title: ${truncate(task.title, 100)}`,
            `- next run: ${task.nextRunAt.toISOString()}`,
            `- status: ${task.status}${interval}`,
        ].join("\n");
    }

    private formatInterval(intervalMs: number): string {
        if (intervalMs % DAY_MS === 0) {
            return `${intervalMs / DAY_MS}d`;
        }
        if (intervalMs % HOUR_MS === 0) {
            return `${intervalMs / HOUR_MS}h`;
        }
        return `${Math.round(intervalMs / MINUTE_MS)}m`;
    }

    private helpText(): string {
        return [
            "Automation commands:",
            "- remind submit assignment in 2h",
            "- remind call mentor at 2026-05-08 18:00",
            "- every 1d do summarize today's AI news",
            "- tasks",
            "- cancel task task_abc",
        ].join("\n");
    }
}
