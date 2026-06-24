# Full Cursor Agent MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `cursor-sdk-mcp` into a convenient MCP server that exposes the practical full Cursor Agent SDK surface for local and cloud coding workflows.

**Architecture:** Keep MCP handlers in `src/server.ts` thin and delegate all Cursor SDK behavior through a richer `CursorService` interface in `src/cursor.ts`. Add focused tool inputs for local agents, cloud agents, follow-ups, run inspection, cancellation, and artifacts so MCP clients can use Cursor account MCP, project MCP, subagents, sandboxing, auto-review, and cloud PR workflows without constructing raw SDK calls.

**Tech Stack:** TypeScript, `@cursor/sdk`, `@modelcontextprotocol/sdk`, `zod`, Node test runner, `tsx`, npm.

---

## Product target

The target user experience is:

- A user configures Cursor MCP servers and skills in Cursor locations such as `.cursor/mcp.json`, `~/.cursor/mcp.json`, `.cursor/skills/`, `.agents/skills/`, or `cursor.com/agents`.
- Any MCP client can call this server and ask Cursor Agent to code.
- Local mode can conveniently load project/user/plugin Cursor MCP configuration.
- Cloud mode can conveniently use Cursor-hosted or self-hosted Cloud Agents, account/team MCP from `cursor.com/agents`, repo cloning, PR creation, artifacts, and durable follow-ups.
- Defaults are ergonomic: `model` defaults to `"auto"`, local runs can opt into `settingSources`, cloud runs use Cursor account/team MCP by default, and advanced safety options remain explicit.

## File map

- Modify `src/cursor.ts`: expand service types and implement richer `CursorSdkService` methods around `Agent`, `Cursor.models`, and cloud/local run operations.
- Modify `src/server.ts`: register new MCP tools, input schemas, result formatting, and error behavior.
- Modify `tests/server.test.ts`: add fake service coverage for each new tool and schema behavior.
- Modify `examples/demo-client.ts`: demonstrate local and cloud-capable tool listing plus safe local calls.
- Modify `README.md`: document setup, local mode, cloud mode, Cursor account MCP usage, skills locations, safety presets, and smoke tests.
- Optionally create `src/schemas.ts`: extract shared zod schemas if `src/server.ts` becomes too large during implementation.

---

### Task 1: Expand service contracts for full agent operations

**Files:**
- Modify: `src/cursor.ts`
- Test: `tests/server.test.ts`

- [x] **Step 1: Add service parameter and result types**

Add exported types for local runs, cloud runs, follow-ups, run queries, cancellation, and artifact downloads:

```typescript
export type SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";

export interface McpServerInput {
  type?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: Record<string, unknown>;
}

export interface AgentDefinitionInput {
  description: string;
  prompt: string;
  model?: string | "inherit";
  mcpServers?: string[];
}

export interface RunLocalAgentParams {
  prompt: string;
  cwd: string | string[];
  model?: string;
  mode?: ConversationMode;
  settingSources?: SettingSource[];
  mcpServers?: Record<string, McpServerInput>;
  agents?: Record<string, AgentDefinitionInput>;
  sandboxOptions?: { enabled: boolean };
  autoReview?: boolean;
  name?: string;
}

export interface CloudRepositoryInput {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export interface RunCloudAgentParams {
  prompt: string;
  model?: string;
  mode?: ConversationMode;
  name?: string;
  repos?: CloudRepositoryInput[];
  env?: { type: "cloud" | "pool" | "machine"; name?: string };
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  envVars?: Record<string, string>;
  mcpServers?: Record<string, McpServerInput>;
  agents?: Record<string, AgentDefinitionInput>;
  idempotencyKey?: string;
}

export interface QueryRunParams {
  agentId: string;
  runId?: string;
  runtime?: "local" | "cloud";
  cwd?: string;
}

export interface ArtifactParams {
  agentId: string;
  path?: string;
}
```

- [x] **Step 2: Replace the narrow service interface**

Update `CursorService` so production and fake services expose:

