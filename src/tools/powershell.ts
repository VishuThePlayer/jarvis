import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import { getDirectCommandArgText } from "../utils/direct-command.js";
import { errorMessage } from "../utils/error.js";
import { createToolInput } from "../utils/tool-input.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandTool, CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";

const execFileAsync = promisify(execFile);

interface PowerShellToolDependencies {
    config: AppConfig;
    logger: Logger;
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_.:-]+$/;
const SAFE_HOST_RE = /^[a-zA-Z0-9.-]+$/;
const SAFE_APP_TARGET_RE = /^[a-zA-Z0-9_.:\\\-\/ ()]+$/;
const BLOCKED_PATH_PREFIXES = ["c:\\windows", "c:\\program files"];
const SAFE_FOLDER_SEARCH_TERM_RE = /^[a-zA-Z0-9][a-zA-Z0-9\s._-]{0,119}$/;

abstract class BasePowerShellTool implements CommandTool {
    protected readonly config: AppConfig;
    protected readonly logger: Logger;
    private static activeExecutions = 0;
    private static readonly MAX_CONCURRENT_EXECUTIONS = 3;

    public constructor(dependencies: PowerShellToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public isEnabled(channel: ChannelKind): boolean {
        return this.config.tools.powershell.enabled && this.config.tools.powershell.perChannel[channel];
    }

    public abstract describe(): CommandToolDescriptor;

    public matchDirectInvocation(request: UserRequest): CommandToolInvocation | null {
        if (!this.isEnabled(request.channel)) {
            return null;
        }

        const argText = getDirectCommandArgText(request.message, this.describe().command);
        if (argText == null) {
            return null;
        }

        const tokens = this.parseArgs(
            argText.length > 0 ? `${this.describe().command} ${argText}` : this.describe().command,
        );
        return {
            request,
            source: "direct-command",
            arguments: this.argumentsFromTokens(tokens),
        };
    }

    public async execute(invocation: CommandToolInvocation): Promise<ToolCallRecord> {
        const input = createToolInput(invocation.source, invocation.request.message, invocation.arguments);
        const commandLine = this.buildCommandLine(invocation.arguments);
        const tokens = this.parseArgs(commandLine);
        const startedAt = Date.now();

        try {
            const output = await this.run(tokens);
            const truncated = this.truncateOutput(output, this.outputLimitFor(tokens));
            this.logger.info("PowerShell command tool succeeded", {
                tool: this.describe().name,
                durationMs: Date.now() - startedAt,
            });
            return createToolRecord(this.describe().name, input, true, truncated);
        } catch (error) {
            const text = errorMessage(error);
            const friendly = this.toFriendlyError(text);
            this.logger.warn("PowerShell command tool failed", { tool: this.describe().name, error: text });
            return createToolRecord(this.describe().name, input, false, friendly);
        }
    }

    protected abstract argumentsFromTokens(tokens: string[]): Record<string, unknown>;
    protected abstract buildCommandLine(args: Record<string, unknown>): string;
    protected abstract run(tokens: string[]): Promise<string>;

    protected joinCommandLine(parts: Array<string | undefined>): string {
        return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
    }

    protected asOptionalString(value: unknown): string | undefined {
        return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    }

    protected assertSafePath(target?: string): void {
        if (!target) return;
        const normalized = target.replace(/\//g, "\\").toLowerCase();
        if (BLOCKED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
            throw new Error(`Blocked path: ${target}`);
        }
    }

    protected assertSafeName(value: string, fieldName: string): void {
        if (!value || !SAFE_NAME_RE.test(value)) {
            throw new Error(`Invalid ${fieldName}. Only alphanumeric and . _ : - are allowed.`);
        }
    }

    protected assertSafeHost(value: string): void {
        if (!value || !SAFE_HOST_RE.test(value)) {
            throw new Error("Invalid host target.");
        }
    }

    protected assertSafeFolderSearchTerm(value: string, fieldName: string): void {
        const trimmed = value.trim();
        if (!trimmed || !SAFE_FOLDER_SEARCH_TERM_RE.test(trimmed)) {
            throw new Error(`Invalid ${fieldName}. Use letters, numbers, spaces, dot, dash, underscore only (max 120 chars).`);
        }
        const lower = trimmed.toLowerCase();
        if (lower.includes("..") || lower.includes("\\") || lower.includes("/") || lower.includes(":")) {
            throw new Error(`Invalid ${fieldName}. Do not include path separators; use ps-folder open for a full path.`);
        }
    }

    protected isLikelyWindowsPathToken(token: string): boolean {
        const t = token.trim();
        if (!t) return false;
        if (/^[a-z]:\\/i.test(t)) return true;
        if (t.startsWith("\\\\")) return true;
        if (t === "." || t === "..") return true;
        if (t.includes("\\")) return true;
        return false;
    }

    protected normalizeWindowsFolderPath(input: string): string {
        let p = input.trim().replace(/\//g, "\\");
        p = p.replace(/\s{2,}/g, " ");
        const matches = [...p.matchAll(/[a-z]:\\/gi)];
        if (matches.length >= 2) {
            const last = matches[matches.length - 1]!;
            p = p.slice(last.index!);
        }
        return p.trim();
    }

    protected parseArgs(input: string): string[] {
        const regex = /[^\s"]+|"([^"]*)"/g;
        const args: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(input)) !== null) {
            args.push(match[1] ?? match[0]);
        }
        return args;
    }

    protected async runPS(command: string): Promise<string> {
        return this.runPSWithTimeout(command, 20_000);
    }

    protected async runPSWithTimeout(command: string, timeoutMs: number): Promise<string> {
        return this.withExecutionLimit(async () => {
            try {
                const { stdout, stderr } = await execFileAsync(
                    "powershell",
                    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
                    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                );
                return (stdout ?? stderr ?? "").trim() || "(no output)";
            } catch (error) {
                const err = error as { killed?: boolean; signal?: string };
                if (err?.killed || err?.signal === "SIGTERM") {
                    throw new Error("Command timed out and was terminated.");
                }
                throw error;
            }
        });
    }

    protected psString(value: string): string {
        return value.replace(/'/g, "''");
    }

    protected truncateOutput(output: string, max = 4000): string {
        if (output.length <= max) return output;
        return `${output.slice(0, max)}\n... (truncated)`;
    }

    protected outputLimitFor(_tokens: string[]): number {
        return 4000;
    }

    protected async withExecutionLimit<T>(fn: () => Promise<T>): Promise<T> {
        if (BasePowerShellTool.activeExecutions >= BasePowerShellTool.MAX_CONCURRENT_EXECUTIONS) {
            throw new Error("Too many concurrent PowerShell executions. Please retry.");
        }
        BasePowerShellTool.activeExecutions += 1;
        try {
            return await fn();
        } finally {
            BasePowerShellTool.activeExecutions -= 1;
        }
    }

    private toFriendlyError(raw: string): string {
        const firstMeaningful =
            raw
                .replace(/\r/g, "")
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith("At line:") && !l.startsWith("+") && !l.startsWith("CategoryInfo") && !l.startsWith("FullyQualifiedErrorId"))[0]
            ?? "Unknown PowerShell error";

        if (/No such host is known/i.test(raw)) return `${this.describe().name} failed: DNS lookup failed. Check the hostname or network.`;
        if (/Access is denied|UnauthorizedAccess/i.test(raw)) return `${this.describe().name} failed: Access denied.`;
        if (/timed out|timeout/i.test(raw)) return `${this.describe().name} failed: Command timed out.`;

        return `${this.describe().name} failed: ${firstMeaningful}`;
    }
}

// ─── Everything CLI helper ───────────────────────────────────────────────────

/** Fast path: query voidtools Everything CLI (es.exe) if installed. */
async function tryEverything(args: string[], timeoutMs = 8_000): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync("es", args, { timeout: timeoutMs });
        const out = stdout.trim();
        return out.length ? out : null;
    } catch {
        return null;
    }
}

/** Check whether es.exe is available without spawning PowerShell. */
let everythingChecked: boolean | undefined;
let everythingAvailable: boolean | undefined;
async function isEverythingAvailable(): Promise<boolean> {
    if (everythingChecked) return everythingAvailable!;
    try {
        await execFileAsync("es", ["-version"], { timeout: 2_000 });
        everythingAvailable = true;
    } catch {
        everythingAvailable = false;
    }
    everythingChecked = true;
    return everythingAvailable;
}

// ─── Tool Implementations ────────────────────────────────────────────────────

class PowerShellProcessTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-process",
            description: "Inspect and control running processes (list or terminate by name).",
            command: "ps-process",
            argsHint: "<list|kill> [name]",
            examples: ["ps-process list", "ps-process kill chrome"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: { action: { type: "string", enum: ["list", "kill"] }, name: { type: "string" } },
                required: ["action"],
            },
        };
    }
    protected argumentsFromTokens([, action, name]: string[]): Record<string, unknown> {
        return {
            ...(action ? { action } : {}),
            ...(name ? { name } : {}),
        };
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.name),
        ]);
    }
    protected async run([, action, name]: string[]): Promise<string> {
        if (action === "list") return this.runPS("Get-Process | Select-Object -First 40");
        if (action === "kill") {
            this.assertSafeName(name ?? "", "process name");
            return this.runPS(`Stop-Process -Name '${name}' -Force`);
        }
        throw new Error("Usage: ps-process <list|kill> [name]");
    }
}

class PowerShellServiceTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-service",
            description: "List and manage Windows services (start, stop, restart).",
            command: "ps-service",
            argsHint: "<list|start|stop|restart> [name]",
            examples: ["ps-service list", "ps-service restart Spooler"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: { action: { type: "string", enum: ["list", "start", "stop", "restart"] }, name: { type: "string" } },
                required: ["action"],
            },
        };
    }
    protected argumentsFromTokens([, action, name]: string[]): Record<string, unknown> {
        return {
            ...(action ? { action } : {}),
            ...(name ? { name } : {}),
        };
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.name),
        ]);
    }
    protected async run([, action, name]: string[]): Promise<string> {
        if (action === "list") return this.runPS("Get-Service | Select-Object -First 60");
        this.assertSafeName(name ?? "", "service name");
        if (action === "start") return this.runPS(`Start-Service -Name '${name}'`);
        if (action === "stop") return this.runPS(`Stop-Service -Name '${name}'`);
        if (action === "restart") return this.runPS(`Restart-Service -Name '${name}'`);
        throw new Error("Usage: ps-service <list|start|stop|restart> [name]");
    }
}

class PowerShellFileTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-file",
            description: "Read, write, and delete files in permitted paths.",
            command: "ps-file",
            argsHint: "<read|write|delete> <path> [content]",
            examples: ["ps-file read C:\\temp\\log.txt"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: { action: { type: "string", enum: ["read", "write", "delete"] }, path: { type: "string" }, content: { type: "string" } },
                required: ["action", "path"],
            },
        };
    }
    protected argumentsFromTokens([, action, path, ...rest]: string[]): Record<string, unknown> {
        const content = rest.join(" ").trim();
        return {
            ...(action ? { action } : {}),
            ...(path ? { path } : {}),
            ...(content ? { content } : {}),
        };
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.path),
            this.asOptionalString(args.content),
        ]);
    }
    protected async run([, action, path, ...rest]: string[]): Promise<string> {
        if (!path) throw new Error("Usage: ps-file <read|write|delete> <path> [content]");
        this.assertSafePath(path);
        if (action === "read") return this.runPS(`Get-Content -Path '${this.psString(path)}'`);
        if (action === "delete") return this.runPS(`Remove-Item -Path '${this.psString(path)}' -Force`);
        if (action === "write") {
            const content = rest.join(" ");
            if (!content) throw new Error("Missing content for write action.");
            return this.runPS(`Set-Content -Path '${this.psString(path)}' -Value '${this.psString(content)}'`);
        }
        throw new Error("Usage: ps-file <read|write|delete> <path> [content]");
    }
}

class PowerShellNetworkTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-network",
            description: "Run basic network diagnostics like ping and DNS lookup.",
            command: "ps-network",
            argsHint: "<ping|dns> <target>",
            examples: ["ps-network ping google.com", "ps-network dns microsoft.com"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: { action: { type: "string", enum: ["ping", "dns"] }, target: { type: "string" } },
                required: ["action", "target"],
            },
        };
    }
    protected argumentsFromTokens([, action, target]: string[]): Record<string, unknown> {
        return {
            ...(action ? { action } : {}),
            ...(target ? { target } : {}),
        };
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.target),
        ]);
    }
    protected async run([, action, target = ""]: string[]): Promise<string> {
        this.assertSafeHost(target);
        if (action === "ping") return this.runPS(`Test-Connection '${target}' -Count 2`);
        if (action === "dns") return this.runPS(`Resolve-DnsName '${target}'`);
        throw new Error("Usage: ps-network <ping|dns> <target>");
    }
}

class PowerShellSystemTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-system",
            description: "Fetch machine-level system information, disk, and CPU metrics.",
            command: "ps-system",
            argsHint: "<info|disk|cpu>",
            examples: ["ps-system info", "ps-system disk"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: { action: { type: "string", enum: ["info", "disk", "cpu"] } },
                required: ["action"],
            },
        };
    }
    protected argumentsFromTokens([, action]: string[]): Record<string, unknown> {
        return action ? { action } : {};
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
        ]);
    }
    protected async run([, action]: string[]): Promise<string> {
        if (action === "info") return this.runPS("Get-ComputerInfo");
        if (action === "disk") return this.runPS("Get-PSDrive");
        if (action === "cpu") return this.runPS("Get-Counter '\\Processor(_Total)\\% Processor Time'");
        throw new Error("Usage: ps-system <info|disk|cpu>");
    }
}

const ALLOWED_SCRIPTS: Record<string, string> = {
    cleanup: "Get-ChildItem $env:TEMP -File | Sort-Object LastWriteTime -Descending | Select-Object -First 20",
};

class PowerShellScriptTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }
    public describe(): CommandToolDescriptor {
        return {
            name: "ps-script",
            description: "Execute pre-approved maintenance scripts only.",
            command: "ps-script",
            argsHint: "<script>",
            examples: ["ps-script cleanup"],
            autoRoute: false,
            parameters: {
                type: "object",
                properties: { script: { type: "string" } },
                required: ["script"],
            },
        };
    }
    protected argumentsFromTokens([, script = ""]: string[]): Record<string, unknown> {
        return script ? { script } : {};
    }
    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.script),
        ]);
    }
    protected async run([, script = ""]: string[]): Promise<string> {
        this.assertSafeName(script, "script");
        const command = ALLOWED_SCRIPTS[script.toLowerCase()];
        if (!command) throw new Error(`Script not allowed: ${script}`);
        return this.runPS(command);
    }
}

// ─── Search Tool (find + grep) ───────────────────────────────────────────────

class PowerShellSearchTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "ps-search",
            description: "Search content like grep, or find files/folders by name. Uses Everything (es.exe) or ripgrep when available.",
            command: "ps-search",
            argsHint: "<grep|find> <pattern> [path]",
            examples: [
                "ps-search grep TODO C:\\Coding\\AI Projects\\Jarvis\\src",
                "ps-search find *.ts C:\\Coding\\AI Projects\\Jarvis\\src",
                "ps-search find *haven* C:\\",
            ],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["grep", "find"] },
                    pattern: { type: "string", description: "Text or filename pattern to search for." },
                    path: { type: "string", description: "Optional start directory. Defaults to current directory." },
                },
                required: ["action", "pattern"],
            },
        };
    }

    protected argumentsFromTokens([, action, pattern, ...rest]: string[]): Record<string, unknown> {
        const path = rest.join(" ").trim();
        return {
            ...(action ? { action } : {}),
            ...(pattern ? { pattern } : {}),
            ...(path ? { path } : {}),
        };
    }

    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.pattern),
            this.asOptionalString(args.path),
        ]);
    }

    protected async run([, action, pattern, basePath = "."]: string[]): Promise<string> {
        if (!pattern) throw new Error("Usage: ps-search <grep|find> <pattern> [path]");
        this.assertSafePath(basePath);

        if (action === "find") {
            // 1st tier: Everything CLI (instant)
            const everything = await this.tryEverythingFind(pattern, basePath);
            if (everything) return everything;

            // 2nd tier: ripgrep for filenames (fast, parallel)
            const rg = await this.tryRunRipgrep(pattern, basePath, true);
            if (rg) return rg;

            // 3rd tier: .NET BFS with -Filter (fast, low memory, resilient)
            return this.runPSWithTimeout(
                this.buildDotNetFindPs(basePath, pattern),
                120_000,
            );
        }

        if (action === "grep") {
            // 1st tier: ripgrep
            const rg = await this.tryRunRipgrep(pattern, basePath, false);
            if (rg) return rg;

            // 2nd tier: .NET BFS feeding Select-String
            return this.runPSWithTimeout(
                this.buildDotNetGrepPs(basePath, pattern),
                120_000,
            );
        }

        throw new Error("Usage: ps-search <grep|find> <pattern> [path]");
    }

    private async tryEverythingFind(pattern: string, basePath: string): Promise<string | null> {
        if (!(await isEverythingAvailable())) return null;
        // es.exe -path limits scope; -n limits results; no -folder so we get files+dirs
        const out = await tryEverything([
            "-n", "120",
            "-path", basePath,
            pattern,
        ]);
        if (!out) return null;
        const lines = out.replace(/\r/g, "").split("\n").filter(Boolean).slice(0, 120);
        if (lines.length === 0) return "No matching files or folders found.";
        return this.truncateOutput(lines.map((line) => {
            const isDir = line.endsWith("\\") || !line.match(/\.[a-zA-Z0-9]{1,6}$/);
            return `${isDir ? "dir" : "file"}\t${line}`;
        }).join("\n"), 6000);
    }

    private async tryRunRipgrep(pattern: string, basePath: string, filesOnly: boolean): Promise<string | null> {
        try {
            await execFileAsync("rg", ["--version"], { timeout: 2_000 });
        } catch {
            return null;
        }

        const args = filesOnly
            ? ["--files", "--glob", pattern, basePath]
            : ["-n", "--no-heading", "--max-count", "120", pattern, basePath];

        try {
            const { stdout, stderr } = await execFileAsync("rg", args, {
                timeout: 120_000,
                maxBuffer: 2 * 1024 * 1024,
            });
            const output = (stdout ?? stderr ?? "").trim();
            if (!output) {
                return filesOnly ? "No matching files or folders found." : "No matching content found.";
            }
            if (!filesOnly) return this.truncateOutput(output, 6000);

            const lines = output.replace(/\r/g, "").split("\n").filter(Boolean).slice(0, 120);
            if (lines.length === 0) return "No matching files or folders found.";
            return this.truncateOutput(lines.map((line) => `file\t${line}`).join("\n"), 6000);
        } catch {
            return null;
        }
    }

    /** PowerShell script using .NET BFS queue — much faster than Get-ChildItem -Recurse. */
    private buildDotNetFindPs(basePath: string, pattern: string): string {
        return [
            "$ErrorActionPreference = 'SilentlyContinue'",
            `$base='${this.psString(basePath)}'`,
            `$filter='${this.psString(pattern)}'`,
            "$max = 120",
            "$results = [System.Collections.Generic.List[string]]::new()",
            "$queue = [System.Collections.Generic.Queue[string]]::new()",
            "$queue.Enqueue($base)",
            "while ($queue.Count -gt 0 -and $results.Count -lt $max) {",
            "  $dir = $queue.Dequeue()",
            "  try {",
            "    foreach ($item in [System.IO.Directory]::EnumerateFileSystemEntries($dir, $filter)) {",
            "      $kind = if ([System.IO.Directory]::Exists($item)) { 'dir' } else { 'file' }",
            "      $results.Add(\"$kind`t$item\")",
            "      if ($results.Count -ge $max) { break }",
            "    }",
            "    foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir)) {",
            "      $queue.Enqueue($sub)",
            "    }",
            "  } catch {}",
            "}",
            "if ($results.Count -eq 0) { 'No matching files or folders found.' }",
            "else { $results -join \"`n\" }",
        ].join("\n");
    }

    /** BFS feeding Select-String — avoids Get-ChildItem object overhead. */
    private buildDotNetGrepPs(basePath: string, pattern: string): string {
        return [
            "$ErrorActionPreference = 'SilentlyContinue'",
            `$base='${this.psString(basePath)}'`,
            `$pattern='${this.psString(pattern)}'`,
            "$max = 80",
            "$results = [System.Collections.Generic.List[string]]::new()",
            "$queue = [System.Collections.Generic.Queue[string]]::new()",
            "$queue.Enqueue($base)",
            "while ($queue.Count -gt 0 -and $results.Count -lt $max) {",
            "  $dir = $queue.Dequeue()",
            "  try {",
            "    foreach ($file in [System.IO.Directory]::EnumerateFiles($dir)) {",
            "      $hits = Select-String -Path $file -Pattern $pattern -ErrorAction SilentlyContinue",
            "      foreach ($hit in $hits) {",
            "        $results.Add(\"$($hit.Path):$($hit.LineNumber):$($hit.Line)\")",
            "        if ($results.Count -ge $max) { break }",
            "      }",
            "    }",
            "    foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir)) {",
            "      $queue.Enqueue($sub)",
            "    }",
            "  } catch {}",
            "}",
            "if ($results.Count -eq 0) { 'No matching content found.' }",
            "else { $results -join \"`n\" }",
        ].join("\n");
    }
}

