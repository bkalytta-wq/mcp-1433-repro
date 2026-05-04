# Evidence — A through G test for cloudflare/agents#1433

All deployments live on the same Cloudflare account
(`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`), and all run
identical `DumpMCP` source (one `dump_content` MCP tool taking
`{ content: string }`, returning `{ length, sha256 }`) on identical
`McpAgent` Durable Objects. The deliberate variables are listed per row.

## Live deployments

| Deployment             | `agents`        | Hostname                                              | Zone? | Wrapper / Auth                                  |
| ---------------------- | --------------- | ----------------------------------------------------- | ----- | ----------------------------------------------- |
| `mcp-1433-repro-0119`  | `0.11.9`        | `mcp-1433-repro-0119.bastian-enterprise.workers.dev`  | no    | none                                            |
| `mcp-1433-repro`       | `0.12.3`        | `mcp-1433-repro.bastian-enterprise.workers.dev`       | no    | none                                            |
| `mcp-1433-repro-fixed` | pkg.pr.new/1434 | `mcp-1433-repro-fixed.bastian-enterprise.workers.dev` | no    | none                                            |
| `mcp-1433-zone`        | `0.11.9`        | `mcp-1433-test.bacarda.de`                            | yes   | CF Access (service-token + interactive policies) |
| **`mcp-1433-repro-hono`** | **`0.11.9`**    | **`mcp-1433-repro-hono.bastian-enterprise.workers.dev`** | **no**    | **Hono `app.all(...)` + Bearer middleware (mirrors pka-mcp-hub)** |
| `mcp.bacarda.de`       | `^0.11.9`       | `mcp.bacarda.de` *(pka-mcp-hub, separate repo)*       | yes   | Hono `app.all(...)` + Bearer + codemode client  |

## The buggy code path is byte-identical in 0.11.9 and 0.12.3

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## Hono variant — exact pka-mcp-hub shape

`src/server-hono.ts` mirrors pka-mcp-hub's mounting pattern verbatim:

```ts
app.use("/mcps/*", bearerAuth);
app.use("/mcp",   bearerAuth);
app.use("/mcp/*", bearerAuth);

const dumpCanonical = DumpMCP.serve("/mcps/dump/mcp", { binding: "DumpMCP" });
const dumpLegacy    = DumpMCP.serve("/mcp",            { binding: "DumpMCP" });

app.all("/mcps/dump/mcp",   (c) => dumpCanonical.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/mcps/dump/mcp/*", (c) => dumpCanonical.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/mcp",   (c) => dumpLegacy.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/mcp/*", (c) => dumpLegacy.fetch(c.req.raw, c.env, c.executionCtx));
```

Same Hono version (`^4.6.3`), same `safeEqual()` constant-time-ish bearer
check, same `c.req.raw` forwarding, same `app.all()` route pattern, same
multi-segment canonical path *and* a legacy `/mcp` alias. Bearer token is
public (`mcp-1433-test-token`) — it's a test-fixture, not a secret.

## Results — `node repro.mjs <url> <bytes>`

| #   | Deployment                                                   | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | ------------------------------------------------------------ | ----- | ----- | ------ | ------ |
| 1   | `0.11.9` workers.dev                                         | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| 2   | `0.12.3` workers.dev                                         | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| 3   | pkg.pr.new/1434 workers.dev                                  | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| 4   | `0.11.9` zone, no Access                                     | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| 5   | `0.11.9` zone + Access service-token                         | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| 6   | `0.11.9` workers.dev + 12 KB of fat custom request headers   | ✓ 251 ms | — | — | — |
| **7a** | **`0.11.9` Hono + Bearer, `/mcps/dump/mcp` canonical**           | **✓ 269 ms** | **✓ 297 ms** | **✓ 329 ms** | **✓ 423 ms** |
| **7b** | **`0.11.9` Hono + Bearer, `/mcp` legacy alias**                  | **✓ 326 ms** | **✓ 350 ms** | —     | —     |
| 8   | `mcp.bacarda.de` *(Hono + Bearer + codemode client)*¹        | ✗ **869 ms** | — | — | — |

¹ Reported by Larry. `pka_memory.create` with `content="A".repeat(24576)`.
`TLS Alert: level=2, description=22` (record_overflow, fatal).

## Hypotheses — final final status

| #   | Hypothesis | Status |
| --- | ---------- | ------ |
| H0  | `0.11.9` triggers, `0.12.3` masks it                                                         | **dead** (rows 1, 2) |
| H1  | Custom zone (vs `*.workers.dev`) is the trigger                                              | **dead** (row 4) |
| H2a | Cloudflare Access (any flavour) in front is the trigger                                      | **dead** (row 5) |
| H2b | Specifically interactive (SSO) Access JWT is the trigger                                     | **moot** — `mcp.bacarda.de` is not behind Access at all (verified via `/access/apps` + bare `WWW-Authenticate: Bearer` 401) |
| H3  | codemode MCP client request shape (vs `@modelcontextprotocol/sdk` streamable-HTTP transport) | **only remaining suspect — untestable from outside this repo** |
| H4  | Hono `app.all(...)` wrapper + Bearer middleware + multi-segment path forwarding `c.req.raw`  | **dead** (rows 7a, 7b) |
| H5  | Forwarded incoming-request-header weight pushes the cliff                                    | **dead** (row 6 — 12 KB of custom headers + 24 KB content still passes) |

By elimination, **H3 is the only structural difference left** between
the failing deployment and the closest passing twin (row 7a — same
account, same agents version, same Hono+Bearer wrapper, same canonical
mount path, same DO model, only the MCP client differs). The codemode
runtime that pka-portal uses to reach `mcp.bacarda.de` produces a
request shape that this minimal repro cannot match from
`@modelcontextprotocol/sdk`'s streamable-HTTP transport.

That residual axis is the one we can't probe without either:

1. Running the codemode runtime against a deployment we control (would
   need the `@cloudflare/codemode` outbound-MCP machinery wired into a
   test harness — unblocked once the maintainers have a moment, the
   row 7a deployment is a ready target).
2. Adding a `DEBUG_HEADERS=1`-gated middleware to pka-mcp-hub that
   dumps `Object.fromEntries(request.headers)` + body length on one
   failing call. Byte-diff against an equivalent shape from `repro.mjs`
   on row 7a would expose what codemode is sending that the SDK isn't.

Either probe is cheap and bounded.

## Headline

PR #1434 is the right fix regardless. `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket eliminates the cliff entirely —
whatever combination of codemode-side headers, request-envelope shape,
or future Cloudflare-edge-injected metadata is currently load-bearing,
none of it competes with the body anymore.