```typescript
export interface CursorService {
  whoami(): Promise<WhoAmI>;
  listModels(): Promise<ModelInfo[]>;
  runLocalAgent(params: RunLocalAgentParams): Promise<AgentRunResult>;
  runCloudAgent(params: RunCloudAgentParams): Promise<AgentRunResult>;
  followUp(params: FollowUpParams): Promise<AgentRunResult>;
  getAgent(params: QueryRunParams): Promise<unknown>;
  listRuns(params: QueryRunParams): Promise<unknown>;
  getRun(params: QueryRunParams): Promise<unknown>;
  cancelRun(params: QueryRunParams): Promise<void>;
  listArtifacts(params: ArtifactParams): Promise<unknown[]>;
  downloadArtifact(params: ArtifactParams & { path: string }): Promise<Buffer>;
}
```

- [x] **Step 3: Run typecheck and capture expected failures**

Run: `npm run typecheck`

Expected: FAIL until `CursorSdkService`, `src/server.ts`, and tests implement the new interface.

---

### Task 2: Implement local agent support

**Files:**
- Modify: `src/cursor.ts`
- Test: `tests/server.test.ts`

- [x] **Step 1: Add local implementation**

Implement `CursorSdkService.runLocalAgent()` with `Agent.create()`:

```typescript
async runLocalAgent(params: RunLocalAgentParams): Promise<AgentRunResult> {
  const apiKey = this.requireApiKey();
  const agent = await Agent.create({
    apiKey,
    name: params.name,
    model: { id: params.model ?? this.defaultModel },
    mode: params.mode,
    local: {
      cwd: params.cwd,
      settingSources: params.settingSources,
      sandboxOptions: params.sandboxOptions,
      autoReview: params.autoReview,
    },
    mcpServers: params.mcpServers,
    agents: params.agents,
  });
  try {
    const run = await agent.send(params.prompt);
    const result = await run.wait();
    return this.formatRun(agent.agentId, result);
  } finally {
    await disposeAgent(agent);
  }
}
```

- [x] **Step 2: Add a private formatter**

Add a helper so local, cloud, and follow-up all return the same shape:

```typescript
private formatRun(agentId: string, result: {
  status: string;
  result?: string;
  durationMs?: number;
  requestId?: string;
  model?: { id?: string };
  git?: unknown;
}): AgentRunResult {
  return {
    agentId,
    status: result.status,
    result: result.result ?? "",
    durationMs: result.durationMs,
    requestId: result.requestId,
    model: result.model?.id,
    git: result.git,
  };
}
```

- [x] **Step 3: Preserve backward compatibility**

Keep the existing `cursor_run_agent` MCP tool as a compatibility alias that calls `runLocalAgent()` with `{ prompt, cwd, model, mode }`.

- [x] **Step 4: Run the targeted tests**

Run: `npm test`

Expected: FAIL until server tool schemas and fake service are updated.

---

### Task 3: Implement cloud agent support

**Files:**
- Modify: `src/cursor.ts`
- Test: `tests/server.test.ts`

- [x] **Step 1: Add cloud implementation**

Implement `CursorSdkService.runCloudAgent()` with `Agent.create()`:

```typescript
async runCloudAgent(params: RunCloudAgentParams): Promise<AgentRunResult> {
  const apiKey = this.requireApiKey();
  const agent = await Agent.create({
    apiKey,
    name: params.name,
    model: { id: params.model ?? this.defaultModel },
    mode: params.mode,
    cloud: {
      env: params.env,
      repos: params.repos,
      workOnCurrentBranch: params.workOnCurrentBranch,
      autoCreatePR: params.autoCreatePR,
      skipReviewerRequest: params.skipReviewerRequest,
      envVars: params.envVars,
    },
    mcpServers: params.mcpServers,
    agents: params.agents,
    idempotencyKey: params.idempotencyKey,
  });
  try {
    const run = await agent.send(params.prompt);
    const result = await run.wait();
    return this.formatRun(agent.agentId, result);
  } finally {
    await disposeAgent(agent);
  }
}
```

- [x] **Step 2: Support no-repo cloud agents**

Allow `repos` to be omitted so callers can create cloud agents with an empty workspace or named cloud environment.

