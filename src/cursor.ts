/**
 * Thin, normalized wrapper around `@cursor/sdk`.
 *
 * The MCP layer depends only on the {@link CursorService} interface, never on
 * the SDK's internal types. This keeps the tool handlers small and lets tests
 * inject a fake backend without touching the network.
 */
import { Agent, Cursor } from "@cursor/sdk";

export type ConversationMode = "agent" | "plan";

export interface RunAgentParams {
  prompt: string;
  cwd: string;
  model?: string;
  mode?: ConversationMode;
}

export interface FollowUpParams {
  agentId: string;
  prompt: string;
  model?: string;
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
  runAgent(params: RunAgentParams): Promise<AgentRunResult>;
  followUp(params: FollowUpParams): Promise<AgentRunResult>;
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

  async runAgent(params: RunAgentParams): Promise<AgentRunResult> {
    const apiKey = this.requireApiKey();
    const agent = await Agent.create({
      apiKey,
      model: { id: params.model ?? this.defaultModel },
      mode: params.mode,
      local: { cwd: params.cwd },
    });
    try {
      const run = await agent.send(params.prompt);
      const result = await run.wait();
      return {
        agentId: agent.agentId,
        status: result.status,
        result: result.result ?? "",
        durationMs: result.durationMs,
        requestId: result.requestId,
        model: result.model?.id,
        git: result.git,
      };
    } finally {
      await disposeAgent(agent);
    }
  }

  async followUp(params: FollowUpParams): Promise<AgentRunResult> {
    const apiKey = this.requireApiKey();
    const agent = await Agent.resume(params.agentId, { apiKey });
    try {
      const run = await agent.send(
        params.prompt,
        params.model ? { model: { id: params.model } } : undefined,
      );
      const result = await run.wait();
      return {
        agentId: agent.agentId,
        status: result.status,
        result: result.result ?? "",
        durationMs: result.durationMs,
        requestId: result.requestId,
        model: result.model?.id,
        git: result.git,
      };
    } finally {
      await disposeAgent(agent);
    }
  }
}
