import type { ToolCallRecord } from "../types/core.js";
import { createId } from "./id.js";

export function createToolRecord(name: string, input: string, success: boolean, output: string): ToolCallRecord {
    return { id: createId("tool"), name, input, output, success, createdAt: new Date() };
}
