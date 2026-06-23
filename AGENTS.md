# AGENTS.md

`cursor-sdk-mcp` is a TypeScript MCP (Model Context Protocol) server that exposes the Cursor SDK
(`@cursor/sdk`) as MCP tools so clients like Claude Code can drive Cursor Agents. See `README.md`
for the product overview, tool list, and standard commands.

## Cursor Cloud specific instructions

### Stack & standard commands
- Node.js project, npm (see `package-lock.json`). Requires **Node >= 22.13** (enforced by `@cursor/sdk`).
- Standard scripts live in `package.json`: `build`, `dev`, `start`, `typecheck`, `lint`, `test`, `demo`.
- Tests use the built-in `node:test` runner via `tsx` and connect an **in-memory MCP client** to the
  server with a **fake Cursor backend** (`tests/server.test.ts`) — they need no network and no API key.

### Running the server (non-obvious caveats)
- The server is **stdio-only** (`node dist/index.js`). It is launched by an MCP client (e.g. Claude
  Code), not run as a standalone long-lived service. `stdout` is reserved for JSON-RPC — all logging
  goes to `stderr`. Do not add `console.log` to stdout in `src/`, it will corrupt the protocol stream.
- `examples/demo-client.ts` (`npm run demo`) is the fastest end-to-end check: it spawns the built
  server over a real stdio transport, lists tools, and calls them. Run `npm run build` first.

### Authentication
- All tools that hit Cursor's backend (`cursor_whoami`, `cursor_list_models`, `cursor_run_agent`,
  `cursor_follow_up`) require the **`CURSOR_API_KEY`** environment variable. Without it the server
  still starts and lists tools, but those tools return a clear auth error instead of throwing.
- To actually exercise a real Cursor Agent run, set `CURSOR_API_KEY` and run `RUN_AGENT=1 npm run demo`.

### Known harmless noise
- Importing `@cursor/sdk` loads `node:sqlite` (its default local-agent store), which prints
  `ExperimentalWarning: SQLite is an experimental feature` to stderr. This is expected and harmless.
- Local-agent conversation state is persisted on disk (SQLite under the home dir), which is why
  `cursor_follow_up` can resume an `agentId` even in a fresh process.

### Behavioral note
- The local Cursor Agent runtime runs tool calls (shell/edit/write) **without approval** in headless
  mode and can modify files and run commands inside the `cwd` passed to `cursor_run_agent`. Point it
  at a scratch/working directory you intend the agent to change.
