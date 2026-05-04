# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Final status (4 May 2026):** the bug is **live** on `mcp.bacarda.de` (private, `agents@^0.11.9`, fronted by Hono `app.all(...)` + Bearer middleware, called from a codemode runtime — fails ~700-869 ms in with `TLS Alert: level=2, description=22`; pka-mcp-hub's own internal note pins the empirical threshold at *"15 KB ok, 18 KB+ fails"*). After **eight** A/B/C/D/E/F/G/H variants in this repo we still cannot reproduce. Definitively ruled out: SDK version, custom zone, Cloudflare Access in any flavour, forwarded request-header weight, Hono `app.all` wrapper + Bearer middleware (mirrored byte-for-byte from pka-mcp-hub including the multi-segment `/mcps/<n>/mcp` canonical path). **By elimination, the only remaining suspect is the codemode MCP client request shape (H3) — untestable from outside this repo.** Detail in [EVIDENCE.md](./EVIDENCE.md) on the `v0119-hono` branch.

## What's in the repo

| Branch | `agents` version | Worker name(s) | URL(s) |
| --- | --- | --- | --- |
| `main` | `agents@0.12.3` (npm, latest) | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `agents@0.11.9` (matches pka-mcp-hub) | `mcp-1433-repro-0119` *(workers.dev)* + `mcp-1433-zone` *(custom zone, optional Access)* | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev <br> https://mcp-1433-test.bacarda.de |
| **`v0119-hono`** | **`agents@0.11.9`** | **`mcp-1433-repro-hono`** *(Hono+Bearer wrapper, mirrors pka-mcp-hub)* | **https://mcp-1433-repro-hono.bastian-enterprise.workers.dev** |
| `fixed` | `pkg.pr.new/agents@1434` | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

The `v0119-hono` branch ships:

- `src/server-hono.ts` — `Hono` `app.use(bearerAuth) + app.all("/mcps/dump/mcp" + "/mcp", ...)` mounting pattern, byte-for-byte mirror of pka-mcp-hub's setup
- `wrangler-hono.jsonc` — deploy config; same DO migration as the baseline
- Bearer test token: `mcp-1433-test-token` *(public — fixture-only, not a secret)*

## Eight-row result

| # | Deployment | 24 KB | 65 KB | 200 KB | 500 KB |
| - | --- | --- | --- | --- | --- |
| 1 | `0.11.9` on `*.workers.dev` | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| 2 | `0.12.3` on `*.workers.dev` | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| 3 | `pkg.pr.new/1434` on `*.workers.dev` | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| 4 | `0.11.9` on `mcp-1433-test.bacarda.de` *(zone, no Access)* | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| 5 | `0.11.9` on `mcp-1433-test.bacarda.de` *(zone + Access service-token)* | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| 6 | `0.11.9` on `*.workers.dev` + 12 KB of fat custom request headers | ✓ 251 ms | — | — | — |
| **7** | **`0.11.9` on `*.workers.dev` + Hono `app.all(...)` + Bearer middleware** | **✓ 269 ms** | **✓ 297 ms** | **✓ 329 ms** | **✓ 423 ms** |
| 8 | `0.11.9` on `mcp.bacarda.de` *(Hono + Bearer + **codemode** client)* | ✗ **869 ms** | — | — | — |

The base64 `cf-mcp-message` header path is byte-identical in `0.11.9` and `0.12.3` at `dist/mcp/index.js:160`. Seven rows pass through it; one row fails through it. Row 7 is identical to the failing row 8 on every axis we've measured **except the MCP client** — which makes the codemode client (H3) the only remaining suspect by elimination.

PR #1434 makes all of this moot by moving the JSON-RPC body off the request-header path entirely (onto the existing Worker→DO WebSocket).

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
git checkout v0119-hono            # broadest test surface
npm install
MCP_BEARER_TOKEN=mcp-1433-test-token \
  node repro.mjs https://mcp-1433-repro-hono.bastian-enterprise.workers.dev/mcp 24576
# repeat with each URL from the table above
```

`repro.mjs` reads optional auth env vars (any combination — they stack):

```bash
export MCP_BEARER_TOKEN=<token>             # adds Authorization: Bearer
export CF_ACCESS_CLIENT_ID=<id>.access      # service-token Access
export CF_ACCESS_CLIENT_SECRET=<secret>     # service-token Access
export CF_AUTHORIZATION_JWT=<long-jwt>      # interactive-user Access JWT
```

## Deploying your own copy

Edit `account_id` in `wrangler.jsonc` (and `wrangler-zone.jsonc` / `wrangler-hono.jsonc` on the variant branches) to your own. For zone deployment, change `routes[].pattern` to a hostname on a zone you control. Then:

```bash
npx wrangler deploy                                   # workers.dev (main / v0119 / v0119-hono / fixed)
npx wrangler deploy --config wrangler-zone.jsonc      # custom zone (v0119)
npx wrangler deploy --config wrangler-hono.jsonc      # Hono variant (v0119-hono)
```

## Files

- `src/server.ts` — baseline `McpAgent` Durable Object exposing `dump_content`
- `src/server-hono.ts` *(only on `v0119-hono`)* — Hono+Bearer-wrapped variant
- `wrangler.jsonc` — workers.dev deploy
- `wrangler-zone.jsonc` *(`v0119`+)* — custom-zone deploy
- `wrangler-hono.jsonc` *(`v0119-hono`)* — Hono-wrapped deploy
- `repro.mjs` — Node driver using `@modelcontextprotocol/sdk` streamable-HTTP client; supports Bearer + service-token Access + interactive-JWT Access env vars; explicit `record_overflow` detection
- `EVIDENCE.md` *(`v0119`+, `v0119-hono`)* — full A–H data, hypothesis status, suggested next probes

## License

MIT
