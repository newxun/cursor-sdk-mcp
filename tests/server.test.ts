import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type {
  AgentRunResult,
  ArtifactParams,
  CloudRepositoryInput,
  CursorService,
  FollowUpParams,
  QueryRunParams,
  RunCloudAgentParams,
  RunLocalAgentParams,
  ModelInfo,
  WhoAmI,
} from "../src/cursor.js";
import { createServer } from "../src/server.js";

class FakeCursorService implements CursorService {
  public readonly calls: Array<{ method: string; params: unknown }> = [];
  public readonly localRun: AgentRunResult = {
    agentId: "agent-local-test",
    status: "finished",
    result: "local ok",
    durationMs: 12,
    requestId: "req-local",
    model: "auto",
  };
  public readonly cloudRun: AgentRunResult = {
    agentId: "bc-agent-cloud-test",
    status: "finished",
    result: "cloud ok",
    durationMs: 34,
    requestId: "req-cloud",
    model: "auto",
    git: { branches: [{ repoUrl: "https://github.com/example/repo", branch: "cursor/test" }] },
  };

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

  async runLocalAgent(params: RunLocalAgentParams): Promise<AgentRunResult> {
    this.calls.push({ method: "runLocalAgent", params });
    return { ...this.localRun, result: `Local: ${params.prompt}`, model: params.model ?? "auto" };
  }

  async runCloudAgent(params: RunCloudAgentParams): Promise<AgentRunResult> {
    this.calls.push({ method: "runCloudAgent", params });
    return { ...this.cloudRun, result: `Cloud: ${params.prompt}`, model: params.model ?? "auto" };
  }

  async followUp(params: FollowUpParams): Promise<AgentRunResult> {
    this.calls.push({ method: "followUp", params });
    return {
      agentId: params.agentId,
      status: "finished",
      result: `Follow-up: ${params.prompt}`,
    };
  }

  async getAgent(params: QueryRunParams): Promise<unknown> {
    this.calls.push({ method: "getAgent", params });
    return { agentId: params.agentId, name: "Fake Agent", status: "finished" };
  }

  async listRuns(params: QueryRunParams): Promise<unknown> {
    this.calls.push({ method: "listRuns", params });
    return { items: [{ id: "run-1", agentId: params.agentId, status: "finished" }] };
  }

  async getRun(params: QueryRunParams): Promise<unknown> {
    this.calls.push({ method: "getRun", params });
    return { id: params.runId, agentId: params.agentId, status: "finished" };
  }

  async cancelRun(params: QueryRunParams): Promise<void> {
    this.calls.push({ method: "cancelRun", params });
  }

  async listArtifacts(params: ArtifactParams): Promise<unknown[]> {
    this.calls.push({ method: "listArtifacts", params });
    return [{ path: "summary.md", sizeBytes: 14, updatedAt: "2026-06-24T00:00:00.000Z" }];
  }

