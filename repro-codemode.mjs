#!/usr/bin/env node
/**
 * Repro driver targeting a codemode-wrapped MCP server (the bridge worker).
 * Calls the `code` tool with `async () => codemode.dump_content({content: "A".repeat(N)})`.
 *
 * This exercises the codemode runtime → upstream MCP path that pka-portal
 * uses to talk to pka-mcp-hub, isolating H3 (codemode client request shape)
 * as the load-bearing differentiator vs the SDK transport.
 *
 * Usage: node repro-codemode.mjs <bridge-url> [content-size-bytes]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
const size = Number(process.argv[3] ?? 24576);
if (!url) {
  console.error("Usage: node repro-codemode.mjs <bridge-url> [content-size-bytes]");
  process.exit(2);
}

const code = `async () => { const r = await codemode.dump_content({ content: "A".repeat(${size}) }); return r; }`;

console.log(`→ target:  ${url}`);
console.log(`→ via:     codemode \`code\` tool → upstream dump_content`);
console.log(`→ payload: content=${size} bytes ('A' repeated)`);
console.log("");

const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client(
  { name: "mcp-1433-repro-codemode-driver", version: "0.0.0" },
  { capabilities: {} }
);

const t0 = Date.now();
try {
  await client.connect(transport);
  console.log(`✓ initialize ok (${Date.now() - t0} ms)`);
  const t1 = Date.now();
  const result = await client.callTool({
    name: "code",
    arguments: { code }
  });
  const elapsed = Date.now() - t1;
  const text = result?.content?.[0]?.text ?? JSON.stringify(result);
  console.log(`✓ code-tool ok (${elapsed} ms)`);
  console.log(`  result: ${text}`);
  await client.close();
  process.exit(0);
} catch (err) {
  const elapsed = Date.now() - t0;
  console.error(`✗ FAILED after ${elapsed} ms`);
  console.error(`  name:    ${err?.name ?? "?"}`);
  console.error(`  message: ${err?.message ?? String(err)}`);
  if (err?.cause) {
    console.error(`  cause:   ${err.cause?.code ?? ""} ${err.cause?.message ?? err.cause}`);
  }
  const blob = `${err?.message ?? ""} ${err?.cause?.message ?? ""} ${err?.cause?.code ?? ""}`;
  if (/record_overflow|ERR_SSL|EPROTO|ECONNRESET/i.test(blob)) {
    console.error("");
    console.error("→ This is the cloudflare/agents#1433 signature.");
  }
  process.exit(1);
}
