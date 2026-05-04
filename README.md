# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Status (4 May 2026):** the bug is **live** on `mcp.bacarda.de` (private, `agents@^0.11.9`, called from a codemode runtime — empirically `15 KB ok / 18 KB+ fails`, `TLS Alert: level=2, description=22` ~700 ms in). After six A/B/C/D/E/F variants on the same Cloudflare account we still cannot trip `record_overflow` on a minimal twin. SDK version, custom zone, *both forms* of CF Access, and forwarded ~12 KB of fat custom headers — none reproduce the failure. **Major correction this round:** `mcp.bacarda.de` is **not** behind Cloudflare Access; it uses Bearer-token Hono middleware. So neither Access flavour can be the differentiator. Remaining suspects are the **codemode** MCP client request shape and the **Hono `app.all(...)` wrapper** that `mcp.bacarda.de` mounts the MCP handler under. Detail in [EVIDENCE.md](./EVIDENCE.md) on the `v0119` branch.

## What's in the repo

| Branch | `agents` version | Worker name(s) | URL(s) |
| --- | --- | --- | --- |
| `main` | `agents@0.12.3` (npm, latest) | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `agents@0.11.9` (npm, matches pka-mcp-hub pin) | `mcp-1433-repro-0119` *(workers.dev)* + `mcp-1433-zone` *(custom zone, optional Access)* | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev <br> https://mcp-1433-test.bacarda.de |
| `fixed` | `pkg.pr.new/agents@1434` | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

The `v0119` branch ships **two** wrangler configs:

- `wrangler.jsonc` → workers.dev deploy (no zone, no Access)
- `wrangler-zone.jsonc` → custom-domain deploy at `mcp-1433-test.bacarda.de`. This hostname is fronted by a self-hosted Cloudflare Access App with both a `non_identity` service-token policy and an `allow` interactive-email policy. (Service-token mode preserved as fallback for any further A/B work.)

All deployments live on the same Cloudflare account (`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`).

## Six-row result

| Deployment | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | --- | --- | --- | --- |
| `0.11.9` on `*.workers.dev` | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` on `*.workers.dev` | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| `pkg.pr.new/1434` on `*.workers.dev` | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| `0.11.9` on `mcp-1433-test.bacarda.de` *(zone, no Access)* | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| `0.11.9` on `mcp-1433-test.bacarda.de` *(zone + Access service-token)* | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| `0.11.9` on `*.workers.dev` + 12 KB of custom request headers (Bearer-style padding) | ✓ 251 ms | — | — | — |
| `0.11.9` on `mcp.bacarda.de` *(Bearer middleware + codemode client)* | ✗ **869 ms** | — | — | — |

The base64 `cf-mcp-message` header path is byte-identical in `0.11.9` and `0.12.3` (`dist/mcp/index.js:160`). Six rows pass with that path; one row fails. The differentiating axes between the failing row and the closest passing rows are now down to:

- the **codemode MCP client** (vs the `@modelcontextprotocol/sdk` streamable-HTTP transport this repro uses)
- the **Hono `app.all(...)` wrapper** that pka-mcp-hub mounts the MCP handler under (vs `McpAgent.serve("/mcp", ...)` straight on the Worker entry)

Both, or their interaction, would produce additional incoming-request headers that get forwarded onto the Worker→DO WebSocket subrequest at `dist/mcp/index.js:154-157`. PR #1434 makes all of this moot by moving the JSON-RPC body off the request-header path.

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
git checkout v0119
npm install
node repro.mjs https://mcp-1433-test.bacarda.de/mcp 24576
# repeat with each URL from the table above
```

For Access-protected endpoints, `repro.mjs` reads:

```bash
# service-token mode
export CF_ACCESS_CLIENT_ID=<service-token-id>.access
export CF_ACCESS_CLIENT_SECRET=<service-token-secret>
# OR interactive-user JWT mode (after browser login, copy CF_Authorization cookie)
export CF_AUTHORIZATION_JWT=<long-jwt-string>
node repro.mjs https://your-access-protected-endpoint/mcp 24576
```

## Deploying your own copy

Edit `account_id` in `wrangler.jsonc` (and `wrangler-zone.jsonc` on `v0119`) to your own. For zone deployment, change `routes[].pattern` to a hostname on a zone you control. Then:

```bash
npx wrangler deploy                                # workers.dev
npx wrangler deploy --config wrangler-zone.jsonc   # custom zone
```

## Files

- `src/server.ts` — `McpAgent` Durable Object exposing `dump_content`
- `wrangler.jsonc` — workers.dev deploy
- `wrangler-zone.jsonc` *(only on `v0119`)* — custom-zone deploy
- `repro.mjs` — Node driver using `@modelcontextprotocol/sdk` streamable-HTTP client; supports service-token + interactive-JWT auth env vars; explicit `record_overflow` detection
- `EVIDENCE.md` *(only on `v0119`)* — full A/B/C/D/E/F data, hypothesis status, suggested next probes including the cheapest path forward (one-line debug middleware in pka-mcp-hub to capture the incoming-request shape on a failing call)

## License

MIT
