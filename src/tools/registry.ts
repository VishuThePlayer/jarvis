import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import type { CommandTool, CommandToolDescriptor } from "./contracts.js";
import { SystemComTool } from "./system_com.js";
import { WebSearchTool } from "./web-search.js";
// tool-scaffold:insert:import

interface ToolRegistryDependencies {
    config: AppConfig;
    logger: Logger;
}

export class ToolRegistry {
    private readonly webSearch: WebSearchTool;
    private readonly systemCom: SystemComTool;
    // tool-scaffold:insert:field
    private readonly commandTools: CommandTool[];

    public constructor(dependencies: ToolRegistryDependencies) {
        this.webSearch = new WebSearchTool(dependencies);
        this.systemCom = new SystemComTool(dependencies);
        // tool-scaffold:insert:ctor

        this.commandTools = [
            this.systemCom,
            // tool-scaffold:insert:command-tool
        ];
    }

    public listAvailableCommandTools(channel: ChannelKind): CommandToolDescriptor[] {
        const request: UserRequest = {
            requestId: "tool-router",
            channel,
            userId: "tool-router",
            message: "",
            attachments: [],
            metadata: {},
        };

        const descriptors: CommandToolDescriptor[] = [];

        for (const tool of this.commandTools) {
            const descriptor = tool.describe();
            if (!tool.shouldRun({ ...request, message: descriptor.command })) {
                continue;
            }

            descriptors.push(descriptor);
        }

        return descriptors;
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

        // tool-scaffold:insert:pre-model

        return results;
    }
}
