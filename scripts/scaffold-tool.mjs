import fs from "node:fs";
import path from "node:path";

function exitWithUsage() {
  // Keep output short so it's easy to read in terminals.
  console.error(
    [
      "Usage:",
      "  node scripts/scaffold-tool.mjs <tool-id> [--kind command|pre-model] [--command <cmd>]",
      "",
      "Examples:",
      "  node scripts/scaffold-tool.mjs weather --kind command --command weather",
      "  node scripts/scaffold-tool.mjs redact --kind pre-model",
    ].join("\n"),
  );
  process.exit(1);
}

function toWords(id) {
  return id
    .trim()
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9]/g, ""));
}

function toPascalCase(id) {
  return toWords(id)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function toCamelCase(id) {
  const pascal = toPascalCase(id);
  return pascal.slice(0, 1).toLowerCase() + pascal.slice(1);
}

function toUpperSnake(id) {
  return toWords(id)
    .map((part) => part.toUpperCase())
    .join("_");
}

function insertBeforeMarker(text, marker, insertion) {
  const idx = text.indexOf(marker);
  if (idx === -1) {
    throw new Error(`Could not find marker: ${marker}`);
  }

  return text.slice(0, idx) + insertion + text.slice(idx);
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function withEol(text, eol) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

function ensureAscii(text) {
  // Best-effort: scaffold files should be ASCII.
  for (const char of text) {
    if (char.charCodeAt(0) > 127) {
      throw new Error(`Refusing to write non-ASCII scaffold content (found: ${JSON.stringify(char)})`);
    }
  }
}

const args = process.argv.slice(2);
const toolId = args[0];
if (!toolId) {
  exitWithUsage();
}

if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(toolId)) {
  console.error("Error: <tool-id> must be letters/numbers/dashes (kebab-case recommended).");
  process.exit(1);
}

let kind = "command";
let commandName = toolId;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--kind") {
    kind = args[i + 1] ?? "";
    i++;
    continue;
  }
  if (arg === "--command") {
    commandName = args[i + 1] ?? "";
    i++;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    exitWithUsage();
  }
}

if (kind !== "command" && kind !== "pre-model") {
  console.error("Error: --kind must be 'command' or 'pre-model'.");
  process.exit(1);
}

if (!commandName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(commandName)) {
  console.error("Error: --command must be letters/numbers/dashes.");
  process.exit(1);
}

const className = `${toPascalCase(toolId)}Tool`;
const configKey = toCamelCase(toolId);
const envKey = `ENABLE_${toUpperSnake(toolId)}`;
const repoRoot = process.cwd();

const toolPath = path.join(repoRoot, "src", "tools", `${toolId}.ts`);
if (fs.existsSync(toolPath)) {
  console.error(`Error: Tool file already exists: ${toolPath}`);
  process.exit(1);
}

const toolTemplate = `import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { createId } from "../utils/id.js";

interface ${className}Dependencies {
    config: AppConfig;
    logger: Logger;
}

// Tool command: //${commandName} [args]
const COMMAND_RE = /^\\/\\/${commandName}(?:\\s+(.+))?$/i;

export class ${className} {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(dependencies: ${className}Dependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public describe(): { name: string; description: string; command: string; examples: string[] } {
        return {
            name: "${toolId}",
            description: "TODO: describe what this tool does.",
            command: "//${commandName}",
            examples: ["//${commandName}"],
        };
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.${configKey}.enabled) {
            return false;
        }

        if (!this.config.tools.${configKey}.perChannel[request.channel]) {
            return false;
        }

        return COMMAND_RE.test(request.message.trim());
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const createdAt = new Date();
        const input = message.trim();
        const match = input.match(COMMAND_RE);
        const args = match?.[1]?.trim() ?? "";

        try {
            // TODO: implement your tool here.
            // - Parse args
            // - Do work (HTTP call, DB query, etc.)
            // - Return a ToolCallRecord
            const output = args ? \`TODO: ${toolId} args=\${args}\` : "TODO: implement ${toolId}";

            return {
                id: createId("tool"),
                name: "${toolId}",
                input,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("${toolId} tool failed", { error: text });

            return {
                id: createId("tool"),
                name: "${toolId}",
                input,
                output: \`${toolId} failed: \${text}\`,
                success: false,
                createdAt,
            };
        }
    }
}
`;

