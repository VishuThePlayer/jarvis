import type { ChannelKind, ToolCallSource, ToolCallRecord, UserRequest } from "../types/core.js";

export interface CommandToolDescriptor {
    name: string;
    description: string;
    command: string;
    argsHint?: string;
    metadata?: Record<string, unknown>;
    examples: string[];
    autoRoute: boolean;
    parameters?: Record<string, unknown>;
}

export interface CommandToolInvocation {
    request: UserRequest;
    source: ToolCallSource;
    arguments: Record<string, unknown>;
}

export interface CommandTool {
    describe(): CommandToolDescriptor;
    isEnabled(channel: ChannelKind): boolean;
    matchDirectInvocation(request: UserRequest): CommandToolInvocation | null;
    execute(invocation: CommandToolInvocation): Promise<ToolCallRecord>;
}
