import type { ToolCallInput, ToolCallSource } from "../types/core.js";

export function createToolInput(
    source: ToolCallSource,
    rawMessage: string,
    args: Record<string, unknown>,
): ToolCallInput {
    return {
        source,
        rawMessage,
        arguments: sanitizeToolArguments(args),
    };
}

export function formatToolInput(input: ToolCallInput): string {
    const args = Object.entries(input.arguments)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${formatToolValue(value)}`);

    if (args.length === 0) {
        return input.source;
    }

    return `${input.source} ${args.join(" ")}`;
}

function formatToolValue(value: unknown): string {
    if (typeof value === "string") {
        return value.includes(" ") ? JSON.stringify(value) : value;
    }

    return JSON.stringify(value);
}

function sanitizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
    const pairs = Object.entries(args).filter(([, value]) => value !== undefined);
    return Object.fromEntries(pairs);
}
