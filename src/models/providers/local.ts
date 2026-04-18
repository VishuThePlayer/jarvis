import { splitBulletLines, tokenize } from "../../utils/text.js";
import type { ModelCapability, ModelInvocation, ModelResult } from "../../types/core.js";
import type { ModelProvider } from "../contracts.js";

function extractSectionBullets(source: string, heading: string): string[] {
    const marker = `${heading}\n`;
    const startIndex = source.indexOf(marker);
    if (startIndex < 0) {
        return [];
    }

    const remainder = source.slice(startIndex + marker.length);
    const section = remainder.split("\n\n", 1)[0] ?? remainder;

    return splitBulletLines(section);
}

function buildSimpleEmbedding(text: string): number[] {
    const vector = new Array<number>(8).fill(0);
    const tokens = tokenize(text);

    for (const token of tokens) {
        let hash = 0;
        for (const character of token) {
            hash = (hash * 31 + character.charCodeAt(0)) % 104729;
        }

        const index = hash % vector.length;
        vector[index] = (vector[index] ?? 0) + 1;
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) || 1;
    return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export class LocalModelProvider implements ModelProvider {
    public readonly kind = "local" as const;

    public isConfigured(): boolean {
        return true;
    }

    public supports(capability: ModelCapability): boolean {
        return capability !== "streaming";
    }

    public async generate(invocation: ModelInvocation): Promise<ModelResult> {
        const systemContext = invocation.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n\n");
        const lastUserMessage =
            [...invocation.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const memoryBullets = extractSectionBullets(systemContext, "Known long-term memories:");
        const toolBullets = extractSectionBullets(systemContext, "Tool results from this turn:");

        let text: string;
        if (/what do you remember|how should you answer me|what should you remember/i.test(lastUserMessage)) {
            text = memoryBullets.length
                ? `Here is what I know so far:\n${memoryBullets.map((item) => `- ${item}`).join("\n")}`
                : "I do not have any durable memory stored for you yet.";
        } else {
            const lines = ["Local Jarvis is active without an external LLM provider."];

            if (memoryBullets.length > 0) {
                lines.push(`Relevant memory: ${memoryBullets[0]}`);
            }

            if (toolBullets.length > 0) {
                lines.push(`Fresh context: ${toolBullets[0]}`);
            }

            lines.push(`You said: ${lastUserMessage}`);
            text = lines.join("\n");
        }

        return {
            provider: this.kind,
            model: invocation.model,
            text,
            usage: {
                inputTokens: tokenize(invocation.messages.map((message) => message.content).join(" ")).length,
                outputTokens: tokenize(text).length,
                totalTokens:
                    tokenize(invocation.messages.map((message) => message.content).join(" ")).length +
                    tokenize(text).length,
            },
        };
    }

    public async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => buildSimpleEmbedding(text));
    }
}
