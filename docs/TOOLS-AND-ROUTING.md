# Tools And Routing

This document explains how Jarvis decides to run tools, what each built-in tool does, and what future contributors need to keep in mind when adding or changing tools.

Read this document before touching:

- `src/tools/contracts.ts`
- `src/tools/registry.ts`
- `src/tools/tool-router.ts`
- any file in `src/tools/`
- `src/agents/tool-result-formatter/index.ts`

## 1. Tool System Mental Model

Jarvis has two tool phases:

1. command tools
2. pre-model tools

Command tools can end the turn before the main assistant model runs.

Pre-model tools add context before the main assistant model runs, but the assistant path still continues.

There is also a separate formatter step:

- command tools return raw structured output
- `ToolResultFormatterAgent` turns that into cleaner user-facing prose

So the full command-tool path is:

```text
user request
  -> exact command check
  -> AI router if needed
  -> tool execution
  -> tool output persisted
  -> formatter model call
  -> final assistant reply
```

## 2. Current Tool Contracts

### Command Tool Contract

Defined in `src/tools/contracts.ts`.

Every command tool must implement:

- `describe()`
- `isEnabled(channel)`
- `matchDirectInvocation(request)`
- `execute(invocation)`

Important consequence:

- tools are no longer message-parser-plus-regex bundles
- exact command parsing happens in `matchDirectInvocation`
- routed tool execution receives structured arguments

### Tool Descriptor

`CommandToolDescriptor` is the router-facing contract.

It tells the router:

- tool name
- tool description
- canonical command
- argument hint
- examples
- whether `autoRoute` is allowed
- JSON-schema-style parameters

If `describe()` is vague or misleading, routing quality drops immediately.

### Tool Invocation

`CommandToolInvocation` contains:

- `request`
- `source`
- `arguments`

Current sources:

- `direct-command`
- `tool-router`
- `pre-model-tool`

### Tool Call Record

`ToolCallRecord` is what gets persisted and shown to the user.

It includes:

- tool name
- structured input
- raw output
- success flag
- created timestamp

The output formatter works from this record, not from hidden tool-specific state.

## 3. Exact Commands vs Routed Commands vs Pre-Model Tools

### Exact Commands

Exact command handling is local and strict.

Current exact command parsing uses `src/utils/direct-command.ts`.

Behavior:

- `time` matches `time`
- `time Boston` matches `time <args>`
- `save my name is Vishu` matches the `memory-saving` direct command
- `remind submit assignment in 2h` matches the `automation` direct command
- `every 1d do summarize today's AI news` creates a recurring automation task
- most direct commands start with their canonical command; tools may also support intentionally distinct command verbs like `remind`, `every`, and `tasks`

Why this matters:

- exact commands are deterministic
- they do not depend on the model
- they should stay cheap and predictable

### Routed Commands

If no exact command matches, Jarvis can ask the fast model to choose one command tool.

This happens in `src/tools/tool-router.ts`.

The router:

1. receives enabled command-tool descriptors
2. filters them to `autoRoute: true`
3. gives the fast model recent conversation context
4. exposes real tool schemas plus a pseudo-tool named `ask_clarification`
5. returns one of:
   - `run-tool`
   - `ask-clarification`
   - `no-tool`

Important rule:

- the router selects tools
- the registry executes tools

Do not merge those responsibilities.

### Pre-Model Tools

Pre-model tools run before the normal assistant prompt is built.

Current built-in pre-model tool:

- `web-search`

These tools do not end the turn early. They just enrich context for the main assistant model.

## 4. Tool Registry

`src/tools/registry.ts` owns tool inventory and execution.

Responsibilities:

- instantiate built-in tools
- define command-tool order
- return enabled descriptors for a channel
- match exact commands
- execute a selected command tool
- run pre-model tools

### Why Order Matters

Command tools use first-match behavior for exact commands.

Current order:

1. `time`
2. `memory-saving`
3. `memory-lookup`
4. `automation`
5. PowerShell tools

Practical consequence:

- exact command syntax should remain distinct
- adding overlapping command names can create hidden behavior changes

### Automation Tool

`src/tools/automation.ts` creates, lists, and cancels scheduled reminders and recurring prompt jobs.

Supported direct commands:

- `remind submit assignment in 2h`
- `remind call mentor at 2026-05-08 18:00`
- `every 1d do summarize today's AI news`
- `tasks`
- `cancel task task_abc`

The tool persists tasks through `AutomationService`; it does not run scheduled work itself. Due execution is owned by `src/automation/service.ts`.

## 5. Tool Router

`src/tools/tool-router.ts` is AI-first.

It does not use hardcoded regex intent routing for memory or filesystem decisions anymore. Instead, it provides the fast model with:

