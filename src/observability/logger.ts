import type { LogLevel } from "../config/index.js";

const priorities: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export class Logger {
    private readonly minimumPriority: number;

    public constructor(level: LogLevel) {
        this.minimumPriority = priorities[level];
    }

    public debug(message: string, context: Record<string, unknown> = {}) {
        this.emit("debug", message, context);
    }

    public info(message: string, context: Record<string, unknown> = {}) {
        this.emit("info", message, context);
    }

    public warn(message: string, context: Record<string, unknown> = {}) {
        this.emit("warn", message, context);
    }

    public error(message: string, context: Record<string, unknown> = {}) {
        this.emit("error", message, context);
    }

    private emit(level: LogLevel, message: string, context: Record<string, unknown>) {
        if (priorities[level] < this.minimumPriority) {
            return;
        }

        console.log(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                level,
                message,
                ...context,
            }),
        );
    }
}
