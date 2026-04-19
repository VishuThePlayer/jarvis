import { createInterface, type Interface } from "node:readline/promises";
import type { JarvisConfigFile } from "../config/config-file.js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export async function runSetupWizard(): Promise<JarvisConfigFile> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        printBanner();
        const providers = await stepProviders(rl);
        const models = await stepModels(rl);
        const channels = await stepChannels(rl);
        const features = await stepFeatures(rl);

        const config: JarvisConfigFile = {
            providers: {
                openai: providers.openai,
            },
            models,
            agents: { jarvis: {} },
            channels,
            tools: features.tools,
            memory: features.memory,
            orchestrator: { temperature: 0.3, historyLimit: 50 },
        };

        console.log();
        console.log(`${GREEN}${BOLD}  Setup complete!${RESET}`);
        console.log();

        return config;
    } finally {
        rl.close();
    }
}

function printBanner(): void {
    console.log();
    console.log(`${CYAN}${BOLD}  ╔══════════════════════════════════════╗${RESET}`);
    console.log(`${CYAN}${BOLD}  ║       Jarvis — First Time Setup      ║${RESET}`);
    console.log(`${CYAN}${BOLD}  ╚══════════════════════════════════════╝${RESET}`);
    console.log();
}

function stepHeader(step: number, total: number, title: string): void {
    console.log(`${CYAN}  Step ${step}/${total} — ${title}${RESET}`);
    console.log();
}

async function prompt(rl: Interface, question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue != null ? ` ${DIM}[${defaultValue}]${RESET}` : "";
    const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
}

async function promptYesNo(rl: Interface, question: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = (await rl.question(`  ${question} (${hint}): `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
}

interface ProviderSetup {
    openai: { apiKey: string; baseUrl: string };
}

async function stepProviders(rl: Interface): Promise<ProviderSetup> {
    stepHeader(1, 4, "Provider");

    const result: ProviderSetup = {
        openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" },
    };

    result.openai.apiKey = await prompt(rl, "OpenAI API Key");
    const customBase = await promptYesNo(rl, "Custom base URL? (for OpenAI-compatible APIs)", false);
    if (customBase) {
        result.openai.baseUrl = await prompt(rl, "Base URL", "https://api.openai.com/v1");
    }

    console.log();
    return result;
}

interface ModelSetup {
    default: string;
    fast: string;
    reasoning: string;
    embedding: string;
}

const MODEL_DEFAULTS: ModelSetup = {
    default: "gpt-4o",
    fast: "gpt-4o-mini",
    reasoning: "o1",
    embedding: "text-embedding-3-small",
};

async function stepModels(rl: Interface): Promise<ModelSetup> {
    stepHeader(2, 4, "Models");

    console.log(`  ${DIM}Configure which models to use for each task.${RESET}`);
    console.log(`  ${DIM}Press Enter to accept the default.${RESET}`);
    console.log();

    const result: ModelSetup = {
        default: await prompt(rl, "Default model", MODEL_DEFAULTS.default),
        fast: await prompt(rl, "Fast model (quick tasks)", MODEL_DEFAULTS.fast),
        reasoning: await prompt(rl, "Reasoning model (complex tasks)", MODEL_DEFAULTS.reasoning),
        embedding: await prompt(rl, "Embedding model", MODEL_DEFAULTS.embedding),
    };

    console.log();
    return result;
}

interface ChannelSetup {
    terminal: boolean;
    http: boolean;
    telegram: {
        enabled: boolean;
        botToken: string;
        pollIntervalMs?: number;
        longPollTimeoutSec?: number;
    };
}

async function stepChannels(rl: Interface): Promise<ChannelSetup> {
    stepHeader(3, 4, "Channels");

    const result: ChannelSetup = {
        terminal: true,
        http: true,
        telegram: { enabled: false, botToken: "" },
    };

    result.http = await promptYesNo(rl, "Enable HTTP API? (needed for the web UI)", true);
    result.terminal = await promptYesNo(rl, "Enable terminal chat?", true);

    const enableTelegram = await promptYesNo(rl, "Enable Telegram bot?", false);
    if (enableTelegram) {
        const token = await prompt(rl, "Telegram Bot Token (from @BotFather)");
        result.telegram = { enabled: true, botToken: token };
    }

    console.log();
    return result;
}

interface FeatureSetup {
    tools: {
        webSearch: { enabled: boolean; allowByDefault?: boolean; maxResults?: number };
        systemCom: boolean;
        toolRouter: boolean;
    };
    memory: {
        enabled: boolean;
        autoStore: boolean;
        retrievalLimit: number;
        summaryTriggerMessages: number;
    };
}

async function stepFeatures(rl: Interface): Promise<FeatureSetup> {
    stepHeader(4, 4, "Features");

    const webSearch = await promptYesNo(rl, "Enable web search?", true);
    const memory = await promptYesNo(rl, "Enable memory (remembers facts & preferences)?", true);
    const toolRouter = await promptYesNo(rl, "Enable tool router (natural language -> commands)?", true);

    console.log();
    return {
        tools: {
            webSearch: { enabled: webSearch, allowByDefault: true, maxResults: 5 },
            systemCom: true,
            toolRouter,
        },
        memory: {
            enabled: memory,
            autoStore: memory,
            retrievalLimit: 5,
            summaryTriggerMessages: 8,
        },
    };
}
