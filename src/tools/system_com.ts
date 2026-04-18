import type { Logger } from "../observability/logger.js";
import type { AppConfig } from "../config/index.js";
import { createId } from "../utils/id.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import type { CommandToolDescriptor } from "./contracts.js";

interface SystemComToolDependencies {
    config: AppConfig;
    logger: Logger;
}

/**
 * Commands (trimmed):
 * - `/time`, `/sys time`, `/sys get-time`
 * - `//time`, `//sys time`, `//sys get-time`
 * Telegram may append `@botname` in groups (e.g. `/time@my_bot`).
 */
const SYSTEM_COMMAND_RE = /^(?:\/\/|\/)(?:sys\s+)?(get-time|time)(?:@\w+)?$/i;

export class SystemComTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(dependencies: SystemComToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "system-com",
            description: "Return server local time and UTC time.",
            command: "//time",
            examples: ["//time", "/time", "/sys time", "/sys get-time"],
        };
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
            const now = new Date();
            const output = `Time\n- local: ${this.formatLocalDateTime(now)} (UTC${this.formatUtcOffset(now)})\n- utc: ${now.toISOString()}`;
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

    private formatLocalDateTime(date: Date): string {
        return date.toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    }

    private formatUtcOffset(date: Date): string {
        // getTimezoneOffset() returns minutes behind UTC (e.g. PST -> 480)
        const totalMinutes = -date.getTimezoneOffset();
        const sign = totalMinutes >= 0 ? "+" : "-";
        const absMinutes = Math.abs(totalMinutes);
        const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
        const minutes = String(absMinutes % 60).padStart(2, "0");
        return `${sign}${hours}:${minutes}`;
    }
}
