import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { createId } from "../utils/id.js";
import { truncate } from "../utils/text.js";

interface WebSearchToolDependencies {
    config: AppConfig;
    logger: Logger;
}

interface DuckDuckGoTopic {
    FirstURL?: string;
    Text?: string;
    Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: DuckDuckGoTopic[];
}

function flattenTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
    const flattened: DuckDuckGoTopic[] = [];

    for (const topic of topics) {
        if (topic.Topics) {
            flattened.push(...flattenTopics(topic.Topics));
            continue;
        }

        flattened.push(topic);
    }

    return flattened;
}

export class WebSearchTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(dependencies: WebSearchToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.webSearch.enabled) {
            return false;
        }

        if (!this.config.tools.webSearch.perChannel[request.channel]) {
            return false;
        }

        if (request.metadata.allowWebSearch === false) {
            return false;
        }

        if (request.metadata.allowWebSearch === true || request.metadata.preferWebSearch === true) {
            return true;
        }

        if (!this.config.tools.webSearch.allowByDefault) {
            return false;
        }

        return /\b(latest|today|current|news|search|look up|lookup|web)\b/i.test(request.message);
    }

    public getQuery(message: string): string {
        return message.replace(/^\/search\s+/i, "").trim() || message.trim();
    }

    public async execute(query: string): Promise<ToolCallRecord> {
        const createdAt = new Date();

        try {
            const url = new URL("https://api.duckduckgo.com/");
            url.searchParams.set("q", query);
            url.searchParams.set("format", "json");
            url.searchParams.set("no_html", "1");
            url.searchParams.set("skip_disambig", "1");

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`DuckDuckGo returned ${response.status}`);
            }

            const data = (await response.json()) as DuckDuckGoResponse;
            const bullets: string[] = [];

            if (data.AbstractText) {
                const source = data.AbstractURL ? ` (${data.AbstractURL})` : "";
                bullets.push(`${truncate(data.AbstractText, 220)}${source}`);
            }

            const relatedTopics = flattenTopics(data.RelatedTopics ?? [])
                .filter((topic) => topic.Text)
                .slice(0, this.config.tools.webSearch.maxResults)
                .map((topic) => `${truncate(topic.Text ?? "", 220)}${topic.FirstURL ? ` (${topic.FirstURL})` : ""}`);
            bullets.push(...relatedTopics);

            const output =
                bullets.length > 0
                    ? `Web search results for "${query}":\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}`
                    : `No useful web search results were found for "${query}".`;

            return {
                id: createId("tool"),
                name: "web-search",
                input: query,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn("Web search failed", { query, error: message });

            return {
                id: createId("tool"),
                name: "web-search",
                input: query,
                output: `Web search failed for "${query}": ${message}`,
                success: false,
                createdAt,
            };
        }
    }
}
