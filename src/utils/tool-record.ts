import type { ToolCallInput, ToolCallRecord } from "../types/core.js";
import { createId } from "./id.js";

export function createToolRecord(name: string, input: ToolCallInput, success: boolean, output: string): ToolCallRecord {
    return { id: createId("tool"), name, input, output, success, createdAt: new Date() };
}
