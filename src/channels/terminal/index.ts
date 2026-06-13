import { createInterface, type Interface } from "node:readline/promises";
import type { AutomationService } from "../../automation/service.js";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { Orchestrator } from "../../orchestrator/index.js";
import type { AutomationRun, AutomationTask, ProgressEvent, ToolCallRecord } from "../../types/core.js";
import { createId } from "../../utils/id.js";
import { formatToolInput } from "../../utils/tool-input.js";
import type { ChannelAdapter } from "../types.js";

interface TerminalChannelDependencies {
    config: AppConfig;
    logger: Logger;
    orchestrator: Orchestrator;
    automation?: AutomationService;
}

const DIVIDER = "-".repeat(72);

export class TerminalChannelAdapter implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private readonly automation: AutomationService | undefined;
    private readline: Interface | undefined;
    private running = false;
    private conversationId = createId("conv");
    private selectedModel: string | undefined;
    private unsubscribeAutomation: (() => void) | undefined;

    public constructor(dependencies: TerminalChannelDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.orchestrator = dependencies.orchestrator;
        this.automation = dependencies.automation;
    }

    public async start(): Promise<void> {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            this.logger.info("Terminal channel skipped because no interactive TTY is available.");
            return;
        }

        this.readline = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        this.running = true;
        this.unsubscribeAutomation = this.automation?.subscribe((run, task) => {
            this.printAutomationRun(run, task);
        });

        console.log(this.dim(DIVIDER));
        console.log(
            `${this.accent("Jarvis terminal ready.")} ${this.dim("Use /new, /models, /model <provider:model>, /search <query>, or /exit.")}`,
        );
        console.log(this.dim(DIVIDER));
        void this.loop();
    }

    public async stop(): Promise<void> {
        this.running = false;
        this.unsubscribeAutomation?.();
        this.unsubscribeAutomation = undefined;
        this.readline?.close();
        this.readline = undefined;
    }

    private async loop(): Promise<void> {
        if (!this.readline) {
            return;
        }

        while (this.running) {
            const input = (await this.readline.question("you> ")).trim();
            if (!input) {
                continue;
            }

            if (input === "/exit") {
                this.running = false;
                this.readline.close();
                break;
            }

            if (input === "/new") {
                this.conversationId = createId("conv");
                console.log(this.info("Started a new conversation."));
                continue;
            }

            if (input === "/models") {
                const models = this.orchestrator.listModels();
                console.log(this.accent("Available models"));
                console.log(
                    models
                        .map((model) => this.dim(`- ${model.provider}:${model.id} [${model.roles.join(", ")}]`))
                        .join("\n"),
                );
                continue;
            }

            if (input.startsWith("/model ")) {
                this.selectedModel = input.slice(7).trim() || undefined;
                console.log(
                    this.selectedModel
                        ? this.info(`Selected model ${this.selectedModel}`)
                        : this.info("Cleared selected model."),
                );
                continue;
            }

            const allowWebSearch = input.startsWith("/search ");
            const message = allowWebSearch ? input.slice(8).trim() : input;
            const request = {
                requestId: createId("req"),
                channel: "terminal" as const,
                userId: this.config.app.defaultUserId,
                conversationId: this.conversationId,
                message,
                attachments: [],
                ...(this.selectedModel ? { requestedModel: this.selectedModel } : {}),
                metadata: allowWebSearch ? { allowWebSearch: true } : {},
            };

            try {
                let streamed = false;
                let printedAssistantLabel = false;

                for await (const event of this.orchestrator.handleRequestStream(request)) {
                    if (event.type === "delta") {
                        if (!printedAssistantLabel) {
                            process.stdout.write(`${this.assistantLabel()} `);
                            printedAssistantLabel = true;
                        }
                        process.stdout.write(event.text);
                        streamed = true;
                        continue;
                    }

                    if (event.type === "response") {
                        if (streamed) {
                            process.stdout.write("\n");
                        }

                        this.printToolActivity(event.response.toolCalls);
                        if (!streamed) {
                            console.log(`${this.assistantLabel()} ${event.response.content}`);
                        }
                        continue;
                    }

                    if (event.type === "progress") {
                        console.log(this.renderProgress(event.progress));
                        continue;
                    }

                    if (event.type === "error") {
                        if (streamed) {
                            process.stdout.write("\n");
                        }
                        console.log(`${this.error("jarvis error")} ${event.error}`);
                    }
                }
            } catch (error) {
                console.log(
                    `${this.error("jarvis error")} ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private printToolActivity(toolCalls: ToolCallRecord[]): void {
        if (toolCalls.length === 0) {
            return;
        }

        for (const [index, toolCall] of toolCalls.entries()) {
            const label = `[tool:${toolCall.name}]`;
            const status = toolCall.success ? "ok" : "failed";
            const base = `${label} ${status} (${index + 1}/${toolCalls.length}) -> ${formatToolInput(toolCall.input)}`;
            const preview = this.formatToolOutputPreview(toolCall.output);

            console.log(this.dim(base));
            if (preview) {
                console.log(this.dim(preview));
            }
        }
    }

    private printAutomationRun(run: AutomationRun, task: AutomationTask): void {
        if (!this.running) {
            return;
        }

        const label = task.type === "reminder" ? "reminder" : "automation";
        const status = run.status === "completed" ? "completed" : "failed";
        const output = run.output ?? run.error ?? "(no output)";
        console.log();
        console.log(this.info(`[${label}:${status}] ${task.title}`));
        console.log(output);
    }

    private formatToolOutputPreview(output: string): string {
        const lines = output
            .replace(/\r/g, "")
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);

        if (lines.length === 0) {
            return "  output: (empty)";
        }

        const previewLines = lines.slice(0, 4);
        const body = previewLines.map((line) => `    ${line}`).join("\n");
        const suffix =
            lines.length > previewLines.length ? `\n    ... (${lines.length - previewLines.length} more line(s))` : "";
        return `  output preview:\n${body}${suffix}`;
    }

    private assistantLabel(): string {
        return this.accent("jarvis>");
    }

    private renderProgress(progress: ProgressEvent): string {
        const phase = `[${progress.phase}]`;
        const toolPart = progress.toolName ? ` tool=${progress.toolName}` : "";
        const commandPart = progress.commandPreview ? ` cmd="${progress.commandPreview}"` : "";
        return this.dim(`* ${phase} ${progress.message}${toolPart}${commandPart}`);
    }

    private info(text: string): string {
        return this.wrapAnsi("36", text);
    }

    private error(text: string): string {
        return this.wrapAnsi("31", text);
    }

    private accent(text: string): string {
        return this.wrapAnsi("95", text);
    }

    private dim(text: string): string {
        return this.wrapAnsi("90", text);
    }

    private wrapAnsi(code: string, text: string): string {
        return `\u001b[${code}m${text}\u001b[0m`;
    }
}
