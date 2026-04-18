import "dotenv/config";
import { createApplication } from "./app/create-application.js";

const application = createApplication();

const shutdown = async (signal: string) => {
    await application.stop();
    process.exit(signal === "SIGTERM" ? 0 : 130);
};

process.once("SIGINT", () => {
    void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
});

await application.start();
