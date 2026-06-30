/**
 * Builds the MCP server and registers the Cursor Agent tools.
 *
 * The server is decoupled from the Cursor SDK via {@link CursorService}, so the
 * same registration code is exercised by integration tests with a fake backend.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  AgentRunResult,
  CursorService,
  QueryRunParams,
  RunHooks,
} from "./cursor.js";
import { describeError } from "./errors.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Builds per-run hooks from the MCP request context so long agent runs feel
 * responsive: stream steps back as `notifications/progress` (only when the
 * client opted in with a progressToken) and forward request cancellation to the
 * underlying Cursor run via the abort signal.
 */
function runHooksFrom(extra: ToolExtra): RunHooks {
  const signal = extra.signal;
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return { signal };
  }
  let progress = 0;
  return {
    signal,
    onProgress: (event) => {
      progress += 1;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            message: `[${event.type}] ${event.message}`,
          },
        })
        .catch(() => {
          // A dropped progress notification must never fail the run.
        });
    },
  };
}

export interface ServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "cursor-sdk-mcp",
  version: "0.1.0",
};

function jsonResult(value: unknown): CallToolResult {
  const structured = toPlainJson(value);
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: isRecord(structured) ? structured : { value: structured },
  };
}

function toPlainJson(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? null : JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${describeError(error)}` }],
    isError: true,
  };
}

function formatRun(run: AgentRunResult): CallToolResult {
  const summary =
    `Agent ${run.agentId} finished with status "${run.status}".\n\n` +
    `${run.result || "(no final assistant text)"}`;
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: run as unknown as Record<string, unknown>,
    isError: run.status === "error",
  };
}

const modeSchema = z
  .enum(["agent", "plan"])
  .optional()
  .describe('"agent" implements changes directly; "plan" explores and plans first.');

const settingSourceSchema = z.enum(["project", "user", "team", "mdm", "plugins", "all"]);

const stdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const cloudStdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const remoteMcpServerSchema = z
  .object({
    type: z.enum(["http", "sse"]).optional(),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    auth: z
      .object({
        CLIENT_ID: z.string().min(1),
        CLIENT_SECRET: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const mcpServerSchema = z.union([stdioMcpServerSchema, remoteMcpServerSchema]);
const cloudMcpServerSchema = z.union([cloudStdioMcpServerSchema, remoteMcpServerSchema]);

function agentDefinitionSchemaFor(serverSchema: typeof mcpServerSchema | typeof cloudMcpServerSchema) {
  return z
    .object({
      description: z.string().min(1),
      prompt: z.string().min(1),
      model: z.string().min(1).optional(),
      mcpServers: z.array(z.union([z.string().min(1), z.record(serverSchema)])).optional(),
    })
    .strict();
}

const agentDefinitionSchema = agentDefinitionSchemaFor(mcpServerSchema);
const cloudAgentDefinitionSchema = agentDefinitionSchemaFor(cloudMcpServerSchema);

const localAgentInputSchema = {
  prompt: z.string().min(1).describe("Instruction for the Cursor Agent."),
  cwd: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Absolute path(s) to the working directories the agent operates in."),
  model: z
    .string()
    .optional()
    .describe('Model id (e.g. "composer-2.5"). Defaults to the server default ("auto").'),
  mode: modeSchema,
  settingSources: z.array(settingSourceSchema).optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
  agents: z.record(agentDefinitionSchema).optional(),
  sandboxOptions: z.object({ enabled: z.boolean() }).strict().optional(),
  autoReview: z.boolean().optional(),
  name: z.string().min(1).optional(),
};

const cloudRepositorySchema = z
  .object({
    url: z.string().url(),
    startingRef: z.string().min(1).optional(),
    prUrl: z.string().url().optional(),
  })
  .strict();

const cloudAgentInputSchema = {
  prompt: z.string().min(1).describe("Instruction for the Cursor Cloud Agent."),
  model: z.string().optional().describe('Model id. Defaults to the server default ("auto").'),
  mode: modeSchema,
  name: z.string().min(1).optional(),
  repos: z.array(cloudRepositorySchema).optional(),
  env: z
    .object({
      type: z.enum(["cloud", "pool", "machine"]),
      name: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  workOnCurrentBranch: z.boolean().optional(),
  autoCreatePR: z.boolean().optional(),
  skipReviewerRequest: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  mcpServers: z.record(cloudMcpServerSchema).optional(),
  agents: z.record(cloudAgentDefinitionSchema).optional(),
  idempotencyKey: z.string().min(1).optional(),
};

const queryRunInputSchema = {
  agentId: z.string().min(1),
  runId: z.string().min(1).optional(),
  runtime: z.enum(["local", "cloud"]).optional(),
  cwd: z.string().min(1).optional(),
};

const requiredRunInputSchema = {
  ...queryRunInputSchema,
  runId: z.string().min(1),
};

const artifactInputSchema = {
  agentId: z.string().min(1),
  runtime: z.enum(["local", "cloud"]).optional(),
  cwd: z.string().min(1).optional(),
};

function queryParams(params: QueryRunParams): QueryRunParams {
  return {
    ...params,
    runtime: params.runtime ?? (params.agentId.startsWith("bc-") ? "cloud" : "local"),
  };
}

function assertNoCloudMcpCwd(
  mcpServers: Record<string, unknown> | undefined,
  agents: Record<string, { mcpServers?: Array<string | Record<string, unknown>> }> | undefined,
): void {
  for (const [name, server] of Object.entries(mcpServers ?? {})) {
    if (typeof server === "object" && server !== null && "cwd" in server) {
      throw new Error(`Cloud MCP server "${name}" cannot include cwd.`);
    }
  }
  for (const [agentName, agent] of Object.entries(agents ?? {})) {
    for (const entry of agent.mcpServers ?? []) {
      if (typeof entry !== "object" || entry === null) continue;
      for (const [serverName, server] of Object.entries(entry)) {
        if (typeof server === "object" && server !== null && "cwd" in server) {
          throw new Error(`Cloud agent "${agentName}" MCP server "${serverName}" cannot include cwd.`);
        }
      }
    }
  }
}

export function createServer(
  service: CursorService,
  info: ServerInfo = DEFAULT_SERVER_INFO,
): McpServer {
  const server = new McpServer(info);

  server.registerTool(
    "cursor_whoami",
    {
      title: "Cursor: who am I",
      description:
        "Verify the configured Cursor API key and return the authenticated account identity. " +
        "Use this first to confirm authentication works before running an agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await service.whoami());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_list_models",
    {
      title: "Cursor: list models",
      description:
        "List the Cursor models available to the configured account. Use the returned ids " +
        "as the `model` argument for cursor_run_agent / cursor_follow_up.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult({ models: await service.listModels() });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_run_agent",
    {
      title: "Cursor: run agent",
      description:
        "Run a Cursor Agent (local runtime) against a working directory and return the final result. " +
        "The agent can read, edit, and write files and run shell commands in `cwd`. " +
        "Returns an `agentId` you can pass to cursor_follow_up to continue the same conversation.",
      inputSchema: {
        prompt: z.string().min(1).describe("Instruction for the Cursor Agent."),
        cwd: z
          .string()
          .min(1)
          .describe("Absolute path to the working directory the agent operates in."),
        model: z
          .string()
          .optional()
          .describe('Model id (e.g. "composer-2.5"). Defaults to the server default ("auto").'),
        mode: modeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ prompt, cwd, model, mode }, extra) => {
      try {
        return formatRun(
          await service.runLocalAgent({ prompt, cwd, model, mode }, runHooksFrom(extra)),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_run_local_agent",
    {
      title: "Cursor: run local agent",
      description:
        "Run a Cursor Agent locally against one or more working directories. The agent can read, edit, write, run shell commands, and use configured Cursor MCP servers. Use settingSources to load project, user, or plugin Cursor MCP configuration.",
      inputSchema: localAgentInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        return formatRun(await service.runLocalAgent(params, runHooksFrom(extra)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_run_cloud_agent",
    {
      title: "Cursor: run cloud agent",
      description:
        "Run a Cursor Cloud Agent in a Cursor-hosted or self-hosted environment. Cloud agents can use Cursor account/team MCP from cursor.com/agents, clone repositories, push branches, create PRs, and produce artifacts.",
      inputSchema: cloudAgentInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        assertNoCloudMcpCwd(params.mcpServers, params.agents);
        return formatRun(await service.runCloudAgent(params, runHooksFrom(extra)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_follow_up",
    {
      title: "Cursor: follow up",
      description:
        "Continue an existing Cursor Agent conversation by `agentId` with a new prompt. " +
        "Conversation context from previous runs is loaded automatically.",
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe("The agentId returned by a previous cursor_run_agent call."),
        prompt: z.string().min(1).describe("Follow-up instruction for the agent."),
        model: z.string().optional().describe("Optional per-run model override."),
        runtime: z.enum(["local", "cloud"]).optional(),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Required for local agents when the original cwd is not the current process cwd."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ agentId, prompt, model, runtime, cwd }, extra) => {
      try {
        const { runtime: resolvedRuntime } = queryParams({ agentId, runtime, cwd });
        return formatRun(
          await service.followUp(
            { agentId, prompt, model, runtime: resolvedRuntime, cwd },
            runHooksFrom(extra),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_get_agent",
    {
      title: "Cursor: get agent",
      description: "Fetch metadata for a Cursor Agent by agentId.",
      inputSchema: queryRunInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runId, runtime, cwd });
        return jsonResult(await service.getAgent(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_list_runs",
    {
      title: "Cursor: list runs",
      description: "List runs for a Cursor Agent.",
      inputSchema: queryRunInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runId, runtime, cwd });
        return jsonResult(await service.listRuns(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_get_run",
    {
      title: "Cursor: get run",
      description: "Fetch a specific Cursor Agent run by runId.",
      inputSchema: requiredRunInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runId, runtime, cwd });
        return jsonResult(await service.getRun(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_cancel_run",
    {
      title: "Cursor: cancel run",
      description: "Cancel a specific Cursor Agent run by runId.",
      inputSchema: requiredRunInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runId, runtime, cwd });
        await service.cancelRun(params);
        return jsonResult({ cancelled: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_list_artifacts",
    {
      title: "Cursor: list artifacts",
      description: "List artifacts produced by a Cursor Agent.",
      inputSchema: artifactInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runtime, cwd });
        return jsonResult({ artifacts: await service.listArtifacts(params) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "cursor_download_artifact",
    {
      title: "Cursor: download artifact",
      description: "Download a Cursor Agent artifact and return its bytes as base64.",
      inputSchema: {
        ...artifactInputSchema,
        path: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, path, runtime, cwd }) => {
      try {
        const params = queryParams({ agentId, runtime, cwd });
        const content = await service.downloadArtifact({ ...params, path });
        return jsonResult({
          agentId,
          path,
          contentBase64: content.toString("base64"),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
