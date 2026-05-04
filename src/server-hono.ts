/**
 * Hono-wrapped variant of the minimal repro for cloudflare/agents#1433.
 *
 * Shape deliberately mirrors pka-mcp-hub:
 *   - Hono `app` instance, multiple `app.use(...)` middlewares
 *   - Bearer-token middleware on /mcps/* + /mcp (constant-time-ish compare)
 *   - `app.all("/mcps/dump/mcp", ...)` + `/mcps/dump/mcp/*` plus a `/mcp`
 *     alias, all forwarding `c.req.raw` into a `McpAgent.serve(...)` handler
 *
 * The McpAgent + DumpMCP class are byte-identical to src/server.ts so any
 * delta vs the v0119 baseline must come from the Hono pipeline.
 *
 * The bearer token is `mcp-1433-test-token` — it's not a real secret, just
 * something to make the middleware actually do work and force the `c.req`
 * through Hono's request-handling layer. README documents it.
 */
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = Record<string, never>;

export class DumpMCP extends McpAgent<Env, State, Record<string, never>> {
  server = new McpServer({
    name: "mcp-1433-repro-hono",
    version: "0.0.0"
  });

  initialState: State = {};

  async init() {
    this.server.registerTool(
      "dump_content",
      {
        description:
          "Accepts an arbitrary string and returns its byte length and SHA-256 hash. Used to exercise the Worker→DO hop with large payloads under a Hono wrapper.",
        inputSchema: { content: z.string() }
      },
      async ({ content }) => {
        const bytes = new TextEncoder().encode(content);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ length: bytes.byteLength, sha256: hex })
            }
          ]
        };
      }
    );
  }
}

// Bearer constant — exposed in README, this is a *test* token, not a secret.
// Mirrors pka-mcp-hub's bearer-auth surface so the request shape on the way
// into McpAgent.serve(...) goes through Hono's middleware pipeline.
const TEST_BEARER = "mcp-1433-test-token";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

const app = new Hono<{ Bindings: Env }>();

const bearerAuth = async (c: any, next: any) => {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !safeEqual(match[1], TEST_BEARER)) {
    return c.json({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": 'Bearer realm="mcp-1433-repro-hono"'
    });
  }
  await next();
};

app.use("/mcps/*", bearerAuth);
app.use("/mcp", bearerAuth);
app.use("/mcp/*", bearerAuth);

const dumpCanonical = DumpMCP.serve("/mcps/dump/mcp", { binding: "DumpMCP" });
const dumpLegacy = DumpMCP.serve("/mcp", { binding: "DumpMCP" });

app.all("/mcps/dump/mcp", (c) =>
  dumpCanonical.fetch(c.req.raw, c.env, c.executionCtx)
);
app.all("/mcps/dump/mcp/*", (c) =>
  dumpCanonical.fetch(c.req.raw, c.env, c.executionCtx)
);
app.all("/mcp", (c) => dumpLegacy.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/mcp/*", (c) => dumpLegacy.fetch(c.req.raw, c.env, c.executionCtx));

app.get("/", (c) => c.json({ name: "mcp-1433-repro-hono" }));

export default app;
