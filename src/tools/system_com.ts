import type { Logger } from "../observability/logger.js";
import type { AppConfig } from "../config/index.js";
import { createId } from "../utils/id.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";

interface SystemComToolDependencies {
    config: AppConfig;
    logger: Logger;
}

/** Slash commands: `/time`, `/sys time`, `/sys get-time` (trimmed). */
const SYSTEM_COMMAND_RE = /^\/(?:sys\s+)?(get-time|time)$/i;

export class SystemComTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(dependencies: SystemComToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.systemCom.enabled) {
            return false;
        }

        if (!this.config.tools.systemCom.perChannel[request.channel]) {
            return false;
        }

        return SYSTEM_COMMAND_RE.test(request.message.trim());
    }

    public parseCommand(message: string): "get-time" | null {
        const match = message.trim().match(SYSTEM_COMMAND_RE);
        const cmd = match?.[1]?.toLowerCase();
        if (cmd === "time" || cmd === "get-time") {
            return "get-time";
        }

        return null;
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const createdAt = new Date();
        const input = message.trim();
        const command = this.parseCommand(message);

        if (!command) {
            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output: "No recognized system command.",
                success: false,
                createdAt,
            };
        }

        try {
            const output = `Current time (server local): ${this.formatLocalTime()}`;
            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("System command failed", { command, error: text });

            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output: `System command failed: ${text}`,
                success: false,
                createdAt,
            };
        }
    }

    private formatLocalTime(): string {
        return new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
}
