import "dotenv/config";
import { runSetupIfNeeded, applyConfigFileToEnv } from "./setup/index.js";

await runSetupIfNeeded();
applyConfigFileToEnv();

const { createRuntime } = await import("./app/create-runtime.js");
const runtime = await createRuntime();

const shutdown = async (signal: string) => {
    await runtime.stop();
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
    console.error(JSON.stringify({ level: "error", msg: "Uncaught exception - shutting down", error: error.stack ?? error.message }));
    void runtime.stop().finally(() => process.exit(1));
});

await runtime.start();
