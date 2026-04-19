import { configFileExists, loadConfigFile, saveConfigFile, configFileToEnvOverrides, getConfigFilePath } from "../config/config-file.js";
import { runSetupWizard } from "./wizard.js";

export async function runSetupIfNeeded(): Promise<void> {
    const forceSetup = process.argv.includes("--setup");
    const hasConfig = configFileExists();

    if (hasConfig && !forceSetup) {
        return;
    }

    if (!process.stdin.isTTY) {
        if (!hasConfig) {
            console.error("No jarvis.config.json found and no interactive terminal available.");
            console.error("Run Jarvis in an interactive terminal for first-time setup, or create jarvis.config.json manually.");
            process.exit(1);
        }
        return;
    }

    if (forceSetup && hasConfig) {
        console.log("\n  Re-running setup (existing config will be overwritten).\n");
    }

    const config = await runSetupWizard();
    saveConfigFile(config);

    const configPath = getConfigFilePath();
    console.log(`  Config saved to ${configPath}`);
    console.log(`  You can re-run setup anytime with: npm run setup`);
    console.log(`  Or edit jarvis.config.json directly.\n`);
}

export function applyConfigFileToEnv(): void {
    const config = loadConfigFile();
    if (!config) return;

    const overrides = configFileToEnvOverrides(config);

    for (const [key, value] of Object.entries(overrides)) {
        if (process.env[key] == null || process.env[key] === "") {
            process.env[key] = value;
        }
    }
}
