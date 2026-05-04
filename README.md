# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Final status (4 May 2026):** the bug is **live** on `mcp.bacarda.de` (private, `agents@^0.11.9`, fronted by Hono `app.all(...)` + Bearer middleware, called from a codemode runtime — `15 KB ok / 18 KB+ fails` per pka-mcp-hub's own internal note, `TLS Alert: level=2, description=22` ~700 ms in). After **nine** A/B/C/D/E/F/G/H/I variants in this repo we cannot reproduce. **All testable hypotheses are dead** — SDK version, custom zone, CF Access in any flavour, forwarded request-header weight, Hono `app.all` wrapper, and **codemode MCP client request shape** (this round, via a per-request `codeMcpServer({server, executor})` proxy bridge that hits the same `agents@0.11.9` Hono+Bearer upstream — passes 24/65/200 KB cleanly). The only remaining structural difference vs the failing path is *"two consecutive public-edge hops on the same body in pka-portal's specific codemode runtime configuration"*, which we cannot fully test from outside (zone-level Bot Fight bounced our worker→public-edge attempt). Detail in [EVIDENCE.md](./EVIDENCE.md) on `v0119-codemode-bridge`.

## What's in the repo

| Branch | `agents` | Worker(s) | URL(s) |
| --- | --- | --- | --- |
| `main` | `0.12.3` | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `0.11.9` | `mcp-1433-repro-0119` *(workers.dev)* + `mcp-1433-zone` *(custom zone)* | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev <br> https://mcp-1433-test.bacarda.de |
| `v0119-hono` | `0.11.9` | `mcp-1433-repro-hono` (workers.dev + `mcp-1433-hono.bacarda.de`) | https://mcp-1433-repro-hono.bastian-enterprise.workers.dev <br> https://mcp-1433-hono.bacarda.de |
| **`v0119-codemode-bridge`** | **`0.11.9`** | **`mcp-1433-repro-codemode-bridge`** | **https://mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev** |
| `fixed` | `pkg.pr.new/1434` | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

Bearer test token across all auth-required variants: `mcp-1433-test-token` *(public, fixture-only, not a secret).*

## Nine-row result

| # | Deployment | 24 KB | 65 KB | 200 KB | 500 KB |
| - | --- | --- | --- | --- | --- |
| 1 | `0.11.9` workers.dev | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| 2 | `0.12.3` workers.dev | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| 3 | `pkg.pr.new/1434` workers.dev | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| 4 | `0.11.9` zone, no Access | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| 5 | `0.11.9` zone + Access service-token | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| 6 | `0.11.9` workers.dev + 12 KB fat custom request headers | ✓ 251 ms | — | — | — |
| 7 | `0.11.9` Hono + Bearer wrapper *(matches pka-mcp-hub byte-for-byte)* | ✓ 269 ms | ✓ 297 ms | ✓ 329 ms | ✓ 423 ms |
| **8** | **`0.11.9` Hono + Bearer behind the codemode `code` bridge** *(svc binding to row 7)* | **✓ 1905 ms** | **✓ 733 ms** | **✓ 1385 ms** | — |
| 9 | `mcp.bacarda.de` *(Hono + Bearer + codemode client over public edge)* | ✗ **869 ms** | — | — | — |

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
git checkout v0119-codemode-bridge          # broadest test surface
npm install

# Direct SDK call (rows 1-7)
MCP_BEARER_TOKEN=mcp-1433-test-token \
  node repro.mjs https://mcp-1433-repro-hono.bastian-enterprise.workers.dev/mcp 24576

# Codemode bridge call (row 8)
node repro-codemode.mjs https://mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev/mcp/svc 24576
```

`repro.mjs` reads optional auth env vars (any combination — they stack):

```bash
export MCP_BEARER_TOKEN=<token>             # adds Authorization: Bearer
export CF_ACCESS_CLIENT_ID=<id>.access      # service-token Access
export CF_ACCESS_CLIENT_SECRET=<secret>     # service-token Access
export CF_AUTHORIZATION_JWT=<long-jwt>      # interactive-user Access JWT
```

## Files

- `src/server.ts` — baseline `McpAgent` Durable Object
- `src/server-hono.ts` *(`v0119-hono`+)* — Hono+Bearer-wrapped variant
- `src/server-codemode-bridge.ts` *(`v0119-codemode-bridge`)* — codemode `code` bridge to the hono upstream
- `wrangler*.jsonc` — per-variant deploy configs
- `repro.mjs` — direct SDK driver
- `repro-codemode.mjs` *(`v0119-codemode-bridge`)* — codemode-bridge driver, calls `code` tool with `dump_content`
- `EVIDENCE.md` *(`v0119`+)* — full A–I data, hypothesis status, suggested next probes

## License

MIT
