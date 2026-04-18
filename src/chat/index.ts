interface ChatMessage {
    uuid: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    source: 'terminal' | 'web' | 'telegram';
    createdAt: Date;
}

class ChatRouter {
    private chatHistory: ChatMessage[] = [];

    constructor() {
        this.chatHistory = [];
    }

    public addMessage(message: ChatMessage) {
        this.chatHistory.push(message);
    }

    public getChatHistory() {
        return this.chatHistory;
    }

    public getChatHistoryByUuid(uuid: string) {
        return this.chatHistory.filter((message) => message.uuid === uuid);
    }
}

export default ChatRouter;