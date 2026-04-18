# Tool Calling - How to Add Tools (and Future Function Calling)

This document is a practical guide for expanding Jarvis tool calling: adding new tools, wiring config, testing, and (later) upgrading to OpenAI-style function tool calling.

Jarvis supports two concepts:

1) **Runtime tools (deterministic, local)** - Tools run inside the Jarvis runtime (Node.js). They can run before the LLM call, or they can short-circuit the LLM entirely.
2) **LLM function tools (OpenAI-style)** - The model selects a tool and returns structured JSON arguments (not implemented yet in this repo).

Keep both:
- Runtime tools are fast, cheap, and work even when the provider is `local`.
- Function tools become useful when you have many tools and want the model to choose and pass typed arguments.

---

## 1) Current request pipeline (runtime tool calling)

Source of truth: `src/orchestrator/index.ts`.

High-level flow per user message:

1. Persist conversation + message + run record.
2. **Command tool pass**: `ToolRegistry.tryRunCommand(request)`
   - If a command tool matches, Jarvis returns immediately (no LLM call).
3. **Tool router pass (optional)**: `ToolRouter.routeCommandTool(...)`
   - Converts natural language into a `//command ...` (only for tools that opt-in).
4. **Pre-model tools pass**: `ToolRegistry.runPreModelTools(request)`
   - Runs tools that add context to the prompt (example: web search).
5. Memory retrieval, agent prompt build, model call, persistence, memory capture.

Important: a command tool can also trigger on natural language directly (not only `//...`). For safe tools (like time), this is the cheapest and most reliable approach.

---

## 2) Tool types you can add today

### A) Command tools (deterministic; can short-circuit the LLM)

Use when:
- The tool output is the final answer (time, health, simple lookups).
- You want predictable behavior and minimal cost.

Contract:
- `src/tools/contracts.ts` defines `CommandTool` + `CommandToolDescriptor`.

Where they are registered:
- `src/tools/registry.ts` adds them to `commandTools`.

How they are enabled:
- `src/config/index.ts` maps env vars into `config.tools.<tool>.enabled` and `perChannel` flags.

Key fields in `describe()`:
- `name`: tool id (kebab-case recommended).
- `description`: one sentence describing the output.
- `command`: canonical debug command (example: `//time`).
- `argsHint` (optional): a short hint (example: `[place]`).
- `examples`: 1-3 realistic examples.
- `autoRoute`: set `true` only for safe, read-only tools you want auto-routed.

Example tool: time
- Code: `src/tools/system_com.ts`
- Behavior: answers both explicit `//time` and natural language like "what time is it in Boston?"

### B) Pre-model tools (augment the prompt; LLM still replies)

Use when:
- You want to inject context and still let the model compose the final response.
- Example: web search snippets, retrieval, normalization, content redaction.

Example tool:
- `src/tools/web-search.ts` runs before the model and writes a tool message into history.

---

## 3) Tool router (natural language -> `//command ...`)

Source of truth: `src/tools/tool-router.ts`.

The router exists to map plain English to a command tool when:
- multiple tools exist, and
- you do not want every tool to parse natural language inside `shouldRun(...)`.

Safety rules in the router:
- Only tools with `autoRoute: true` are eligible.
- If the router uses an LLM to decide, it validates the tool name against an allowlist.
- It also validates the returned command starts with the chosen tool command prefix.

Note: for ultra-safe tools like time, direct natural-language matching inside the tool is often better (no extra model call).

---

## 4) Add a new tool (step-by-step)

### Step 0: Decide the tool kind

Pick one:
- **Command tool**: deterministic output; can short-circuit the model.
- **Pre-model tool**: adds context; model still answers.

Rule of thumb:
- If it can cost money, touch secrets, write to DB, or take side effects: keep it explicit (command-only, `autoRoute: false`) or require confirmation.

### Step 1: Scaffold the tool

Command tool:
```bash
npm run tool:new -- my-tool
```

