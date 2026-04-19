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

await application.start();
