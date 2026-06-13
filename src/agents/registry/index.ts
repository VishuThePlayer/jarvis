import type { AssistantAgent } from "../jarvis/index.js";
import type { ToolResultFormatter } from "../tool-result-formatter/index.js";

export class AgentRegistry {
    private readonly assistantAgent: AssistantAgent;
    private readonly formatterAgent: ToolResultFormatter;

    public constructor(assistantAgent: AssistantAgent, formatterAgent: ToolResultFormatter) {
        this.assistantAgent = assistantAgent;
        this.formatterAgent = formatterAgent;
    }

    public getAssistant(): AssistantAgent {
        return this.assistantAgent;
    }

    public getFormatter(): ToolResultFormatter {
        return this.formatterAgent;
    }
}
