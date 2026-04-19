# Tools (tool-calling) in Jarvis

Jarvis tools are small modules that run **before** the LLM call (pre-model tools) or run as **explicit commands** (command tools). Tools return a `ToolCallRecord` and are persisted as `role: "tool"` messages in the conversation history.

## Two tool modes

### 1) Command tools (recommended for `//...` commands)

- Triggered by an explicit user command like `//tool` (some tools may also auto-trigger on natural language).
- Runs **without calling the LLM** (the orchestrator short-circuits).
- The assistant reply is the tool output text.

Where it is wired:
- Tool code: `src/tools/*.ts`
- Registration: `src/tools/registry.ts` (added to `commandTools`)
- Orchestration short-circuit: `src/orchestrator/index.ts` calls `tools.tryRunCommand(...)`

### Tool router (natural language -> `//command`)

If you enable the tool router (`ENABLE_TOOL_ROUTER=true`), Jarvis may route plain-language messages to an appropriate **command tool** (for example, "what time is it?" -> `//time`).

- Uses **native OpenAI tool calling** (`tools` + `tool_choice: "auto"`) for accurate routing.
- Each tool's `parameters` JSON Schema is sent as a function tool definition to the model.
- The model returns structured `tool_calls` (not free-text JSON), which are converted to `//command args`.
- It only routes to command tools that are enabled for the current channel.
- For best results, keep each command tool's `describe()` accurate (description + examples + parameters).
- Only tools with `autoRoute: true` in `describe()` are eligible for auto-routing.
- Jarvis avoids an extra model call unless there is a real choice (2+ auto-routable tools).

### 2) Pre-model tools (augment the prompt)

- Triggered automatically (heuristics or metadata).
- Runs **before** the LLM and injects output into the prompt as a tool message.
- The LLM still runs and can use the tool output.

Where it is wired:
- Tool code: `src/tools/*.ts`
- Registration: `src/tools/registry.ts` (added under `runPreModelTools`)

## Scaffold a new tool

Use the built-in scaffolder (cross-platform):

```bash
npm run tool:new -- my-tool
```

Wrappers (optional):
- scripts/new-tool.sh my-tool
- scripts/new-tool.ps1 my-tool

Or directly:

```bash
node scripts/scaffold-tool.mjs my-tool
```

Defaults:
- Creates `src/tools/my-tool.ts`
- Adds `ENABLE_MY_TOOL=false` to `.env.example`
- Adds config plumbing in `src/config/index.ts`
- Registers the tool in `src/tools/registry.ts` as a **command tool** (via `commandTools`)

To scaffold a pre-model tool instead:

```bash
npm run tool:new -- my-tool --kind pre-model
```

## Manual wiring (if you prefer doing it by hand)

1) Create a tool file under `src/tools/`.
2) Register it in `src/tools/registry.ts`:
   - Add the import (`./your-tool.js`)
   - Add a field + instantiate it in the constructor
   - Add it to `commandTools` (command tool) or `runPreModelTools` (pre-model tool)
3) Add config in `src/config/index.ts` under `tools`:
   - Add an env var (example: `ENABLE_YOUR_TOOL`)
   - Add `tools.yourTool.enabled` + `tools.yourTool.perChannel`
4) Add the env var to `.env.example` so it is discoverable.

## Adding a `parameters` schema (for native tool calling)

When a command tool has `autoRoute: true`, the ToolRouter sends its definition to the OpenAI API. Adding a `parameters` JSON Schema to `describe()` gives the model structured argument definitions:

```typescript
public describe(): CommandToolDescriptor {
    return {
        name: "weather",
        description: "Get current weather for a location.",
        command: "//weather",
        argsHint: "<city>",
        examples: ["//weather London"],
        autoRoute: true,
        parameters: {                           // <-- JSON Schema
            type: "object",
            properties: {
                city: {
                    type: "string",
                    description: "City name to get weather for.",
                },
            },
            required: ["city"],
        },
    };
}
```

If `parameters` is omitted, the router sends `{ type: "object", properties: {} }` (no-args tool). See `docs/TOOLCALLING.md` for the full native tool calling flow.

## Recommended conventions

- Tool names: kebab-case for `ToolCallRecord.name` (example: `system-com`, `web-search`).
- File names: kebab-case under `src/tools/`.
- Config keys: camelCase under `config.tools.*`.
- Keep tool output concise (it becomes part of the conversation history).
- Do not log or persist secrets in tool output.

## Testing

```bash
npm test
```