- [x] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: FAIL only if SDK option names differ from this plan; adjust to the installed `@cursor/sdk` declarations instead of casting to `any`.

---

### Task 4: Add run inspection, cancellation, and artifacts

**Files:**
- Modify: `src/cursor.ts`
- Test: `tests/server.test.ts`

- [x] **Step 1: Implement agent and run inspection**

Add wrappers around `Agent.get()`, `Agent.listRuns()`, and `Agent.getRun()`:

```typescript
async getAgent(params: QueryRunParams): Promise<unknown> {
  return Agent.get(params.agentId, {
    cwd: params.cwd,
    apiKey: this.apiKey,
  });
}

async listRuns(params: QueryRunParams): Promise<unknown> {
  return Agent.listRuns(params.agentId, {
    runtime: params.runtime,
    cwd: params.cwd,
    apiKey: this.apiKey,
  });
}

async getRun(params: QueryRunParams): Promise<unknown> {
  if (!params.runId) {
    throw new Error("runId is required.");
  }
  return Agent.getRun(params.runId, {
    runtime: params.runtime,
    agentId: params.agentId,
    cwd: params.cwd,
    apiKey: this.apiKey,
  });
}
```

- [x] **Step 2: Implement cancellation**

```typescript
async cancelRun(params: QueryRunParams): Promise<void> {
  if (!params.runId) {
    throw new Error("runId is required.");
  }
  const run = await Agent.getRun(params.runId, {
    runtime: params.runtime,
    agentId: params.agentId,
    cwd: params.cwd,
    apiKey: this.apiKey,
  });
  await run.cancel();
}
```

- [x] **Step 3: Implement artifacts via resume**

```typescript
async listArtifacts(params: ArtifactParams): Promise<unknown[]> {
  const agent = await Agent.resume(params.agentId, { apiKey: this.requireApiKey() });
  try {
    return agent.listArtifacts();
  } finally {
    await disposeAgent(agent);
  }
}

async downloadArtifact(params: ArtifactParams & { path: string }): Promise<Buffer> {
  const agent = await Agent.resume(params.agentId, { apiKey: this.requireApiKey() });
  try {
    return agent.downloadArtifact(params.path);
  } finally {
    await disposeAgent(agent);
  }
}
```

- [x] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS for `src/cursor.ts` or specific SDK declaration errors that must be fixed before continuing.

---

### Task 5: Register ergonomic MCP tools

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

- [x] **Step 1: Add shared zod schemas**

Add schemas for MCP servers, agent definitions, repositories, local options, and cloud options. Keep schemas explicit and reject ambiguous inputs.

- [x] **Step 2: Register `cursor_run_local_agent`**

Expose a local tool with description:

```text
Run a Cursor Agent locally against one or more working directories. The agent can read, edit, write, run shell commands, and use configured Cursor MCP servers. Use settingSources to load project, user, or plugin Cursor MCP configuration.
```

- [x] **Step 3: Register `cursor_run_cloud_agent`**

Expose a cloud tool with description:

```text
Run a Cursor Cloud Agent in a Cursor-hosted or self-hosted environment. Cloud agents can use Cursor account/team MCP from cursor.com/agents, clone repositories, push branches, create PRs, and produce artifacts.
```

- [x] **Step 4: Register lifecycle tools**

Add:

- `cursor_get_agent`
- `cursor_list_runs`
- `cursor_get_run`
- `cursor_cancel_run`
- `cursor_list_artifacts`
- `cursor_download_artifact`

- [x] **Step 5: Preserve existing tool names**

Keep:

- `cursor_whoami`
- `cursor_list_models`
- `cursor_run_agent`
- `cursor_follow_up`

Make `cursor_run_agent` call the same service method as `cursor_run_local_agent`.

- [x] **Step 6: Run integration tests**

Run: `npm test`

Expected: FAIL until fake service implements all new methods and assertions are added.

---

### Task 6: Extend tests with fake backend coverage

**Files:**
- Modify: `tests/server.test.ts`

- [x] **Step 1: Update fake service**

The fake service should record the last input for each operation and return deterministic outputs:

