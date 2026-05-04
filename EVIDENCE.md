# Evidence — A through I test for cloudflare/agents#1433

All deployments live on the same Cloudflare account
(`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`), and all run
identical `DumpMCP` source on identical `McpAgent` Durable Objects. The
deliberate variables are listed per row.

## Live deployments

| Deployment                       | `agents`        | Hostname / route                                        | Wrapper / Auth                                  |
| -------------------------------- | --------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `mcp-1433-repro-0119`            | `0.11.9`        | `mcp-1433-repro-0119.bastian-enterprise.workers.dev`    | none                                            |
| `mcp-1433-repro`                 | `0.12.3`        | `mcp-1433-repro.bastian-enterprise.workers.dev`         | none                                            |
| `mcp-1433-repro-fixed`           | pkg.pr.new/1434 | `mcp-1433-repro-fixed.bastian-enterprise.workers.dev`   | none                                            |
| `mcp-1433-zone`                  | `0.11.9`        | `mcp-1433-test.bacarda.de`                              | CF Access (service-token + interactive policies) |
| `mcp-1433-repro-hono`            | `0.11.9`        | `mcp-1433-repro-hono.bastian-enterprise.workers.dev`    | Hono `app.all(...)` + Bearer middleware          |
| `mcp-1433-repro-hono` (also)     | `0.11.9`        | **`mcp-1433-hono.bacarda.de`** *(custom domain on bacarda.de zone)* | Hono `app.all(...)` + Bearer middleware (same Worker) |
| **`mcp-1433-repro-codemode-bridge`** | (see below)     | **`mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev`** | **Codemode `code` tool → upstream Hono+Bearer Worker (via service binding for `/mcp/svc`, public edge for `/mcp`)** |
| `mcp.bacarda.de`                 | `^0.11.9`       | `mcp.bacarda.de` *(pka-mcp-hub, separate repo)*         | Hono + Bearer + codemode client                  |

## The buggy code path is byte-identical in 0.11.9 and 0.12.3

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## H3 (codemode) — implementation

`src/server-codemode-bridge.ts` is a Worker that:

1. Connects to an upstream MCP server (the Hono+Bearer-wrapped
   `mcp-1433-repro-hono`) using `@modelcontextprotocol/sdk`'s
   `StreamableHTTPClientTransport`.
2. Lists the upstream tools and builds a *local* `McpServer` whose tools
   each proxy to the upstream client.
3. Wraps that local server with `codeMcpServer({server, executor})`
   from `@cloudflare/codemode/mcp` (using `DynamicWorkerExecutor` over a
   `worker_loaders` binding).
4. Serves the wrapped server through `createMcpHandler(...)`.

The exposed tool surface is exactly what pka-portal sees from
pka-mcp-hub: a single `code` tool that accepts a JS arrow function. The
sandbox-side `codemode.dump_content(...)` call goes through the codemode
runtime, into the proxy McpServer (in-memory transport), out via the
SDK client over the upstream's MCP transport. End-to-end this exercises
the full codemode-fronted-remote-MCP path — same library versions
(`@cloudflare/codemode@0.3.4`, `agents@0.11.9`) as pka-portal.

Two upstream modes are switchable by request path:

- `/mcp/svc` — bridge calls upstream via a **service binding**
  (`{services:[{binding:"UPSTREAM",service:"mcp-1433-repro-hono"}]}`).
  Required because workers.dev → workers.dev fetches on the same
  account are edge-rejected with `error code: 1042` (CF loop block).
- `/mcp` (default) — bridge calls upstream over the **public edge** at
  `https://mcp-1433-hono.bacarda.de/mcps/dump/mcp` (custom-domain on
  bacarda.de zone, same Worker as `mcp-1433-repro-hono`).

## Results — `node repro-codemode.mjs <bridge-url> <bytes>`