- the available auto-routable tools
- tool descriptions
- tool parameter schemas
- recent conversation context
- explicit routing rules in the system prompt

### Router Responsibilities

- choose one command tool when intent is clear
- ask one short clarification when needed
- do nothing when no command tool is appropriate

### Router Context

The router receives recent messages from the active conversation.

That is why it can resolve follow-ups like:

- "open coding folder"
- "you have to find it"
- "only list all folder in it"

The router sees recent user, assistant, and tool messages, not just the current text.

### Clarification Path

The router can return:

```text
{ kind: "ask-clarification", question: "..." }
```

This is used when the user intent is still ambiguous after reading recent context.

The clarification reply bypasses the normal assistant model path for that turn.

## 6. Formatter Layer

`src/agents/tool-result-formatter/index.ts` formats raw tool output after a command tool succeeds or fails.

### What It Does

- chooses a formatting profile:
  - `brief`
  - `steps`
  - `analysis`
- injects the original user question
- injects the raw tool output
- optionally reads small skill docs from `src/skills/`

### What It Does Not Do

- it does not execute tools
- it does not route tools
- it does not change tool output facts

The formatter exists so tool implementations can stay strict and machine-readable while users still get a natural response.

## 7. Built-In Tool Catalog

### Command Tools

| Tool | File | Auto-route | Purpose |
| --- | --- | --- | --- |
| `time` | `src/tools/time.ts` | yes | Get local or place-based time. |
| `memory-saving` | `src/tools/memory-saving.ts` | yes | Save explicit user facts or preferences. |
| `memory-lookup` | `src/tools/memory-lookup.ts` | yes | Retrieve what Jarvis already knows. |
| `ps-process` | `src/tools/powershell.ts` | yes | List or kill processes. |
| `ps-service` | `src/tools/powershell.ts` | yes | List, start, stop, or restart services. |
| `ps-file` | `src/tools/powershell.ts` | yes | Read, write, or delete files. |
| `ps-network` | `src/tools/powershell.ts` | yes | Ping and DNS lookup. |
| `ps-system` | `src/tools/powershell.ts` | yes | Machine information, disk, CPU metrics. |
| `ps-script` | `src/tools/powershell.ts` | no | Run allowlisted maintenance scripts only. |
| `ps-search` | `src/tools/powershell.ts` | yes | Grep content or find files and folders. |
| `ps-folder` | `src/tools/powershell.ts` | yes | Browse, find, list, and open directories. |
| `ps-app` | `src/tools/powershell.ts` | yes | Find or open installed apps and executables. |

### Pre-Model Tools

| Tool | File | Purpose |
| --- | --- | --- |
| `web-search` | `src/tools/web-search.ts` | Add external context before the assistant responds. |

## 8. Built-In Tool Behavior Details

### `time`

File: `src/tools/time.ts`

Direct command:

- `time`
- `time Boston, MA`

Behavior:

- returns local and UTC time when no place is supplied
- geocodes place names through Open-Meteo
- caches geocode lookups for one day
- returns ambiguity suggestions when more than one place matches

Keep in mind:

- direct commands are strict
- natural-language time requests are usually router-selected, not locally regex-routed

### `memory-saving`

File: `src/tools/memory-saving.ts`

Direct command:

- `save <fact-or-preference>`

Behavior:

- uses `MemoryService.saveExplicitMemory(...)`
- stores user-scoped memory
- deduplicates repeated saves
- works against whichever backend `MemoryService` selected

Use it when:

- the user is telling Jarvis a new fact
- the user is giving a preference
- the user explicitly asks Jarvis to remember something

Do not use it when:

- the user is asking what Jarvis already knows

### `memory-lookup`

File: `src/tools/memory-lookup.ts`

Behavior:

- no exact direct command path today
- usually selected by the router for recall requests
- uses `MemoryService.lookupExplicitMemory(...)`
- returns matches or fallback memory summaries

Use it when:

- the user is asking about saved memory
- the user asks what Jarvis remembers

Do not use it when:

- the user is introducing new information

### `web-search`

File: `src/tools/web-search.ts`

Behavior:

- runs before the main model path
- queries DuckDuckGo Instant Answer style results
- returns a compact bullet list
- can be forced by `/search` in terminal or metadata flags from HTTP

Auto-run conditions:

- web search enabled
- channel allowed
- metadata allows it
- or default heuristics match words like `latest`, `today`, `news`, `search`, `lookup`, or `web`

Keep in mind:

- this tool enriches context, it does not finalize the response on its own

## 9. PowerShell Tool Family

All PowerShell command tools live in `src/tools/powershell.ts`.

They share the same base behavior:

- `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass`
- concurrency limit of 3 active executions
- friendly error normalization
- output truncation
- basic input validation
- channel-level enablement through `ENABLE_POWERSHELL`