```typescript
const localRun = {
  agentId: "agent-local-test",
  status: "finished",
  result: "local ok",
  durationMs: 12,
  requestId: "req-local",
  model: "auto",
};
```

- [x] **Step 2: Test local tool passes full options**

Call `cursor_run_local_agent` with:

- `cwd`
- `settingSources: ["project", "user", "plugins"]`
- one inline HTTP MCP server
- `sandboxOptions: { enabled: true }`
- `autoReview: true`

Assert fake service received the same values.

- [x] **Step 3: Test cloud tool passes full options**

Call `cursor_run_cloud_agent` with:

- one repo
- `autoCreatePR: true`
- `envVars`
- one inline stdio MCP server
- `mode: "agent"`

Assert fake service received the same values.

- [x] **Step 4: Test lifecycle tools**

Exercise `cursor_get_agent`, `cursor_list_runs`, `cursor_get_run`, `cursor_cancel_run`, `cursor_list_artifacts`, and `cursor_download_artifact`.

- [x] **Step 5: Test auth errors still format cleanly**

Keep coverage that service errors return MCP `isError: true` responses with clear text.

- [x] **Step 6: Run tests**

Run: `npm test`

Expected: PASS.

---

### Task 7: Update demo and README

**Files:**
- Modify: `examples/demo-client.ts`
- Modify: `README.md`

- [x] **Step 1: Update demo client**

Make the demo list all tools and call safe read-only operations by default. Keep real agent execution behind `RUN_AGENT=1`.

- [x] **Step 2: Document local usage**

Add an example:

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

- [x] **Step 3: Document cloud usage**

Add an example:

```json
{
  "prompt": "Add tests for the auth middleware and open a PR.",
  "repos": [{ "url": "https://github.com/your-org/your-repo", "startingRef": "main" }],
  "model": "auto",
  "autoCreatePR": true
}
```

- [x] **Step 4: Document Cursor account MCP strategy**

Explain:

- Local uses inline MCP unless `local.settingSources` includes project/user/plugins.
- Cloud uses inline MCP plus user/team MCP from `cursor.com/agents`.
- OAuth MCP must already be authorized in Cursor for local reuse.

- [x] **Step 5: Document skills strategy**

Explain that Cursor skills should live in `.cursor/skills/`, `.agents/skills/`, `~/.cursor/skills/`, or `~/.agents/skills/`; Claude Code skills are not part of this integration goal.

- [ ] **Step 6: Run docs-safe demo**

Run: `npm run build && npm run demo`

Expected: PASS without `RUN_AGENT=1`; real Cursor Agent run remains opt-in.

---

### Task 8: Final verification and release handoff

**Files:**
- Modify only if tests reveal issues.

- [ ] **Step 1: Run full checks**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run demo`

Expected: PASS.

- [ ] **Step 2: Optional real Cursor smoke test**

With a valid API key, run:

```bash
CURSOR_API_KEY="$CURSOR_API_KEY" RUN_AGENT=1 npm run demo
```

Expected: Cursor Agent completes a small local task and returns a final assistant message.

- [ ] **Step 3: Optional cloud smoke test**

With a disposable test repo, call `cursor_run_cloud_agent` with `autoCreatePR: false`.

Expected: run finishes, `agentId` starts with a cloud prefix, and lifecycle tools can fetch the run.

- [ ] **Step 4: Commit**

```bash
git add src/cursor.ts src/server.ts tests/server.test.ts examples/demo-client.ts README.md
git commit -m "feat: expose full Cursor Agent SDK capabilities"
```

---

## Self-review checklist

- [ ] The implementation preserves current basic MCP tools.
- [ ] Local mode can load Cursor project/user/plugin MCP through `settingSources`.
- [ ] Cloud mode can use Cursor account/team MCP from `cursor.com/agents`.
- [ ] The API is convenient for MCP clients and does not require raw SDK knowledge for common paths.
- [ ] Safety controls are explicit and documented.
- [ ] Tests cover local, cloud, lifecycle, artifact, and error paths.
- [ ] README explains the difference between Cursor MCP/skills and Claude Code MCP/skills.