// ─── Folder Tool ─────────────────────────────────────────────────────────────

class PowerShellFolderTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "ps-folder",
            description:
                "Directories only. Browse drives or top folders, find directories by name with where, open a named directory with openfind, list the contents of one directory with list, or open Explorer on a path. Use this for folder names like 'coding folder' or project folders when the user does not know the exact path. Do not use ps-app for directories.",
            command: "ps-folder",
            argsHint: "<browse|where|list|open|openfind> [target] [basePath]",
            examples: [
                "ps-folder browse",
                "ps-folder browse c",
                "ps-folder browse C:\\",
                "ps-folder where StartupHaven C:\\",
                'ps-folder where "Startup Haven" C:\\Coding',
                "ps-folder list C:\\Coding",
                "ps-folder open C:\\Coding\\StartupHaven",
                "ps-folder openfind coding",
            ],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["browse", "where", "list", "open", "openfind"] },
                    target: { type: "string" },
                    basePath: { type: "string" },
                },
                required: ["action"],
            },
        };
    }

    protected argumentsFromTokens([, action, ...rest]: string[]): Record<string, unknown> {
        const base: Record<string, unknown> = action ? { action } : {};

        if (action === "where") {
            if (rest.length === 0) {
                return base;
            }

            const last = rest[rest.length - 1]?.trim() ?? "";
            const hasBasePath = rest.length > 1 && this.isLikelyWindowsPathToken(last);
            const target = hasBasePath ? rest.slice(0, -1).join(" ").trim() : rest.join(" ").trim();

            return {
                ...base,
                ...(target ? { target } : {}),
                ...(hasBasePath ? { basePath: last } : {}),
            };
        }

        const target = rest.join(" ").trim();
        return {
            ...base,
            ...(target ? { target } : {}),
        };
    }

    protected buildCommandLine(args: Record<string, unknown>): string {
        const action = this.asOptionalString(args.action);
        const target = this.asOptionalString(args.target);
        const basePath = this.asOptionalString(args.basePath);

        return this.joinCommandLine([
            this.describe().command,
            action,
            target,
            action === "where" ? basePath : undefined,
        ]);
    }

    protected outputLimitFor(tokens: string[]): number {
        const action = tokens[1]?.toLowerCase();
        if (action === "browse") return 48_000;
        if (action === "where" || action === "list") return 24_000;
        return 12_000;
    }

    private normalizeBrowseDriveArg(raw: string): string | null {
        const s = raw.trim();
        if (!s) return "";
        const compact = s.replace(/\s+/g, "");
        const lower = compact.toLowerCase();
        if (/^[a-z]$/.test(lower)) return lower;
        const withColon = lower.match(/^([a-z]):/);
        if (withColon) return withColon[1] ?? null;
        return null;
    }

    protected async run([, action, ...rest]: string[]): Promise<string> {
        if (action === "browse") {
            const rawArg = rest[0]?.trim() ?? "";
            const onlyLetter = this.normalizeBrowseDriveArg(rawArg);
            if (rawArg && onlyLetter === null) {
                throw new Error("Usage: ps-folder browse [drive] — optional: single letter c, or c:, C:, C:\\ (all drives if omitted)");
            }
            const letterFilter = onlyLetter === "" ? "$true" : `$_.Root.Substring(0,1).ToLower() -eq '${onlyLetter}'`;
            return this.runPSWithTimeout(
                [
                    "$ErrorActionPreference = 'SilentlyContinue'",
                    "Write-Output '=== Logical drives (filesystem) ==='",
                    "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -and ($_.Root -match '^[A-Za-z]:\\\\$') } |",
                    "  Sort-Object Name | ForEach-Object {",
                    '    $used = if ($_.Used) { [math]::Round($_.Used / 1GB, 1) } else { "?" }',
                    '    $free = if ($_.Free) { [math]::Round($_.Free / 1GB, 1) } else { "?" }',
                    '    "drive`t$($_.Name)`t$($_.Root)`tUsedGB=$used`tFreeGB=$free"',
                    "  }",
                    "$roots = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -and ($_.Root -match '^[A-Za-z]:\\\\$') -and (" + letterFilter + ") } | ForEach-Object { $_.Root } | Where-Object { Test-Path -LiteralPath $_ })",
                    "foreach ($root in $roots) {",
                    "  Write-Output ('=== Top-level folders: ' + $root + ' (first 45) ===')",
                    "  Get-ChildItem -LiteralPath $root -Directory -Force | Select-Object -First 45 Name,FullName |",
                    "    ForEach-Object { \"dir`t$($_.Name)`t$($_.FullName)\" }",
                    "}",
                    "if ($env:USERPROFILE -and (Test-Path -LiteralPath $env:USERPROFILE)) {",
                    "  Write-Output '=== Profile top-level folders (first 40) ==='",
                    "  Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force | Select-Object -First 40 Name,FullName |",
                    "    ForEach-Object { \"dir`t$($_.Name)`t$($_.FullName)\" }",
                    "}",
                    "Write-Output '=== Hint ==='",
                    "Write-Output 'Pick a FullName from above; user can say: ps-folder open <path> or ask to open a named folder.'",
                ].join("\n"),
                90_000,
            );
        }

        if (action === "openfind") {
            const name = rest.join(" ").trim();
            if (!name) throw new Error("Usage: ps-folder openfind <folder-name-fragment>");
            this.assertSafeFolderSearchTerm(name, "folder search term");

            // Try Everything first (instant)
            if (await isEverythingAvailable()) {
                const out = await tryEverything([
                    "-folder", "-n", "1",
                    "-path", "C:\\",
                    `*${name}*`,
                ]);
                if (out) {
                    const hit = out.split("\n")[0]!.trim();
                    return this.runPSWithTimeout(
                        `Start-Process explorer.exe -ArgumentList '${this.psString(hit)}' | Out-Null; "Opened folder: ${hit}"`,
                        30_000,
                    );
                }
            }

            // Fallback: BFS in common roots
            return this.runPSWithTimeout(
                [
                    "$ErrorActionPreference = 'SilentlyContinue'",
                    `$term='*${this.psString(name)}*'`,
                    "$roots = @('C:\\', $env:USERPROFILE)",
                    "if (Test-Path 'D:\\') { $roots += 'D:\\' }",
                    "$opened = $false",
                    "foreach ($root in $roots) {",
                    "  if (-not (Test-Path -LiteralPath $root)) { continue }",
                    "  $queue = [System.Collections.Generic.Queue[string]]::new()",
                    "  $queue.Enqueue($root)",
                    "  while ($queue.Count -gt 0) {",
                    "    $dir = $queue.Dequeue()",
                    "    try {",
                    "      foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir, $term)) {",
                    "        Start-Process -FilePath explorer.exe -ArgumentList $sub | Out-Null",
                    `        Write-Output "Opened folder: $sub"`,
                    "        $opened = $true",
                    "        break",
                    "      }",
                    "      if ($opened) { break }",
                    "      foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir)) {",
                    "        $queue.Enqueue($sub)",
                    "      }",
                    "    } catch {}",
                    "  }",
                    "  if ($opened) { break }",
                    "}",
                    "if (-not $opened) { Write-Output 'No matching folder found under common drives.' }",
                ].join("\n"),
                120_000,
            );
        }

        if (action === "list") {
            const rawList = (rest.join(" ").trim() || ".").trim();
            const folderPath = this.normalizeWindowsFolderPath(rawList);
            this.assertSafePath(folderPath);
            return this.runPSWithTimeout(
                [
                    `$path='${this.psString(folderPath)}'`,
                    "if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw \"Folder not found: $path\" }",
                    "Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue | Select-Object -First 120 Name,FullName,PSIsContainer,Length,LastWriteTime |",
                    "ForEach-Object {",
                    '  $kind = if ($_.PSIsContainer) { "dir" } else { "file" }',
                    '  "$kind`t$($_.Name)`t$($_.FullName)"',
                    "}",
                ].join("\n"),
                120_000,
            );
        }

        if (action === "open") {
            const folderPath = this.normalizeWindowsFolderPath(rest.join(" ").trim());
            if (!folderPath) throw new Error("Usage: ps-folder open <folder-path>");
            this.assertSafePath(folderPath);
            return this.runPSWithTimeout(
                [
                    `$path='${this.psString(folderPath)}'`,
                    "if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw \"Folder not found: $path\" }",
                    "Start-Process explorer.exe -ArgumentList $path | Out-Null",
                    '"Opened folder: $path"',
                ].join("\n"),
                60_000,
            );
        }

        if (action === "where") {
            if (rest.length === 0) throw new Error("Usage: ps-folder where <folder-name> [basePath]");
            let name: string;
            let basePath: string;
            const last = rest[rest.length - 1]?.trim() ?? "";
            if (rest.length === 1) {
                name = last;
                basePath = "C:\\";
            } else if (this.isLikelyWindowsPathToken(last)) {
                basePath = last;
                name = rest.slice(0, -1).join(" ").trim();
            } else {
                name = rest.join(" ").trim();
                basePath = "C:\\";
            }
            if (!name) throw new Error("Usage: ps-folder where <folder-name> [basePath]");
            this.assertSafePath(basePath);
            this.assertSafeFolderSearchTerm(name, "folder name");
            const baseNorm = this.normalizeWindowsFolderPath(basePath);

            // 1st tier: Everything CLI
            if (await isEverythingAvailable()) {
                const out = await tryEverything([
                    "-folder", "-n", "120",
                    "-path", baseNorm,
                    `*${name}*`,
                ]);
                if (out) {
                    const lines = out.replace(/\r/g, "").split("\n").filter(Boolean).slice(0, 120);
                    return this.truncateOutput(lines.map((l) => `dir\t${l}`).join("\n"), 24_000);
                }
                return "No matching folders found.";
            }

            // 2nd tier: .NET BFS queue (resilient + fast)
            return this.runPSWithTimeout(
                [
                    "$ErrorActionPreference = 'SilentlyContinue'",
                    `$base='${this.psString(baseNorm)}'`,
                    `$term='*${this.psString(name)}*'`,
                    "$max = 120",
                    "$results = [System.Collections.Generic.List[string]]::new()",
                    "$queue = [System.Collections.Generic.Queue[string]]::new()",
                    "$queue.Enqueue($base)",
                    "while ($queue.Count -gt 0 -and $results.Count -lt $max) {",
                    "  $dir = $queue.Dequeue()",
                    "  try {",
                    "    foreach ($hit in [System.IO.Directory]::EnumerateDirectories($dir, $term)) {",
                    "      $results.Add(\"dir`t$hit\")",
                    "      if ($results.Count -ge $max) { break }",
                    "    }",
                    "    foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir)) {",
                    "      $queue.Enqueue($sub)",
                    "    }",
                    "  } catch {}",
                    "}",
                    "if ($results.Count -eq 0) { 'No matching folders found.' }",
                    "else { $results -join \"`n\" }",
                ].join("\n"),
                120_000,
            );
        }

        throw new Error("Usage: ps-folder <browse|where|list|open|openfind> [target] [basePath]");
    }
}

