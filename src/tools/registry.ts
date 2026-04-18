import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { WebSearchTool } from "./web-search.js";

interface ToolRegistryDependencies {
    config: AppConfig;
    logger: Logger;
}

export class ToolRegistry {
    private readonly webSearch: WebSearchTool;

    public constructor(dependencies: ToolRegistryDependencies) {
        this.webSearch = new WebSearchTool(dependencies);
    }

    public async runPreModelTools(request: UserRequest): Promise<ToolCallRecord[]> {
        const results: ToolCallRecord[] = [];

        if (this.webSearch.shouldRun(request)) {
            results.push(await this.webSearch.execute(this.webSearch.getQuery(request.message)));
        }

        return results;
    }
}
