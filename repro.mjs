#!/usr/bin/env node
/**
 * Repro driver for cloudflare/agents#1433.
 *
 * Usage: node repro.mjs <worker-url> [content-size-bytes]
 *   <worker-url>           e.g. https://mcp-1433-repro.<subdomain>.workers.dev/mcp
 *   [content-size-bytes]   default 24576 (24 KiB) — large enough to overflow
 *                          the cf-mcp-message header on the Worker→DO hop.
 *
 * Optional Cloudflare Access service-token auth (set both env vars):
 *   CF_ACCESS_CLIENT_ID=<id>.access
 *   CF_ACCESS_CLIENT_SECRET=<secret>
 * When set, both headers are forwarded on every request via custom fetch.
 *
 * Exits 0 on tools/call success, 1 on any failure (incl. TLS record_overflow).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
const size = Number(process.argv[3] ?? 24576);

if (!url) {
  console.error("Usage: node repro.mjs <worker-url> [content-size-bytes]");
  process.exit(2);
}

const content = "A".repeat(size);
const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const accessHeaders =
  accessId && accessSecret
    ? {
        "CF-Access-Client-Id": accessId,
        "CF-Access-Client-Secret": accessSecret
      }
    : undefined;

console.log(`→ target:  ${url}`);
console.log(`→ payload: content=${size} bytes ('A' repeated)`);
if (accessHeaders) console.log("→ auth:    CF Access service-token (headers attached)");
console.log("");

const transportOpts = accessHeaders
  ? {
      requestInit: { headers: accessHeaders },
      // The MCP SDK uses a separate fetch for SSE; pre-bind the headers there too.
      fetch: (u, init) =>
        fetch(u, {
          ...init,
          headers: { ...(init?.headers ?? {}), ...accessHeaders }
        })
    }
  : undefined;

const transport = new StreamableHTTPClientTransport(new URL(url), transportOpts);
const client = new Client(
  { name: "mcp-1433-repro-driver", version: "0.0.0" },
  { capabilities: {} }
);

const t0 = Date.now();
try {
  await client.connect(transport);
  console.log(`✓ initialize ok (${Date.now() - t0} ms)`);

  const t1 = Date.now();
  const result = await client.callTool({
    name: "dump_content",
    arguments: { content }
  });
  const elapsed = Date.now() - t1;

  const text = result?.content?.[0]?.text ?? "";
  console.log(`✓ tools/call ok (${elapsed} ms)`);
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
  // Surface TLS record_overflow signature explicitly.
  const blob = `${err?.message ?? ""} ${err?.cause?.message ?? ""} ${err?.cause?.code ?? ""}`;
  if (/record_overflow|ERR_SSL|EPROTO|ECONNRESET/i.test(blob)) {
    console.error("");
    console.error("→ This looks like the cloudflare/agents#1433 signature:");
    console.error("  the streamable-HTTP transport stuffs the JSON-RPC body into the");
    console.error("  cf-mcp-message header (base64). Headers >~32 KB at the edge cause");
    console.error("  TLSv1.3 record_overflow on the Worker→DO hop.");
  }
  process.exit(1);
}