  async downloadArtifact(params: ArtifactParams & { path: string }): Promise<Buffer> {
    this.calls.push({ method: "downloadArtifact", params });
    return Buffer.from(`# ${params.path}\n`);
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
  async runLocalAgent(): Promise<AgentRunResult> {
    throw new Error("boom");
  }
  async runCloudAgent(): Promise<AgentRunResult> {
    throw new Error("boom");
  }
  async followUp(): Promise<AgentRunResult> {
    throw new Error("boom");
  }
  async getAgent(): Promise<unknown> {
    throw new Error("boom");
  }
  async listRuns(): Promise<unknown> {
    throw new Error("boom");
  }
  async getRun(): Promise<unknown> {
    throw new Error("boom");
  }
  async cancelRun(): Promise<void> {
    throw new Error("boom");
  }
  async listArtifacts(): Promise<unknown[]> {
    throw new Error("boom");
  }
  async downloadArtifact(): Promise<Buffer> {
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

test("lists the full Cursor Agent tool surface", async () => {
  const client = await connect(new FakeCursorService());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cursor_cancel_run",
    "cursor_download_artifact",
    "cursor_follow_up",
    "cursor_get_agent",
    "cursor_get_run",
    "cursor_list_artifacts",
    "cursor_list_models",
    "cursor_list_runs",
    "cursor_run_agent",
    "cursor_run_cloud_agent",
    "cursor_run_local_agent",
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
  assert.equal(run.agentId, "agent-local-test");
  assert.equal(run.status, "finished");
  assert.match(run.result, /Summarize the repo/);

  const call = service.calls.find((c) => c.method === "runLocalAgent");
  assert.deepEqual(call?.params, {
    prompt: "Summarize the repo",
    cwd: "/tmp/work",
    model: "composer-2.5",
    mode: undefined,
  });
  await client.close();
});

test("cursor_run_local_agent forwards local options", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  const mcpServers = {
    docs: {
      type: "http",
      url: "https://mcp.example.test",
      headers: { authorization: "Bearer test" },
    },
  };
  const agents = {
    reviewer: {
      description: "Review code",
      prompt: "Review the changes",
      model: "inherit",
      mcpServers: ["docs"],
    },
  };

  const res = await client.callTool({
    name: "cursor_run_local_agent",
    arguments: {
      prompt: "Refactor the server",
      cwd: ["/tmp/work-a", "/tmp/work-b"],
      model: "auto",
      mode: "agent",
      settingSources: ["project", "user", "plugins"],
      mcpServers,
      agents,
      sandboxOptions: { enabled: true },
      autoReview: true,
      name: "Local refactor",
    },
  });

  assert.equal(res.isError ?? false, false);
  const call = service.calls.find((c) => c.method === "runLocalAgent");
  assert.deepEqual(call?.params, {
    prompt: "Refactor the server",
    cwd: ["/tmp/work-a", "/tmp/work-b"],
    model: "auto",
    mode: "agent",
    settingSources: ["project", "user", "plugins"],
    mcpServers,
    agents,
    sandboxOptions: { enabled: true },
    autoReview: true,
    name: "Local refactor",
  });
  await client.close();
});

test("cursor_run_cloud_agent forwards cloud options", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  const repos: CloudRepositoryInput[] = [
    { url: "https://github.com/example/repo", startingRef: "main", prUrl: "https://github.com/example/repo/pull/1" },
  ];
  const mcpServers = {
    shell: {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TEST_MODE: "1" },
    },
  };

  const res = await client.callTool({
    name: "cursor_run_cloud_agent",
    arguments: {
      prompt: "Add auth middleware tests",
      model: "auto",
      mode: "agent",
      name: "Cloud auth tests",
      repos,
      env: { type: "cloud", name: "default" },
      workOnCurrentBranch: true,
      autoCreatePR: true,
      skipReviewerRequest: true,
      envVars: { FOO: "bar" },
      mcpServers,
      agents: {
        reviewer: {
          description: "Review code",
          prompt: "Review the changes",
          model: "composer-2.5",
        },
      },
      idempotencyKey: "idem-123",
    },
  });

  assert.equal(res.isError ?? false, false);
  const call = service.calls.find((c) => c.method === "runCloudAgent");
  assert.deepEqual(call?.params, {
    prompt: "Add auth middleware tests",
    model: "auto",
    mode: "agent",
    name: "Cloud auth tests",
    repos,
    env: { type: "cloud", name: "default" },
    workOnCurrentBranch: true,
    autoCreatePR: true,
    skipReviewerRequest: true,
    envVars: { FOO: "bar" },
    mcpServers,
    agents: {
      reviewer: {
        description: "Review code",
        prompt: "Review the changes",
        model: "composer-2.5",
      },
    },
    idempotencyKey: "idem-123",
  });
  await client.close();
});

