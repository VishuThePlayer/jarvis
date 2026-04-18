import ChatRouter from "./chat/index.js";

const chatRouter = new ChatRouter();

chatRouter.addMessage({
    uuid: "123",
    role: "user",
    content: "Hello, how are you?",
    source: "terminal",
    createdAt: new Date(),
});

console.log(chatRouter.getChatHistory());
