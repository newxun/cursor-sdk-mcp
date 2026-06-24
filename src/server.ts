/**
 * Builds the MCP server and registers the Cursor Agent tools.
 *
 * The server is decoupled from the Cursor SDK via {@link CursorService}, so the
 * same registration code is exercised by integration tests with a fake backend.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AgentRunResult, CursorService, QueryRunParams } from "./cursor.js";
import { describeError } from "./errors.js";

export interface ServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "cursor-sdk-mcp",
  version: "0.1.0",
};

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
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

const agentDefinitionSchema = z
  .object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    mcpServers: z.array(z.union([z.string().min(1), z.record(mcpServerSchema)])).optional(),
  })
  .strict();

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
  mcpServers: z.record(mcpServerSchema).optional(),
  agents: z.record(agentDefinitionSchema).optional(),
  idempotencyKey: z.string().min(1).optional(),
};

const queryRunInputSchema = {
  agentId: z.string().min(1),
  runId: z.string().min(1).optional(),
  runtime: z.enum(["local", "cloud"]).optional(),
  cwd: z.string().min(1).optional(),
};

const artifactInputSchema = {
  agentId: z.string().min(1),
};

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
    async ({ prompt, cwd, model, mode }) => {
      try {
        return formatRun(await service.runLocalAgent({ prompt, cwd, model, mode }));
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
    async (params) => {
      try {
        return formatRun(await service.runLocalAgent(params));
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
    async (params) => {
      try {
        return formatRun(await service.runCloudAgent(params));
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ agentId, prompt, model }) => {
      try {
        return formatRun(await service.followUp({ agentId, prompt, model }));
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
        const params: QueryRunParams = { agentId, runId, runtime, cwd };
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
        const params: QueryRunParams = { agentId, runId, runtime, cwd };
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
      inputSchema: queryRunInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params: QueryRunParams = { agentId, runId, runtime, cwd };
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
      inputSchema: queryRunInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ agentId, runId, runtime, cwd }) => {
      try {
        const params: QueryRunParams = { agentId, runId, runtime, cwd };
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
    async ({ agentId }) => {
      try {
        return jsonResult({ artifacts: await service.listArtifacts({ agentId }) });
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
    async ({ agentId, path }) => {
      try {
        const content = await service.downloadArtifact({ agentId, path });
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
