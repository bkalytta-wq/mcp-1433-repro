/**
 * Codemode-bridge variant of the minimal repro for cloudflare/agents#1433.
 *
 * Mirrors the pka-portal pattern as closely as possible from outside the
 * actual pka-portal source: a Cloudflare Worker that exposes a single
 * codemode `code` tool. The codemode runtime, when called with JS, can
 * invoke any of an upstream remote MCP server's tools by name. The upstream
 * here is `mcp-1433-repro-hono` — same custom-domain-less Hono+Bearer wrapper
 * that already passes 500 KB cleanly when called via `@modelcontextprotocol/sdk`.
 *
 * H3 test: if `code: () => codemode.dump_content({content: "A".repeat(24576)})`
 * routed through this bridge fails with `record_overflow`, but a direct SDK
 * call to the same upstream passes (which it does — see EVIDENCE.md row 7),
 * then codemode itself is the load-bearing differentiator.
 *
 * Bridge implementation: a local `McpServer` whose tools each proxy to the
 * remote upstream via `StreamableHTTPClientTransport`, then wrapped with
 * `codeMcpServer()` from `@cloudflare/codemode/mcp`. The proxy + codemode
 * wrap are stood up per-request so every test starts from a clean session.
 */
import { createMcpHandler } from "agents/mcp";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { z } from "zod";

// Two upstream targets — the bridge picks based on the BRIDGE_MODE env var.
//   svc       → service binding to mcp-1433-repro-hono (no public edge hop)
//   public    → fetch over the public edge to mcp-1433-hono.bacarda.de
//                (custom domain on bacarda.de zone) — closest replica of the
//                pka-portal → mcp.bacarda.de path
// Default: public.
const UPSTREAM_PUBLIC_URL = "https://mcp-1433-hono.bacarda.de/mcps/dump/mcp";
const UPSTREAM_SVC_URL =
  "https://mcp-1433-repro-hono.bastian-enterprise.workers.dev/mcps/dump/mcp";
const UPSTREAM_BEARER = "mcp-1433-test-token";

/**
 * Connect to the upstream MCP server, list its tools, build a local
 * `McpServer` that proxies each one. We re-use the upstream client across
 * tool invocations *within* one bridge request — codemode dispatches
 * multiple tool calls back to the proxy server inside the sandbox, and we
 * want them on the same upstream session.
 */
async function buildProxyServer(env: Env, mode: "svc" | "public"): Promise<McpServer> {
  const upstream = new McpClient(
    { name: "codemode-bridge-upstream-client", version: "0.0.0" },
    { capabilities: {} }
  );
  const upstreamUrl = mode === "svc" ? UPSTREAM_SVC_URL : UPSTREAM_PUBLIC_URL;
  const upstreamService = env.UPSTREAM as Fetcher | undefined;

  const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${UPSTREAM_BEARER}` }
    },
    fetch: (u, init) => {
      const merged = new Headers(init?.headers ?? {});
      merged.set("Authorization", `Bearer ${UPSTREAM_BEARER}`);
      const req = new Request(u, { ...init, headers: merged });
      // svc mode: route through the service binding to avoid the
      // workers.dev→workers.dev CF 1042 block. public mode: use global fetch
      // — workers.dev→custom-zone IS allowed, this is the closest replica
      // of the pka-portal → mcp.bacarda.de path.
      return mode === "svc" && upstreamService
        ? upstreamService.fetch(req)
        : fetch(req);
    }
  });
  await upstream.connect(transport);

  const proxy = new McpServer({
    name: "codemode-bridge-proxy",
    version: "0.0.0"
  });
  const { tools } = await upstream.listTools();

  for (const t of tools) {
    // Build a Zod "raw shape" (Record<string, ZodType>) from the upstream's
    // JSON Schema property names. We use z.any() for every prop — runtime
    // validation isn't the point here; we just need the SDK's registerTool
    // to accept it. codemode generates its sandbox-side types from the
    // upstream's actual JSON Schema (via the `inputSchema` we still emit
    // on `tool.inputSchema` after registration via the McpServer's metadata).
    const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>;
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const k of Object.keys(props)) shape[k] = z.any();

    proxy.registerTool(
      t.name,
      {
        description: t.description ?? "",
        inputSchema: shape
      },
      async (args: Record<string, unknown>) => {
        const r = await upstream.callTool({
          name: t.name,
          arguments: args
        });
        return r as never;
      }
    );
  }
  return proxy;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Mode is selected by request path: /mcp/svc routes through the
    // service binding; /mcp/public (and the bare /mcp default) fetches
    // over the public edge to mcp-1433-hono.bacarda.de.
    let mode: "svc" | "public" = "public";
    if (url.pathname === "/mcp/svc" || url.pathname.startsWith("/mcp/svc/")) {
      mode = "svc";
    }

    // Diagnostic: probe upstream connectivity from inside the worker
    if (url.pathname === "/diag") {
      try {
        const upstreamService = env.UPSTREAM as Fetcher;
        const r = await upstreamService.fetch(new Request(UPSTREAM_SVC_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${UPSTREAM_BEARER}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "diag", version: "0" }
            }
          })
        }));
        const text = await r.text();
        return new Response(
          JSON.stringify({ status: r.status, sessionId: r.headers.get("mcp-session-id"), bodySnippet: text.slice(0, 400) }, null, 2),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: String(e), name: (e as Error)?.name, cause: String((e as Error)?.cause) }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      try {
        const proxy = await buildProxyServer(env, mode);
        const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
        const wrapped = await codeMcpServer({ server: proxy, executor });
        // The MCP handler must see the route the client called against.
        const route = mode === "svc" ? "/mcp/svc" : "/mcp";
        return createMcpHandler(wrapped, { route })(request, env, ctx);
      } catch (e) {
        const err = e as Error;
        return new Response(
          JSON.stringify({ error: err.message, name: err.name, stack: err.stack?.slice(0, 1000), cause: String(err.cause) }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      'Use POST /mcp (public edge) or /mcp/svc (service binding). Codemode tool: "code". GET /diag.\n',
      { status: 404 }
    );
  }
};
