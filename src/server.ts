/**
 * Builds the MCP server and registers the Cursor Agent tools.
 *
 * The server is decoupled from the Cursor SDK via {@link CursorService}, so the
 * same registration code is exercised by integration tests with a fake backend.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AgentRunResult, CursorService } from "./cursor.js";
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
        mode: z
          .enum(["agent", "plan"])
          .optional()
          .describe('"agent" implements changes directly; "plan" explores and plans first.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ prompt, cwd, model, mode }) => {
      try {
        return formatRun(await service.runAgent({ prompt, cwd, model, mode }));
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

  return server;
}
