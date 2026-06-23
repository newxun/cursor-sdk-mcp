import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type {
  AgentRunResult,
  CursorService,
  FollowUpParams,
  ModelInfo,
  RunAgentParams,
  WhoAmI,
} from "../src/cursor.js";
import { createServer } from "../src/server.js";

class FakeCursorService implements CursorService {
  public readonly calls: Array<{ method: string; params: unknown }> = [];

  async whoami(): Promise<WhoAmI> {
    this.calls.push({ method: "whoami", params: undefined });
    return { apiKeyName: "test-key", userId: 42, userEmail: "dev@example.com" };
  }

  async listModels(): Promise<ModelInfo[]> {
    this.calls.push({ method: "listModels", params: undefined });
    return [
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "auto", displayName: "Auto" },
    ];
  }

  async runAgent(params: RunAgentParams): Promise<AgentRunResult> {
    this.calls.push({ method: "runAgent", params });
    return {
      agentId: "agent-test-123",
      status: "finished",
      result: `Completed: ${params.prompt}`,
      durationMs: 12,
      model: params.model ?? "auto",
    };
  }

  async followUp(params: FollowUpParams): Promise<AgentRunResult> {
    this.calls.push({ method: "followUp", params });
    return {
      agentId: params.agentId,
      status: "finished",
      result: `Follow-up: ${params.prompt}`,
    };
  }
}

class FailingCursorService implements CursorService {
  async whoami(): Promise<WhoAmI> {
    const error = Object.assign(new Error("Invalid API key"), {
      code: "auth_error",
      status: 401,
    });
    throw error;
  }
  async listModels(): Promise<ModelInfo[]> {
    throw new Error("boom");
  }
  async runAgent(): Promise<AgentRunResult> {
    throw new Error("boom");
  }
  async followUp(): Promise<AgentRunResult> {
    throw new Error("boom");
  }
}

async function connect(service: CursorService): Promise<Client> {
  const server = createServer(service, { name: "cursor-sdk-mcp-test", version: "0.0.0" });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("lists all four Cursor tools", async () => {
  const client = await connect(new FakeCursorService());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cursor_follow_up",
    "cursor_list_models",
    "cursor_run_agent",
    "cursor_whoami",
  ]);
  await client.close();
});

test("cursor_whoami returns identity", async () => {
  const client = await connect(new FakeCursorService());
  const res = await client.callTool({ name: "cursor_whoami", arguments: {} });
  assert.equal(res.isError ?? false, false);
  assert.deepEqual(res.structuredContent, {
    apiKeyName: "test-key",
    userId: 42,
    userEmail: "dev@example.com",
  });
  await client.close();
});

test("cursor_list_models returns model ids", async () => {
  const client = await connect(new FakeCursorService());
  const res = await client.callTool({ name: "cursor_list_models", arguments: {} });
  const structured = res.structuredContent as { models: ModelInfo[] };
  assert.deepEqual(
    structured.models.map((m) => m.id),
    ["composer-2.5", "auto"],
  );
  await client.close();
});

test("cursor_run_agent forwards args and returns the run result", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  const res = await client.callTool({
    name: "cursor_run_agent",
    arguments: { prompt: "Summarize the repo", cwd: "/tmp/work", model: "composer-2.5" },
  });
  assert.equal(res.isError ?? false, false);
  const run = res.structuredContent as AgentRunResult;
  assert.equal(run.agentId, "agent-test-123");
  assert.equal(run.status, "finished");
  assert.match(run.result, /Summarize the repo/);

  const call = service.calls.find((c) => c.method === "runAgent");
  assert.deepEqual(call?.params, {
    prompt: "Summarize the repo",
    cwd: "/tmp/work",
    model: "composer-2.5",
    mode: undefined,
  });
  await client.close();
});

test("cursor_follow_up continues a conversation by agentId", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  const res = await client.callTool({
    name: "cursor_follow_up",
    arguments: { agentId: "agent-test-123", prompt: "Now add tests" },
  });
  const run = res.structuredContent as AgentRunResult;
  assert.equal(run.agentId, "agent-test-123");
  assert.match(run.result, /Now add tests/);
  await client.close();
});

test("input validation flags missing required fields", async () => {
  const client = await connect(new FakeCursorService());
  let surfacedError = false;
  try {
    const res = await client.callTool({
      name: "cursor_run_agent",
      arguments: { prompt: "no cwd" },
    });
    surfacedError = res.isError === true;
  } catch {
    // The SDK may instead reject with a validation McpError; both are acceptable.
    surfacedError = true;
  }
  assert.equal(surfacedError, true);
  await client.close();
});

test("backend errors surface as tool errors with diagnostics", async () => {
  const client = await connect(new FailingCursorService());
  const res = await client.callTool({ name: "cursor_whoami", arguments: {} });
  assert.equal(res.isError, true);
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  assert.match(text, /Invalid API key/);
  assert.match(text, /status=401/);
  await client.close();
});
