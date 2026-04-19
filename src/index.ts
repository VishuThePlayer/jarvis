import "dotenv/config";
import { runSetupIfNeeded, applyConfigFileToEnv } from "./setup/index.js";

await runSetupIfNeeded();
applyConfigFileToEnv();

const { createApplication } = await import("./app/create-application.js");
const application = await createApplication();

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

process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error(JSON.stringify({ level: "error", msg: "Unhandled promise rejection", error: message }));
});

process.on("uncaughtException", (error) => {
    console.error(JSON.stringify({ level: "error", msg: "Uncaught exception — shutting down", error: error.stack ?? error.message }));
    void application.stop().finally(() => process.exit(1));
});

await application.start();
