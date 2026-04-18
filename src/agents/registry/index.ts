import type { AssistantAgent } from "../jarvis/index.js";

export class AgentRegistry {
    private readonly primaryAgent: AssistantAgent;

    public constructor(primaryAgent: AssistantAgent) {
        this.primaryAgent = primaryAgent;
    }

    public getPrimary(): AssistantAgent {
        return this.primaryAgent;
    }
}
