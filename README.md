# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

## Final findings (4 May 2026)

The bug is real and the trigger is now isolated. Walked it down in two stages.

**Stage 1 — nine A/B variants in this repo, ruling out structural axes** (table below). All eight non-Portal rows pass at 24/65/200/500 KB content. Only the Portal-routed row fails.

**Stage 2 — direct `curl` vs Portal at the same upstream endpoint, with the same body and the same bearer**:

| Path | 24 KB content | Worker handler runs? |
| --- | --- | --- |
| Direct `curl POST` to `mcp.bacarda.de/mcp` | ✓ 200 OK in 384 ms (app-level rejection) | yes |
| Cloudflare One MCP Server Portal → `mcp.bacarda.de/mcp` | ✗ **869 ms** `TLS Alert level=2 desc=22` | **no** |

A `DEBUG_HEADERS=1`-gated middleware on the receiving Worker confirmed: for failing Portal calls, only `initialize` and a small notification reach the Worker — the `tools/call` request never arrives. The edge terminates the connection with `record_overflow` before the Worker handler is invoked.

**Threshold scan via Portal** (same upstream, same bearer, content size only varied):

| Raw content | Body bytes | Result |
| --- | --- | --- |
| 12 KB | 12 191 | ✓ pass |
| 14 KB | 14 191 | ✓ pass |
| 16 KB | 16 191 | ✓ pass |
| **18 KB** | — | ✗ **`record_overflow`** |
| 20 KB | — | ✗ `record_overflow` |
| 24 KB | — | ✗ `record_overflow` |

The buggy `cf-mcp-message` base64-header path in agents-sdk is the structural cause. It trips in the **Portal Worker → Portal DO hop** (the Cloudflare One MCP Server Portal is itself built on agents-sdk). Portal carries ~6–8 KB more internal header state than a plain Worker, which is why the cliff hits at ~18 KB content instead of the ~24 KB you'd predict from base64 inflation alone (32 KB combined-header limit, base64 inflates ~33%). Direct usage of the same SDK against the same upstream doesn't trip until ~24+ KB.

**[PR #1434](https://github.com/cloudflare/agents/pull/1434)** fixes this for everyone — Portal included — by moving the body off the `cf-mcp-message` header path and onto the existing Worker→DO WebSocket. The exact byte that tips the scale becomes moot once the body is off the header.

## Nine-row A/B/C matrix

| # | Deployment | 16 KB | 18 KB | 24 KB | 65 KB | 200 KB | 500 KB |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0.11.9` workers.dev (direct SDK) | ✓ | ✓ | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| 2 | `0.12.3` workers.dev (direct SDK) | ✓ | ✓ | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| 3 | `pkg.pr.new/agents@1434` workers.dev | ✓ | ✓ | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| 4 | `0.11.9` custom zone, no Access | ✓ | ✓ | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| 5 | `0.11.9` zone + Access service-token | ✓ | ✓ | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| 6 | `0.11.9` workers.dev + 12 KB fat custom request headers | — | — | ✓ 251 ms | — | — | — |
| 7 | `0.11.9` Hono + Bearer wrapper *(mirrors `mcp.bacarda.de` byte-for-byte)* | ✓ | ✓ | ✓ 269 ms | ✓ 297 ms | ✓ 329 ms | ✓ 423 ms |
| 8 | `0.11.9` Hono + Bearer behind own `@cloudflare/codemode@0.3.4` `code`-tool bridge | ✓ | ✓ | ✓ 1905 ms | ✓ 733 ms | ✓ 1385 ms | — |
| **9** | **Cloudflare One MCP Server Portal → `mcp.bacarda.de`** | **✓** | **✗** | **✗ 869 ms** | — | — | — |

Hypotheses ruled out by rows 1–8: SDK version (1–3), custom zone (4), Cloudflare Access in any flavour (5), forwarded request-header weight (6), Hono `app.all(...)` mounting (7), codemode MCP client request shape via the same `@cloudflare/codemode` library version Portal uses (8). Only row 9 fails. Stage 2 (direct `curl` vs Portal at the same endpoint) isolates the differentiator to the Portal forward path itself.

## Branches and live workers

| Branch | `agents` | Worker(s) | URL(s) |
| --- | --- | --- | --- |
| `main` | `0.12.3` | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `0.11.9` | `mcp-1433-repro-0119` *(workers.dev)* + `mcp-1433-zone` *(custom zone)* | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev <br> https://mcp-1433-test.bacarda.de |
| `v0119-hono` | `0.11.9` | `mcp-1433-repro-hono` | https://mcp-1433-repro-hono.bastian-enterprise.workers.dev |
| `v0119-codemode-bridge` | `0.11.9` | `mcp-1433-repro-codemode-bridge` | https://mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev |
| `fixed` | `pkg.pr.new/agents@1434` | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

Bearer test token across all auth-required variants: `mcp-1433-test-token` *(public, fixture-only, not a secret).*

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
npm install

# Rows 1–7 (direct MCP-SDK driver) — all pass up to 500 KB
MCP_BEARER_TOKEN=mcp-1433-test-token \
  node repro.mjs https://mcp-1433-repro-hono.bastian-enterprise.workers.dev/mcp 24576

# Row 8 (codemode bridge driver) — passes
node repro-codemode.mjs https://mcp-1433-repro-codemode-bridge.bastian-enterprise.workers.dev/mcp/svc 24576

# Row 9 requires a Cloudflare One MCP Server Portal pointing at any upstream
# agents-sdk Worker. Then call any tool with content >18 KB raw and observe the
# TLS record_overflow.
```

`repro.mjs` accepts these auth env vars (any combination — they stack):

```bash
export MCP_BEARER_TOKEN=<token>             # adds Authorization: Bearer
export CF_ACCESS_CLIENT_ID=<id>.access      # service-token Access
export CF_ACCESS_CLIENT_SECRET=<secret>     # service-token Access
export CF_AUTHORIZATION_JWT=<long-jwt>      # interactive-user Access JWT
```

## Files

- `src/server.ts` — baseline `McpAgent` Durable Object
- `src/server-hono.ts` *(`v0119-hono`+)* — Hono + Bearer-wrapped variant (mirrors a real Portal-fronted upstream)
- `src/server-codemode-bridge.ts` *(`v0119-codemode-bridge`)* — codemode `code`-tool bridge to the hono upstream
- `wrangler*.jsonc` — per-variant deploy configs
- `repro.mjs` — direct MCP-SDK driver
- `repro-codemode.mjs` *(`v0119-codemode-bridge`)* — codemode-bridge driver
- `EVIDENCE.md` *(`v0119`+)* — per-round data and hypothesis status

## License

MIT
