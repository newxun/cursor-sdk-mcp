#!/usr/bin/env node
/**
 * Entry point: starts the Cursor SDK MCP server over stdio.
 *
 * MCP clients such as Claude Code spawn this process and speak JSON-RPC over
 * stdin/stdout. Authentication uses the CURSOR_API_KEY environment variable.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CursorSdkService } from "./cursor.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const service = new CursorSdkService({
    apiKey: process.env.CURSOR_API_KEY,
    defaultModel: process.env.CURSOR_MCP_DEFAULT_MODEL ?? "auto",
  });

  const server = createServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Logs MUST go to stderr; stdout is reserved for the JSON-RPC protocol.
  if (!process.env.CURSOR_API_KEY) {
    console.error(
      "[cursor-sdk-mcp] Warning: CURSOR_API_KEY is not set. Tools will return an auth error until it is configured.",
    );
  }
  console.error("[cursor-sdk-mcp] Server running on stdio.");
}

main().catch((error) => {
  console.error("[cursor-sdk-mcp] Fatal error:", error);
  process.exit(1);
});