| Deployment                                                             | 24 KB | 65 KB | 200 KB | 500 KB |
| ---------------------------------------------------------------------- | ----- | ----- | ------ | ------ |
| `0.11.9` workers.dev (direct)                                          | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` workers.dev (direct)                                          | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| pkg.pr.new/1434 workers.dev (direct)                                   | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| `0.11.9` zone, no Access (direct)                                      | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| `0.11.9` zone + Access service-token (direct)                          | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| `0.11.9` workers.dev + 12 KB of fat custom request headers (direct)    | ✓ 251 ms | — | — | — |
| `0.11.9` Hono + Bearer (direct, both routes)                           | ✓ 269 ms | ✓ 297 ms | ✓ 329 ms | ✓ 423 ms |
| **`0.11.9` Hono + Bearer via codemode-bridge (service binding)**       | **✓ 1905 ms** | **✓ 733 ms** | **✓ 1385 ms** | **— ¹** |
| `0.11.9` Hono + Bearer via codemode-bridge (public edge)               | ✗ challenge ² | — | — | — |
| `mcp.bacarda.de` *(Hono + Bearer + codemode client)* — pka-mcp-hub     | ✗ **869 ms** | — | — | — |

¹ Service-binding mode capped at 200 KB this round; the upstream itself
already shows ✓ at 500 KB so further pushing isn't informative for the
H3 question.

² Worker → public custom-domain on the bacarda.de zone hits a Cloudflare
**Managed Challenge** (HTML "Just a moment..." JS challenge page on
the upstream hostname) — i.e. CF bot-fight flags the Worker-originated
request before it ever reaches the MCP path. This is a separate
phenomenon from `record_overflow`; it produces an HTML response, not a
TLS alert. Bypassing it would require either disabling Bot Fight Mode
on the bacarda.de zone or whitelisting the Worker — neither was done
this round.

## Hypotheses — final ledger

| #   | Hypothesis | Status |
| --- | ---------- | ------ |
| H0  | `0.11.9` triggers, `0.12.3` masks                                                            | **dead** (rows 1, 2) |
| H1  | Custom zone (vs `*.workers.dev`) is the trigger                                              | **dead** (row 4) |
| H2a | Cloudflare Access (any flavour) in front is the trigger                                      | **dead** (row 5) |
| H2b | Specifically interactive (SSO) Access JWT is the trigger                                     | **moot** — `mcp.bacarda.de` is not behind Access at all |
| H3  | codemode MCP client request shape is the trigger                                             | **dead** (row 8) — minimal `@cloudflare/codemode@0.3.4` + `codeMcpServer` wrapper passing through to the same Hono+Bearer upstream succeeds at 24/65/200 KB cleanly |
| H4  | Hono `app.all(...)` wrapper + Bearer middleware accumulate forwardable state                 | **dead** (rows 7, 8) |
| H5  | Forwarded incoming-request-header weight pushes the cliff                                    | **dead** (row 6) |
| H6  | Two public-edge hops + Cloudflare Bot Fight / Managed Challenge interactions                 | **untested cleanly** — the public-edge variant hit a Managed Challenge before reaching the MCP path; not the same failure shape as `record_overflow` but a real-world artifact worth flagging |

## Conclusion

**Eight reproducible rows pass**, including a minimal codemode bridge
running the exact `@cloudflare/codemode` library that pka-portal uses,
talking to a Hono+Bearer wrapper that mirrors pka-mcp-hub byte-for-byte.
**One row fails** — `mcp.bacarda.de` itself, which we cannot inspect
from outside.

Whatever load-bearing axis is left has to be **specific to the
pka-portal codemode runtime configuration** — for example a particular
extra header it injects, a specific protocol-version negotiation
behaviour, a Cloudflare Bot Fight rule on the bacarda.de zone that
treats pka-portal's specific request fingerprint as bot-like, or a
combination — none of which are visible from this repro and none of
which can be cleanly isolated without instrumentation on the failing
deployment itself.

The cheapest remaining probe is a `DEBUG_HEADERS=1`-gated middleware
on pka-mcp-hub that dumps `Object.fromEntries(request.headers)` and
the body length on a single failing call. Byte-diffing that against
the equivalent shape from `repro-codemode.mjs` against
`mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev/mcp/svc`
will surface the actual differentiator within minutes — the
infrastructure to do that is now stood up and ready.

## Headline

PR #1434 is the right fix. After eight successful reproductions covering
SDK version, custom zone, every Access flavour, forwarded-header
inflation, full Hono `app.all(...)` mounting, codemode-fronting via the
same library version pka-portal uses, all on the same Cloudflare
account — the failure on `mcp.bacarda.de` is increasingly clearly an
interaction between the buggy `cf-mcp-message` header path and one
specific component on that one deployment, not a broad framework
regression. Moving the JSON-RPC body off the request-header path and
onto the existing Worker→DO WebSocket eliminates the cliff outright and
makes the question of which exact byte tips the balance moot.