// ─── App Tool (unchanged logic, fixed join) ──────────────────────────────────

class PowerShellAppTool extends BasePowerShellTool {
    public constructor(deps: PowerShellToolDependencies) {
        super(deps);
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "ps-app",
            description:
                "Installed apps and programs only (executable). Do not use for folders or projects—those are directories; use ps-folder (`open`, `openfind`, `where`) instead. Prefer `.exe` or Start Menu app names.",
            command: "ps-app",
            argsHint: "<list|where|open> [target]",
            examples: ["ps-app list", "ps-app list chrome", "ps-app where chrome", "ps-app open notepad.exe"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["list", "where", "open"] },
                    target: { type: "string" },
                },
                required: ["action"],
            },
        };
    }

    protected argumentsFromTokens([, action, ...rest]: string[]): Record<string, unknown> {
        const target = rest.join(" ").trim();
        return {
            ...(action ? { action } : {}),
            ...(target ? { target } : {}),
        };
    }

    protected buildCommandLine(args: Record<string, unknown>): string {
        return this.joinCommandLine([
            this.describe().command,
            this.asOptionalString(args.action),
            this.asOptionalString(args.target),
        ]);
    }

    protected async run([, action, ...rest]: string[]): Promise<string> {
        const target = rest.join(" ").trim();

        if (action === "list") {
            if (target) {
                if (!SAFE_APP_TARGET_RE.test(target)) throw new Error("Invalid application target.");
                return this.runPS(
                    `Get-Process | Where-Object { $_.ProcessName -like '*${this.psString(target)}*' } | Select-Object -First 40 ProcessName,Id,Path,MainWindowTitle`,
                );
            }
            return this.runPS("Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 ProcessName,Id,MainWindowTitle");
        }

        if (action === "where") {
            if (!target) throw new Error("Usage: ps-app where <app-name>");
            if (!SAFE_APP_TARGET_RE.test(target)) throw new Error("Invalid application target.");
            return this.runPS(`
$q='${this.psString(target)}'
$proc = Get-Process | Where-Object { $_.ProcessName -like "*$q*" } | Select-Object -First 10 ProcessName,Id,Path,MainWindowTitle
$cmd  = Get-Command "$q.exe" -ErrorAction SilentlyContinue | Select-Object -First 5 Name,Source
Write-Output "Running process matches:"
if ($proc) { $proc | Format-Table -AutoSize | Out-String } else { "(none)" }
Write-Output "Command resolution:"
if ($cmd)  { $cmd  | Format-Table -AutoSize | Out-String } else { "(none)" }
            `.trim());
        }

        if (action === "open") {
            if (!target) throw new Error("Usage: ps-app open <executable-or-path>");
            if (!SAFE_APP_TARGET_RE.test(target)) throw new Error("Invalid application target.");

            const trimmed = target.trim();
            const looksLikeFolderPath =
                /[\\/]/.test(trimmed) &&
                !/\.(exe|com|bat|cmd|msi|scr)(\s|$)?$/i.test(trimmed);

            if (looksLikeFolderPath) {
                this.assertSafePath(trimmed);
                return this.runPSWithTimeout(
                    [
                        `$path='${this.psString(trimmed)}'`,
                        "if (-not (Test-Path -LiteralPath $path -PathType Container)) {",
                        "  throw \"Not a folder (or not found): $path. Use ps-folder open for directories, or pass an .exe for apps.\"",
                        "}",
                        "Start-Process -FilePath explorer.exe -ArgumentList $path | Out-Null",
                        '"Opened folder in Explorer: $path"',
                    ].join("\n"),
                    60_000,
                );
            }

            const processName = this.psString(target.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? target);
            return this.runPS(`
$target='${this.psString(target)}'
$before = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue).Count
Start-Process -FilePath $target | Out-Null
Start-Sleep -Milliseconds 900
$after = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue).Count
if ($after -gt 0) {
  if ($after -gt $before) {
    "Opened successfully: $target. Detected $after running process(es)."
  }
  else {
    "Open command sent: $target. App is already running with $after process(es)."
  }
} else {
  throw "Launch not confirmed for $target."
}
            `.trim());
        }

        throw new Error("Usage: ps-app <list|where|open> [target]");
    }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createPowerShellTools(dependencies: PowerShellToolDependencies): CommandTool[] {
    return [
        new PowerShellProcessTool(dependencies),
        new PowerShellServiceTool(dependencies),
        new PowerShellFileTool(dependencies),
        new PowerShellNetworkTool(dependencies),
        new PowerShellSystemTool(dependencies),
        new PowerShellScriptTool(dependencies),
        new PowerShellSearchTool(dependencies),
        new PowerShellFolderTool(dependencies),
        new PowerShellAppTool(dependencies),
    ];
}
