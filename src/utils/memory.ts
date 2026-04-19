import type { MemoryEntry } from "../types/core.js";

export function memoryKindBoost(kind: MemoryEntry["kind"]): number {
    switch (kind) {
        case "preference":
            return 0.4;
        case "fact":
            return 0.25;
        case "episode":
            return 0.1;
        case "summary":
            return 0.05;
    }
}