Command tool with a custom command:
```bash
npm run tool:new -- weather --kind command --command weather
```

Pre-model tool:
```bash
npm run tool:new -- redact --kind pre-model
```

The scaffolder wires up:
- `src/tools/<tool>.ts`
- `.env.example` (adds `ENABLE_<TOOL>=false`)
- `src/config/index.ts` (adds config plumbing)
- `src/tools/registry.ts` (registers the tool in the right pipeline)

### Step 2: Implement `describe()`

Make examples realistic. The router and future function-tool calling depend on these being accurate.

### Step 3: Implement `shouldRun(...)`

Always gate first:
- tool enabled flag
- per-channel allowlist

Then decide what triggers it:
- command-only: match `//your-command ...`
- command + natural language: add intent detection (safe tools only)

### Step 4: Implement `execute(...)`

Output design tips:
- Keep it short (tool output is stored in history).
- Use bullet or key/value formatting.
- Never return secrets (tokens, passwords, API keys).
- Handle errors by returning `{ success: false, output: ... }`.

### Step 5: Add tests

Tests live in `src/tests/*.test.ts` and run with:
```bash
npm test
```

For HTTP tools, stub `globalThis.fetch` in tests (do not hit the real network).

---

## 5) When should I switch to OpenAI-style function tools?

Use runtime tools when:
- You need deterministic behavior (time, health).
- You want to avoid model cost/latency.
- You need the feature to work even when provider is `local`.

Use function tools when:
- You have many tools and want the model to choose.
- You need structured arguments (JSON schema).
- You want multi-step tool + reasoning loops.

Recommended hybrid:
- Keep runtime tools as fast-paths for safe basics.
- Add function tools for complex workflows.

---

## 6) Roadmap: Implement OpenAI-style function tool calling (planned)

Goal: support Chat Completions function tools like:

```json
{
  "model": "gpt-5.4-mini",
  "messages": [{"role":"user","content":"What is the weather in Boston?"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"},
            "unit": {"type": "string", "enum": ["c", "f"]}
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

Jarvis does not send `tools`/`tool_choice` today. To add it:

### A) Add a function-tool contract

Create new interfaces (example file: `src/tools/function-contracts.ts`):
- `FunctionToolDefinition` (name, description, JSON-schema parameters)
- `FunctionTool` (definition(), execute(args, context))

### B) Extend the tool registry

Add:
- `listFunctionTools(channel)`
- `getFunctionTool(name)`
- config gating (enabled/perChannel)

### C) Extend the model provider(s) to support tool calls

For OpenAI-compatible providers (`src/models/providers/openai.ts`):
- Send `tools` and `tool_choice` fields.
- Parse `choices[0].message.tool_calls` in responses.

For OpenRouter, implement equivalent behavior if/when their API surface exposes tool calls in the SDK.

### D) Orchestrator: implement a tool-call loop

Pseudo-flow:
1. Build messages (system + history + memory + pre-model tool outputs).
2. Call model with `tools` and `tool_choice: "auto"`.
3. If the model returns tool calls:
   - Validate tool name is allowlisted and enabled.
   - Parse JSON args.
   - Execute tool(s).
   - Append tool results as tool messages.
   - Persist tool calls, then loop back to step 2.
4. Stop after a max number of rounds (example: 3).

Mandatory safety controls:
- tool allowlist (registry is the allowlist)
- per-tool policy (read-only vs side-effect)
- max rounds + max tool calls per round
- max tool output length
- timeouts for HTTP tools

### E) Keep runtime tools

Even after function tools exist, keep runtime tools like time as a fast-path.

---

## 7) Quick checklist for any new tool

- Env flag exists in `.env.example`
- Config wired in `src/config/index.ts`
- Tool registered in `src/tools/registry.ts`
- `describe()` is accurate + has examples
- `autoRoute` matches risk profile
- Tests stub external IO and cover success + failure
- Tool output never contains secrets
