import type { AppConfig } from "../config/index.js";
import type { AutomationRepository } from "../db/contracts.js";
import type { Logger } from "../observability/logger.js";
import type { Orchestrator } from "../orchestrator/index.js";
import type { AutomationRun, AutomationTask, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { createId } from "../utils/id.js";
import { normalizeWhitespace, truncate } from "../utils/text.js";

type AutomationRunListener = (run: AutomationRun, task: AutomationTask) => void;

interface AutomationServiceDependencies {
    config: AppConfig;
    logger: Logger;
    automations: AutomationRepository;
}

interface CreateTaskInput {
    request: UserRequest;
    prompt: string;
    nextRunAt: Date;
    title?: string;
    now?: Date;
}

interface CreateRecurringTaskInput extends CreateTaskInput {
    intervalMs: number;
}

export class AutomationService {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly automations: AutomationRepository;
    private readonly listeners = new Set<AutomationRunListener>();
    private orchestrator: Orchestrator | undefined;
    private timer: NodeJS.Timeout | undefined;
    private ticking = false;

    public constructor(dependencies: AutomationServiceDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.automations = dependencies.automations;
    }

    public setOrchestrator(orchestrator: Orchestrator): void {
        this.orchestrator = orchestrator;
    }

    public start(): void {
        if (!this.config.automation.enabled) {
            this.logger.info("Automation scheduler disabled");
            return;
        }

        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => {
            void this.runDueTasks();
        }, this.config.automation.pollIntervalMs);
        this.timer.unref?.();
        void this.runDueTasks();
        this.logger.info("Automation scheduler started", {
            pollIntervalMs: this.config.automation.pollIntervalMs,
            maxDuePerTick: this.config.automation.maxDuePerTick,
        });
    }

    public stop(): void {
        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);
        this.timer = undefined;
        this.logger.info("Automation scheduler stopped");
    }

    public getHealth() {
        return {
            enabled: this.config.automation.enabled,
            running: Boolean(this.timer),
            pollIntervalMs: this.config.automation.pollIntervalMs,
            maxDuePerTick: this.config.automation.maxDuePerTick,
        };
    }

    public subscribe(listener: AutomationRunListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public async createReminder(input: CreateTaskInput): Promise<AutomationTask> {
        const now = input.now ?? new Date();
        const task = this.createBaseTask(input.request, {
            type: "reminder",
            prompt: input.prompt,
            nextRunAt: input.nextRunAt,
            now,
            ...(input.title ? { title: input.title } : {}),
        });
        await this.automations.createTask(task);
        return task;
    }

    public async createRecurringPrompt(input: CreateRecurringTaskInput): Promise<AutomationTask> {
        const now = input.now ?? new Date();
        const task = this.createBaseTask(input.request, {
            type: "recurring-prompt",
            prompt: input.prompt,
            nextRunAt: input.nextRunAt,
            now,
            intervalMs: input.intervalMs,
            ...(input.title ? { title: input.title } : {}),
        });
        await this.automations.createTask(task);
        return task;
    }

    public listTasks(userId: string, includeInactive = false): Promise<AutomationTask[]> {
        return this.automations.listTasksByUser(userId, includeInactive);
    }

    public listRuns(taskId: string): Promise<AutomationRun[]> {
        return this.automations.listRunsByTask(taskId);
    }

    public cancelTask(userId: string, taskId: string): Promise<boolean> {
        return this.automations.cancelTask(userId, taskId, new Date());
    }

    public async runDueTasks(now = new Date()): Promise<AutomationRun[]> {
        if (!this.config.automation.enabled || this.ticking) {
            return [];
        }

        this.ticking = true;
        try {
            const due = await this.automations.getDueTasks(now, this.config.automation.maxDuePerTick);
            const runs: AutomationRun[] = [];

            for (const task of due) {
                runs.push(await this.executeTask(task));
            }

            return runs;
        } finally {
            this.ticking = false;
        }
    }

    private createBaseTask(
        request: UserRequest,
        input: {
            type: AutomationTask["type"];
            prompt: string;
            title?: string;
            nextRunAt: Date;
            now: Date;
            intervalMs?: number;
        },
    ): AutomationTask {
        const prompt = normalizeWhitespace(input.prompt);
        const title = normalizeWhitespace(input.title || prompt);
        return {
            id: createId("task"),
            userId: request.userId,
            channel: request.channel,
            type: input.type,
            title: truncate(title, 80),
            prompt,
            status: "active",
            nextRunAt: input.nextRunAt,
            createdAt: input.now,
            updatedAt: input.now,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
            ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
        };
    }

    private async executeTask(task: AutomationTask): Promise<AutomationRun> {
        const startedAt = new Date();

        try {
            const output =
                task.type === "reminder"
                    ? `Reminder: ${task.prompt}`
                    : await this.executeRecurringPrompt(task);
            const completedAt = new Date();
            const run: AutomationRun = {
                id: createId("arun"),
                taskId: task.id,
                userId: task.userId,
                status: "completed",
                startedAt,
                completedAt,
                output,
                ...(task.conversationId ? { conversationId: task.conversationId } : {}),
            };

            await this.automations.saveRun(run);
            await this.updateSuccessfulTask(task, completedAt);
            this.notify(run, task);
            return run;
        } catch (error) {
            const message = errorMessage(error);
            const completedAt = new Date();
            const run: AutomationRun = {
                id: createId("arun"),
                taskId: task.id,
                userId: task.userId,
                status: "failed",
                startedAt,
                completedAt,
                error: message,
                ...(task.conversationId ? { conversationId: task.conversationId } : {}),
            };

            await this.automations.saveRun(run);
            await this.automations.failTask(task.id, completedAt, message);
            this.notify(run, { ...task, status: "failed", error: message });
            this.logger.warn("Automation task failed", { taskId: task.id, error: message });
            return run;
        }
    }

    private async executeRecurringPrompt(task: AutomationTask): Promise<string> {
        if (!this.orchestrator) {
            throw new Error("Automation orchestrator is not configured.");
        }

        const response = await this.orchestrator.handleRequest({
            requestId: createId("req"),
            channel: task.channel,
            userId: task.userId,
            ...(task.conversationId ? { conversationId: task.conversationId } : {}),
            message: task.prompt,
            attachments: [],
            metadata: {
                externalConversationRef: `automation:${task.id}`,
            },
        });

        return response.content;
    }

    private async updateSuccessfulTask(task: AutomationTask, completedAt: Date): Promise<void> {
        if (task.type === "recurring-prompt" && task.intervalMs && task.intervalMs > 0) {
            await this.automations.rescheduleTask(
                task.id,
                this.nextIntervalRun(task.nextRunAt, task.intervalMs, completedAt),
                completedAt,
            );
            return;
        }

        await this.automations.completeTask(task.id, completedAt);
    }

    private nextIntervalRun(previousRunAt: Date, intervalMs: number, completedAt: Date): Date {
        let next = new Date(previousRunAt.getTime() + intervalMs);
        while (next.getTime() <= completedAt.getTime()) {
            next = new Date(next.getTime() + intervalMs);
        }
        return next;
    }

    private notify(run: AutomationRun, task: AutomationTask): void {
        for (const listener of this.listeners) {
            try {
                listener(run, task);
            } catch (error) {
                this.logger.warn("Automation listener failed", { error: errorMessage(error) });
            }
        }
    }
}
