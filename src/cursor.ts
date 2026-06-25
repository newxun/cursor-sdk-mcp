/**
 * Thin, normalized wrapper around `@cursor/sdk`.
 *
 * The MCP layer depends only on the {@link CursorService} interface, never on
 * the SDK's internal types. This keeps the tool handlers small and lets tests
 * inject a fake backend without touching the network.
 */
import { Agent, Cursor } from "@cursor/sdk";
import type {
  AgentDefinition,
  McpServerConfig,
  Run,
  RunResult,
  SettingSource,
} from "@cursor/sdk";

export type ConversationMode = "agent" | "plan";

export type { SettingSource };

export type McpServerInput = McpServerConfig;

export interface AgentDefinitionInput {
  description: string;
  prompt: string;
  model?: string | "inherit";
  mcpServers?: Array<string | Record<string, McpServerInput>>;
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

export interface FollowUpParams {
  agentId: string;
  prompt: string;
  model?: string;
  runtime?: "local" | "cloud";
  cwd?: string;
}

export interface AgentRunResult {
  agentId: string;
  status: string;
  result: string;
  durationMs?: number;
  requestId?: string;
  model?: string;
  git?: unknown;
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
  runtime?: "local" | "cloud";
  cwd?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

export interface WhoAmI {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
}

/**
 * The operations the MCP server exposes. Implemented by {@link CursorSdkService}
 * for production and by fakes in tests.
 */
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

export interface CursorServiceOptions {
  /** Cursor API key. When omitted, calls fail with a clear, actionable error. */
  apiKey?: string;
  /** Model id used when a call does not specify one. Defaults to "auto". */
  defaultModel?: string;
}

/**
 * Disposes an agent handle regardless of whether the SDK build exposes
 * `Symbol.asyncDispose` or only `close()`.
 */
async function disposeAgent(agent: {
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}): Promise<void> {
  const asyncDispose = agent[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") {
    await asyncDispose.call(agent);
    return;
  }
  agent.close?.();
}

export class CursorSdkService implements CursorService {
  private readonly apiKey?: string;
  private readonly defaultModel: string;

  constructor(options: CursorServiceOptions = {}) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? "auto";
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error(
        "CURSOR_API_KEY is not set. Provide it as an environment variable so the Cursor SDK can authenticate. " +
          "Create a key at the Cursor Dashboard (API Keys) or Team settings (service account).",
      );
    }
    return this.apiKey;
  }

  async whoami(): Promise<WhoAmI> {
    const apiKey = this.requireApiKey();
    const user = await Cursor.me({ apiKey });
    return {
      apiKeyName: user.apiKeyName,
      userId: user.userId,
      userEmail: user.userEmail,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const apiKey = this.requireApiKey();
    const models = await Cursor.models.list({ apiKey });
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description,
    }));
  }

  private toSdkAgents(
    agents: Record<string, AgentDefinitionInput> | undefined,
  ): Record<string, AgentDefinition> | undefined {
    if (!agents) return undefined;
    return Object.fromEntries(
      Object.entries(agents).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          prompt: definition.prompt,
          model:
            definition.model === undefined
              ? undefined
              : definition.model === "inherit"
                ? "inherit"
                : { id: definition.model },
          mcpServers: definition.mcpServers,
        },
      ]),
    );
  }

  private formatRun(agentId: string, result: RunResult): AgentRunResult {
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

  private formatRunRecord(run: Run): Record<string, unknown> {
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      result: run.result,
      requestId: run.requestId,
      model: run.model,
      durationMs: run.durationMs,
      git: run.git,
      createdAt: run.createdAt,
    };
  }

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
      agents: this.toSdkAgents(params.agents),
    });
    try {
      const run = await agent.send(params.prompt);
      const result = await run.wait();
      return this.formatRun(agent.agentId, result);
    } finally {
      await disposeAgent(agent);
    }
  }

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
      agents: this.toSdkAgents(params.agents),
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

  async followUp(params: FollowUpParams): Promise<AgentRunResult> {
    const agent = await Agent.resume(params.agentId, this.resumeOptions(params));
    try {
      const run = await agent.send(
        params.prompt,
        params.model ? { model: { id: params.model } } : undefined,
      );
      const result = await run.wait();
      return this.formatRun(agent.agentId, result);
    } finally {
      await disposeAgent(agent);
    }
  }

  async getAgent(params: QueryRunParams): Promise<unknown> {
    return Agent.get(params.agentId, {
      cwd: params.cwd,
      apiKey: this.apiKey,
    });
  }

  private runtimeFor(params: QueryRunParams): "local" | "cloud" {
    return params.runtime ?? (params.agentId.startsWith("bc-") ? "cloud" : "local");
  }

  private resumeOptions(params: {
    agentId: string;
    runtime?: "local" | "cloud";
    cwd?: string;
  }): Parameters<typeof Agent.resume>[1] {
    const options: NonNullable<Parameters<typeof Agent.resume>[1]> = {
      apiKey: this.requireApiKey(),
    };
    if (this.runtimeFor(params) === "local" && params.cwd) {
      options.local = { cwd: params.cwd };
    }
    return options;
  }

  async listRuns(params: QueryRunParams): Promise<unknown> {
    if (this.runtimeFor(params) === "cloud") {
      const runs = await Agent.listRuns(params.agentId, {
        runtime: "cloud",
        apiKey: this.requireApiKey(),
      });
      return {
        ...runs,
        items: runs.items.map((run) => this.formatRunRecord(run)),
      };
    }
    const runs = await Agent.listRuns(params.agentId, {
      runtime: "local",
      cwd: params.cwd,
    });
    return {
      ...runs,
      items: runs.items.map((run) => this.formatRunRecord(run)),
    };
  }

  private getRunOptions(params: QueryRunParams): Parameters<typeof Agent.getRun>[1] {
    if (this.runtimeFor(params) === "cloud") {
      return {
        runtime: "cloud",
        agentId: params.agentId,
        apiKey: this.requireApiKey(),
      };
    }
    return {
      runtime: "local",
      cwd: params.cwd,
    };
  }

  async getRun(params: QueryRunParams): Promise<Record<string, unknown>> {
    if (!params.runId) {
      throw new Error("runId is required.");
    }
    const run = await Agent.getRun(params.runId, this.getRunOptions(params));
    return this.formatRunRecord(run);
  }

  async cancelRun(params: QueryRunParams): Promise<void> {
    if (!params.runId) {
      throw new Error("runId is required.");
    }
    const run = await Agent.getRun(params.runId, this.getRunOptions(params));
    await run.cancel();
  }

  async listArtifacts(params: ArtifactParams): Promise<unknown[]> {
    const agent = await Agent.resume(params.agentId, this.resumeOptions(params));
    try {
      return agent.listArtifacts();
    } finally {
      await disposeAgent(agent);
    }
  }

  async downloadArtifact(params: ArtifactParams & { path: string }): Promise<Buffer> {
    const agent = await Agent.resume(params.agentId, this.resumeOptions(params));
    try {
      return agent.downloadArtifact(params.path);
    } finally {
      await disposeAgent(agent);
    }
  }
}
