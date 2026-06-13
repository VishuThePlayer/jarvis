import type { AutomationService } from "../automation/service.js";
import type { AppConfig } from "../config/index.js";
import type { MemoryService } from "../memory/service.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import { AutomationTool } from "./automation.js";
import type { CommandTool, CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";
import { MemoryLookupTool } from "./memory-lookup.js";
import { MemorySavingTool } from "./memory-saving.js";
import { createPowerShellTools } from "./powershell.js";
import { TimeTool } from "./time.js";
import { WebSearchTool } from "./web-search.js";
// tool-scaffold:insert:import

interface ToolRegistryDependencies {
    config: AppConfig;
    logger: Logger;
    memory: MemoryService;
    automation: AutomationService;
}

export interface SelectedCommandTool {
    toolName: string;
    invocation: CommandToolInvocation;
}

export class ToolRegistry {
    private readonly webSearch: WebSearchTool;
    private readonly time: TimeTool;
    private readonly memorySaving: MemorySavingTool;
    private readonly memoryLookup: MemoryLookupTool;
    private readonly automation: AutomationTool;
    private readonly powershellTools: CommandTool[];
    // tool-scaffold:insert:field
    private readonly commandTools: CommandTool[];

    public constructor(dependencies: ToolRegistryDependencies) {
        this.webSearch = new WebSearchTool(dependencies);
        this.time = new TimeTool(dependencies);
        this.memorySaving = new MemorySavingTool(dependencies);
        this.memoryLookup = new MemoryLookupTool(dependencies);
        this.automation = new AutomationTool(dependencies);
        this.powershellTools = createPowerShellTools(dependencies);
        // tool-scaffold:insert:ctor

        this.commandTools = [
            this.time,
            this.memorySaving,
            this.memoryLookup,
            this.automation,
            ...this.powershellTools,
            // tool-scaffold:insert:command-tool
        ];
    }

    public listAvailableCommandTools(channel: ChannelKind): CommandToolDescriptor[] {
        return this.commandTools
            .filter((tool) => tool.isEnabled(channel))
            .map((tool) => tool.describe());
    }

    public matchDirectCommand(request: UserRequest): SelectedCommandTool | null {
        for (const tool of this.commandTools) {
            const invocation = tool.matchDirectInvocation(request);
            if (!invocation) {
                continue;
            }

            return {
                toolName: tool.describe().name,
                invocation,
            };
        }

        return null;
    }

    public async executeSelectedCommandTool(selection: SelectedCommandTool): Promise<ToolCallRecord | null> {
        const tool = this.commandTools.find((candidate) => candidate.describe().name === selection.toolName);
        if (!tool || !tool.isEnabled(selection.invocation.request.channel)) {
            return null;
        }

        return tool.execute(selection.invocation);
    }

    public async executePreModelTools(request: UserRequest): Promise<ToolCallRecord[]> {
        const results: ToolCallRecord[] = [];

        if (this.webSearch.shouldRun(request)) {
            results.push(await this.webSearch.execute(this.webSearch.getQuery(request.message)));
        }

        // tool-scaffold:insert:pre-model

        return results;
    }
}