ensureAscii(toolTemplate);
fs.mkdirSync(path.dirname(toolPath), { recursive: true });
fs.writeFileSync(toolPath, toolTemplate, "utf8");

// Wire-up: registry + config + env.example
const registryPath = path.join(repoRoot, "src", "tools", "registry.ts");
const configPath = path.join(repoRoot, "src", "config", "index.ts");
const envExamplePath = path.join(repoRoot, ".env.example");

const importLine = `import { ${className} } from "./${toolId}.js";\n`;
const fieldLine = `    private readonly ${configKey}: ${className};\n`;
const ctorLine = `        this.${configKey} = new ${className}(dependencies);\n`;
const commandToolLine = `            this.${configKey},\n`;
const preModelRunBlock = `        if (this.${configKey}.shouldRun(request)) {\n            results.push(await this.${configKey}.execute(request.message));\n        }\n\n`;

const toolsTypeBlock = `        ${configKey}: {\n            enabled: boolean;\n            perChannel: Record<ChannelKind, boolean>;\n        };\n`;
const envSchemaLine = `    ${envKey}: envBoolean.optional().default(false),\n`;
const toolsValueBlock = `            ${configKey}: {\n                enabled: parsed.${envKey},\n                perChannel: {\n                    terminal: true,\n                    http: true,\n                    telegram: true,\n                },\n            },\n`;

const envExampleBlock = `\n# Tool: ${toolId} (command: //${commandName})\n${envKey}=false\n`;

function patchFile(filePath, patchFn) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = patchFn(before);
  fs.writeFileSync(filePath, after, "utf8");
}

patchFile(registryPath, (text) => {
  const eol = detectEol(text);
  let next = text;
  if (!next.includes(importLine.trim())) {
    next = insertBeforeMarker(next, "// tool-scaffold:insert:import", withEol(importLine, eol));
  }
  if (!next.includes(fieldLine.trim())) {
    next = insertBeforeMarker(next, "    // tool-scaffold:insert:field", withEol(fieldLine, eol));
  }
  if (!next.includes(ctorLine.trim())) {
    next = insertBeforeMarker(next, "        // tool-scaffold:insert:ctor", withEol(ctorLine, eol));
  }

  if (kind === "command") {
    if (!next.includes(commandToolLine.trim())) {
      next = insertBeforeMarker(
        next,
        "            // tool-scaffold:insert:command-tool",
        withEol(commandToolLine, eol),
      );
    }
  } else {
    if (!next.includes(preModelRunBlock.trim())) {
      next = insertBeforeMarker(next, "        // tool-scaffold:insert:pre-model", withEol(preModelRunBlock, eol));
    }
  }

  return next;
});

patchFile(configPath, (text) => {
  const eol = detectEol(text);
  let next = text;
  if (!next.includes(toolsTypeBlock.trim())) {
    next = insertBeforeMarker(next, "        // tool-scaffold:insert:tools-type", withEol(toolsTypeBlock, eol));
  }
  if (!next.includes(envSchemaLine.trim())) {
    next = insertBeforeMarker(next, "    // tool-scaffold:insert:env", withEol(envSchemaLine, eol));
  }
  if (!next.includes(toolsValueBlock.trim())) {
    next = insertBeforeMarker(next, "            // tool-scaffold:insert:tools-value", withEol(toolsValueBlock, eol));
  }
  return next;
});

patchFile(envExamplePath, (text) => {
  if (text.includes(`${envKey}=`)) {
    return text;
  }

  const eol = detectEol(text);
  return insertBeforeMarker(text, "# tool-scaffold:insert:env", withEol(envExampleBlock, eol));
});

console.log(`Scaffolded tool '${toolId}'.`);
console.log(`- Tool file: src/tools/${toolId}.ts`);
console.log(`- Env flag: ${envKey}`);
console.log(`- Config key: tools.${configKey}`);
console.log("");
console.log("Next:");
console.log("1) Implement the tool logic in the generated file.");
console.log("2) Run: npm test");