### Shared Guardrails

The base tool blocks or constrains:

- unsafe path prefixes like `C:\Windows` and `C:\Program Files`
- invalid hostnames
- invalid names for processes and services
- unsafe folder search terms with path separators

Important note:

- some PowerShell tools are side-effectful
- do not casually expand write or delete behavior without revisiting routing risk, tests, and docs

### `ps-process`

Actions:

- `list`
- `kill <name>`

Use it for:

- viewing active processes
- stopping a process by name

### `ps-service`

Actions:

- `list`
- `start <name>`
- `stop <name>`
- `restart <name>`

Use it for:

- Windows service inspection and control

### `ps-file`

Actions:

- `read <path>`
- `write <path> <content>`
- `delete <path>`

Use it for:

- file inspection and limited file modification

Keep in mind:

- this tool is side-effectful
- changing it should trigger a routing and safety review

### `ps-network`

Actions:

- `ping <target>`
- `dns <target>`

Use it for:

- simple network diagnostics

### `ps-system`

Actions:

- `info`
- `disk`
- `cpu`

Use it for:

- machine status and environment inspection

### `ps-script`

Actions:

- one allowlisted script name

Current behavior:

- only executes pre-approved scripts from the internal allowlist
- `autoRoute: false`

Why it is different:

- this tool is intentionally explicit-only
- if you add a script here, treat it like a product capability, not a convenience hack

### `ps-search`

Actions:

- `grep <pattern> [path]`
- `find <pattern> [path]`

Search order:

- for file finding: Everything CLI if available, then `rg`, then .NET BFS
- for grep: `rg` if available, then .NET BFS plus `Select-String`

Use it for:

- finding filenames
- finding folders by pattern
- searching code and text content

### `ps-folder`

Actions:

- `browse [drive]`
- `where <folder-name> [basePath]`
- `list <folder-path>`
- `open <folder-path>`
- `openfind <folder-name-fragment>`

This is the main directory and project-folder tool.

Use it for:

- "find my coding folder"
- "open the project folder"
- "list what is inside that directory"

Important rule:

- if the target is a directory, prefer `ps-folder`
- do not misuse `ps-app` for directories

### `ps-app`

Actions:

- `list [target]`
- `where <app-name>`
- `open <executable-or-path>`

Use it for:

- installed apps
- executables
- running program discovery

Do not use it for:

- project folders
- arbitrary directories

The code explicitly tells the formatter and router that directory tasks belong to `ps-folder`.

## 10. What Future Tool Authors Need To Keep In Mind

### Keep Inputs Structured

Prefer:

- typed argument objects
- honest schemas
- clean examples

Avoid:

- reparsing the raw message inside `execute(...)`
- hidden regex intent logic in the tool implementation

### Keep Ownership Clean

Tools should:

- validate their own arguments
- execute their own capability
- return a `ToolCallRecord`

Tools should not:

- write assistant messages
- call the orchestrator
- read channel state directly
- make routing decisions

### Keep Descriptions Honest

Router quality depends on:

- `description`
- `examples`
- `parameters`

If a description says a tool handles something it actually should not handle, the router will make worse decisions.

### Keep Safety Explicit

When a tool can mutate state:

- document it
- test it
- think about whether `autoRoute` should stay enabled

For read-only tools:

- make that obvious in the description

### Keep Output Compact

Command tools should return:

- enough structure to be useful
- enough signal for the formatter
- not a full essay

The formatter is responsible for prose quality.

## 11. Adding A New Tool

Start with:

```bash
npm run tool:new -- my-tool
```

The scaffold updates the registry markers and config markers.

Minimum checklist:

1. implement the tool file
2. register it in `src/tools/registry.ts`
3. add config in `src/config/index.ts`
4. update `.env.example`
5. decide whether `autoRoute` is safe
6. write or update tests
7. update this document

If the tool is formatter-sensitive, consider whether `src/skills/` needs a small formatter hint.

## 12. Anti-Patterns

Do not do these:

- do not hide natural-language routing in a command tool implementation
- do not let a tool depend on channel-specific logic
- do not let a tool modify conversation history directly
- do not make the router pretend to support tools that are not actually safe to auto-run
- do not add "temporary" unsafe PowerShell actions without docs and tests
- do not let formatter skills become a second hidden prompt system for the main assistant

## 13. When To Update This Document

Update this file when:

- a tool is added, removed, or renamed
- a tool contract changes
- router behavior changes
- formatter behavior changes
- PowerShell safety boundaries change

The next developer should be able to read this file and know:

- which tool owns which job
- which tool should not be used for a task
- where routing decisions happen
- what guardrails exist before adding more tool power