test("cursor_run_cloud_agent rejects stdio MCP cwd", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  let surfacedError = false;
  try {
    const res = await client.callTool({
      name: "cursor_run_cloud_agent",
      arguments: {
        prompt: "Try invalid cloud MCP",
        mcpServers: {
          shell: {
            type: "stdio",
            command: "node",
            cwd: "/tmp/mcp",
          },
        },
      },
    });
    surfacedError = res.isError === true;
  } catch {
    surfacedError = true;
  }
  assert.equal(surfacedError, true);
  assert.equal(service.calls.some((c) => c.method === "runCloudAgent"), false);
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

test("lifecycle tools forward query parameters", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);

  await client.callTool({
    name: "cursor_get_agent",
    arguments: { agentId: "agent-local-test", runtime: "local", cwd: "/tmp/work" },
  });
  await client.callTool({
    name: "cursor_list_runs",
    arguments: { agentId: "agent-local-test", runtime: "local", cwd: "/tmp/work" },
  });
  await client.callTool({
    name: "cursor_get_run",
    arguments: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud" },
  });
  const cancelRes = await client.callTool({
    name: "cursor_cancel_run",
    arguments: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud" },
  });

  assert.deepEqual(cancelRes.structuredContent, { cancelled: true });
  assert.deepEqual(service.calls.filter((c) => c.method.startsWith("get") || c.method === "listRuns" || c.method === "cancelRun"), [
    { method: "getAgent", params: { agentId: "agent-local-test", runtime: "local", cwd: "/tmp/work", runId: undefined } },
    { method: "listRuns", params: { agentId: "agent-local-test", runtime: "local", cwd: "/tmp/work", runId: undefined } },
    { method: "getRun", params: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud", cwd: undefined } },
    { method: "cancelRun", params: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud", cwd: undefined } },
  ]);
  await client.close();
});

test("lifecycle tools infer cloud runtime from bc agent ids", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);

  await client.callTool({
    name: "cursor_list_runs",
    arguments: { agentId: "bc-agent-cloud-test" },
  });
  await client.callTool({
    name: "cursor_get_run",
    arguments: { agentId: "bc-agent-cloud-test", runId: "run-1" },
  });
  await client.callTool({
    name: "cursor_cancel_run",
    arguments: { agentId: "bc-agent-cloud-test", runId: "run-1" },
  });

  assert.deepEqual(service.calls, [
    { method: "listRuns", params: { agentId: "bc-agent-cloud-test", runId: undefined, runtime: "cloud", cwd: undefined } },
    { method: "getRun", params: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud", cwd: undefined } },
    { method: "cancelRun", params: { agentId: "bc-agent-cloud-test", runId: "run-1", runtime: "cloud", cwd: undefined } },
  ]);
  await client.close();
});

test("run-specific lifecycle tools require runId at validation time", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);
  let surfacedError = false;
  try {
    const res = await client.callTool({
      name: "cursor_get_run",
      arguments: { agentId: "agent-local-test" },
    });
    surfacedError = res.isError === true;
  } catch {
    surfacedError = true;
  }
  assert.equal(surfacedError, true);
  assert.equal(service.calls.some((c) => c.method === "getRun"), false);
  await client.close();
});

test("artifact tools list metadata and return base64 content", async () => {
  const service = new FakeCursorService();
  const client = await connect(service);

  const listRes = await client.callTool({
    name: "cursor_list_artifacts",
    arguments: { agentId: "bc-agent-cloud-test" },
  });
  assert.deepEqual(listRes.structuredContent, {
    artifacts: [{ path: "summary.md", sizeBytes: 14, updatedAt: "2026-06-24T00:00:00.000Z" }],
  });

  const downloadRes = await client.callTool({
    name: "cursor_download_artifact",
    arguments: { agentId: "bc-agent-cloud-test", path: "summary.md" },
  });
  assert.deepEqual(downloadRes.structuredContent, {
    agentId: "bc-agent-cloud-test",
    path: "summary.md",
    contentBase64: Buffer.from("# summary.md\n").toString("base64"),
  });
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
