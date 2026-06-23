# cursor-sdk-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets MCP clients
such as **Claude Code** invoke the [Cursor SDK](https://cursor.com/docs/sdk/typescript) and use
**Cursor Agent** capabilities — running a Cursor coding agent against a working directory, listing
models, and continuing agent conversations — all as tools.

## What it does

The server speaks MCP over **stdio** and exposes these tools:

| Tool | Description |
| --- | --- |
| `cursor_whoami` | Verify the configured Cursor API key and return the authenticated identity. |
| `cursor_list_models` | List the Cursor models available to the account. |
| `cursor_run_agent` | Run a Cursor Agent (local runtime) against a `cwd` with a prompt. Returns an `agentId`. |
| `cursor_follow_up` | Continue a previous agent conversation by `agentId`. |

Under the hood it uses `@cursor/sdk`'s **local** runtime: the agent loop runs in this Node process
and reads/writes files on disk, while inference runs on Cursor's hosted models.

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
call `cursor_run_agent`.

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
- `src/server.ts` — builds the `McpServer` and registers the four tools. Decoupled from the SDK via
  `CursorService` so tests can inject a fake backend.
- `src/index.ts` — entry point; wires the real service to a `StdioServerTransport`.
- `tests/server.test.ts` — connects an in-memory MCP client to the server and exercises every tool.
- `examples/demo-client.ts` — end-to-end demo over a real stdio transport.

## License

MIT
