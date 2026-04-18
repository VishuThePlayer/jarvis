import { createInterface, type Interface } from "node:readline/promises";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { Orchestrator } from "../../orchestrator/index.js";
import type { ChannelAdapter } from "../types.js";
import { createId } from "../../utils/id.js";

interface TerminalChannelDependencies {
    config: AppConfig;
    logger: Logger;
    orchestrator: Orchestrator;
}

export class TerminalChannelAdapter implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private readline: Interface | undefined;
    private running = false;
    private conversationId = createId("conv");
    private selectedModel: string | undefined;

    public constructor(dependencies: TerminalChannelDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.orchestrator = dependencies.orchestrator;
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

        console.log("Jarvis terminal ready. Use /new, /models, /model <provider:model>, /search <query>, or /exit.");
        void this.loop();
    }

    public async stop(): Promise<void> {
        this.running = false;
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
                console.log("Started a new conversation.");
                continue;
            }

            if (input === "/models") {
                const models = this.orchestrator.listModels();
                console.log(models.map((model) => `- ${model.provider}:${model.id} [${model.roles.join(", ")}]`).join("\n"));
                continue;
            }

            if (input.startsWith("/model ")) {
                this.selectedModel = input.slice(7).trim() || undefined;
                console.log(this.selectedModel ? `Selected model ${this.selectedModel}` : "Cleared selected model.");
                continue;
            }

            const allowWebSearch = input.startsWith("/search ");
            const message = allowWebSearch ? input.slice(8).trim() : input;

            try {
                const response = await this.orchestrator.handleRequest({
                    requestId: createId("req"),
                    channel: "terminal",
                    userId: this.config.app.defaultUserId,
                    conversationId: this.conversationId,
                    message,
                    attachments: [],
                    ...(this.selectedModel ? { requestedModel: this.selectedModel } : {}),
                    metadata: allowWebSearch ? { allowWebSearch: true } : {},
                });

                console.log(`jarvis> ${response.content}`);
            } catch (error) {
                console.log(`jarvis> Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
