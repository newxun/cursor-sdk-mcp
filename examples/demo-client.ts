/**
 * End-to-end demo: spawn the built MCP server over stdio (exactly how Claude
 * Code launches it), list its tools, and call safe read-only operations.
 *
 *   npm run build
 *   npm run demo                 # lists tools, calls whoami + list_models
 *   RUN_AGENT=1 npm run demo     # additionally runs a real local Cursor Agent
 *
 * Requires CURSOR_API_KEY for the calls that hit Cursor's backend.
 */
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: cleanEnv(),
    stderr: "inherit",
  });

  const client = new Client({ name: "cursor-sdk-mcp-demo", version: "0.1.0" });
  await client.connect(transport);

  console.log("\n=== Connected. Tools advertised by the server ===");
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`- ${tool.name}: ${tool.description?.split("\n")[0] ?? ""}`);
  }

  const hasKey = Boolean(process.env.CURSOR_API_KEY);
  console.log(`\nCURSOR_API_KEY present: ${hasKey ? "yes" : "no"}`);

  console.log("\n=== cursor_whoami ===");
  console.log(textOf(await client.callTool({ name: "cursor_whoami", arguments: {} })));

  console.log("\n=== cursor_list_models ===");
  console.log(textOf(await client.callTool({ name: "cursor_list_models", arguments: {} })));

  if (process.env.RUN_AGENT === "1" && hasKey) {
    const workdir = mkdtempSync(join(tmpdir(), "cursor-mcp-demo-"));
    console.log(`\n=== cursor_run_local_agent (workdir: ${workdir}) ===`);
    // Passing `onprogress` makes the SDK attach a progressToken to the request,
    // so the server streams the agent's steps back as live progress.
    const run = await client.callTool(
      {
        name: "cursor_run_local_agent",
        arguments: {
          prompt:
            "Create a file named hello.txt in the current directory containing exactly the text: " +
            "Hello from Cursor Agent via MCP. Then stop.",
          cwd: workdir,
          settingSources: ["project", "user", "plugins"],
        },
      },
      undefined,
      {
        onprogress: (p) => {
          if (p.message) console.log(`  · ${p.message}`);
        },
      },
    );
    console.log(textOf(run));
    try {
      const contents = await readFile(join(workdir, "hello.txt"), "utf8");
      console.log(`\n--- hello.txt contents ---\n${contents}`);
    } catch {
      console.log("\n(hello.txt was not created)");
    }
  } else {
    console.log(
      "\n(Skipping cursor_run_local_agent. Set RUN_AGENT=1 and CURSOR_API_KEY to run a real agent.)",
    );
  }

  await client.close();
  console.log("\n=== Demo complete ===");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
