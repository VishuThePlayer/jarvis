import type { ToolCallRecord, UserRequest } from "../types/core.js";

export interface CommandToolDescriptor {
    name: string;
    description: string;
    command: string;
    argsHint?: string;
    examples: string[];
    autoRoute: boolean;
}

export interface CommandTool {
    describe(): CommandToolDescriptor;
    shouldRun(request: UserRequest): boolean;
    execute(message: string): Promise<ToolCallRecord>;
}
