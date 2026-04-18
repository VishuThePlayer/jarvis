import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { SystemComTool } from "./system_com.js";
import { WebSearchTool } from "./web-search.js";

interface ToolRegistryDependencies {
    config: AppConfig;
    logger: Logger;
}

interface CommandTool {
    shouldRun(request: UserRequest): boolean;
    execute(message: string): Promise<ToolCallRecord>;
}

export class ToolRegistry {
    private readonly webSearch: WebSearchTool;
    private readonly systemCom: SystemComTool;
    private readonly commandTools: CommandTool[];

    public constructor(dependencies: ToolRegistryDependencies) {
        this.webSearch = new WebSearchTool(dependencies);
        this.systemCom = new SystemComTool(dependencies);

        this.commandTools = [
            this.systemCom,
            // tool-scaffold:insert:command-tool
        ];
    }

    public async tryRunCommand(request: UserRequest): Promise<ToolCallRecord | null> {
        for (const tool of this.commandTools) {
            if (!tool.shouldRun(request)) {
                continue;
            }

            return tool.execute(request.message);
        }

        return null;
    }

    public async runPreModelTools(request: UserRequest): Promise<ToolCallRecord[]> {
        const results: ToolCallRecord[] = [];

        if (this.webSearch.shouldRun(request)) {
            results.push(await this.webSearch.execute(this.webSearch.getQuery(request.message)));
        }

        return results;
    }
}
