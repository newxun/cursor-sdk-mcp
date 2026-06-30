# cursor-sdk-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets MCP clients
such as **Claude Code** invoke the [Cursor SDK](https://cursor.com/docs/sdk/typescript) and use
**Cursor Agent** capabilities as tools for local and cloud coding workflows.

## What it does

The server speaks MCP over **stdio** and exposes these tools:

| Tool | Description |
| --- | --- |
| `cursor_whoami` | Verify the configured Cursor API key and return the authenticated identity. |
| `cursor_list_models` | List the Cursor models available to the account. |
| `cursor_run_agent` | Compatibility alias for a local Cursor Agent run against one `cwd`. |
| `cursor_run_local_agent` | Run a local Cursor Agent against one or more working directories with optional Cursor MCP settings, inline MCP servers, subagents, sandboxing, and auto-review. |
| `cursor_run_cloud_agent` | Run a Cursor Cloud Agent in a Cursor-hosted or self-hosted environment, optionally cloning repos and creating PRs. |
| `cursor_follow_up` | Continue a previous agent conversation by `agentId`. |
| `cursor_get_agent` | Fetch agent metadata. |
| `cursor_list_runs` | List runs for an agent. |
| `cursor_get_run` | Fetch one run by `runId`. |
| `cursor_cancel_run` | Cancel one run by `runId`. |
| `cursor_list_artifacts` | List artifacts produced by an agent. |
| `cursor_download_artifact` | Download an artifact as base64 content. |

Under the hood it uses `@cursor/sdk`'s local and cloud runtimes. Local agents read/write files on
disk from this Node process. Cloud agents run in Cursor-hosted or self-hosted environments and can
use Cursor account/team MCP configuration from `cursor.com/agents`.

## Requirements

- **Node.js >= 22.13** (required by `@cursor/sdk`).
- A **Cursor API key**. Create one at the Cursor Dashboard → API Keys (user key) or Team settings
  (service account key).

## Install & build

```bash
npm install
npm run build
```

## Configure

Set your API key (see `.env.example`):

```bash
export CURSOR_API_KEY="your-cursor-api-key"
# Optional: default model id used when a tool call omits one (default: "auto")
export CURSOR_MCP_DEFAULT_MODEL="auto"
```

## Use with Claude Code

Register the server with Claude Code (stdio):

```bash
claude mcp add cursor-sdk -- node /absolute/path/to/cursor-sdk-mcp/dist/index.js
```

Or add it to your MCP client config manually:

```json
{
  "mcpServers": {
    "cursor-sdk": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-sdk-mcp/dist/index.js"],
      "env": { "CURSOR_API_KEY": "your-cursor-api-key" }
    }
  }
}
```

Then ask Claude Code to, for example, "use the cursor agent to refactor `src/auth.ts`", and it will
call `cursor_run_local_agent` or the compatibility `cursor_run_agent`.

## Local agent usage

Use `cursor_run_local_agent` when the agent should work in local directories:

```json
{
  "prompt": "Refactor src/server.ts to split schemas into src/schemas.ts and run tests.",
  "cwd": "/absolute/path/to/repo",
  "model": "auto",
  "mode": "agent",
  "settingSources": ["project", "user", "plugins"],
  "autoReview": true
}
```

`settingSources` controls which Cursor MCP/settings layers the local runtime loads from disk. You can
also pass inline `mcpServers`, `agents`, and `sandboxOptions` for one-off tool wiring and safety.
For local `cursor_follow_up`, lifecycle, and artifact calls, pass the same `cwd` used to create the
agent so the SDK can find persisted local agent state.

## Live progress and cancellation

`cursor_run_agent`, `cursor_run_local_agent`, `cursor_run_cloud_agent`, and `cursor_follow_up` run to
completion in a single tool call. Because a real coding run can take minutes, the server keeps the
call responsive:

- **Progress streaming.** When the MCP client sends a `progressToken` with the request (most clients
  do this automatically when you register a progress callback), the server streams each agent
  step — assistant text, tool calls, status changes — back as `notifications/progress`. Clients that
  reset their request timeout on progress (set `resetTimeoutOnProgress`) won't time out on long runs,
  and the user sees what the agent is doing instead of a silent wait.
- **Cancellation.** If the client cancels the tool call (its `AbortSignal` fires), the server cancels
  the underlying Cursor run, so you stop paying for work you no longer need.

Progress streaming is best-effort: if a client doesn't request progress, or the runtime doesn't
support streaming, the tool still returns the same final result.

## Cloud agent usage

Use `cursor_run_cloud_agent` when the agent should run in Cursor Cloud:

```json
{
  "prompt": "Add tests for the auth middleware and open a PR.",
  "repos": [{ "url": "https://github.com/your-org/your-repo", "startingRef": "main" }],
  "model": "auto",
  "autoCreatePR": true
}
```

`repos` can be omitted for an empty workspace or a named cloud environment. Cloud agents can use
inline MCP plus Cursor account/team MCP configured at `cursor.com/agents`. Use the lifecycle tools to
inspect runs, cancel work, and fetch artifacts.

## Cursor MCP and skills strategy

- Local agents use inline MCP unless `settingSources` includes project, user, or plugin settings.
- Local stdio MCP servers may include `cwd`; cloud stdio MCP servers must not include `cwd`.
- Cloud agents use inline MCP plus user/team MCP from `cursor.com/agents`.
- OAuth MCP must already be authorized in Cursor before local reuse.
- Cursor skills can live in `.cursor/skills/`, `.agents/skills/`, `~/.cursor/skills/`, or
  `~/.agents/skills/`.
- Claude Code skills are separate from this integration and are not loaded by Cursor Agent through
  this MCP server.

## Development

```bash
npm run dev        # run from source with hot reload (tsx)
npm run typecheck  # type-check only
npm run lint       # eslint
npm test           # integration tests (fake Cursor backend, no network)
npm run demo       # spawn the built server over stdio and call its tools
RUN_AGENT=1 npm run demo   # additionally run a real Cursor Agent (needs CURSOR_API_KEY)
```

## How it's structured

- `src/cursor.ts` — `CursorService` interface + `CursorSdkService` (the `@cursor/sdk` wrapper).
- `src/server.ts` — builds the `McpServer` and registers the tools. Decoupled from the SDK via
  `CursorService` so tests can inject a fake backend.
- `src/index.ts` — entry point; wires the real service to a `StdioServerTransport`.
- `tests/server.test.ts` — connects an in-memory MCP client to the server and exercises every tool.
- `examples/demo-client.ts` — end-to-end demo over a real stdio transport.

## License

MIT
