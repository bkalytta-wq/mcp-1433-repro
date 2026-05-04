# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Status (4 May 2026):** the bug is **live** on `mcp.bacarda.de` (private, `agents@^0.11.9`, fronted by interactive Cloudflare Access, accessed from a codemode MCP client — fails at 24 KB after 869 ms with `TLS Alert: level=2, description=22`). After five parallel A/B/C/D/E tests on the same account, none of *SDK version*, *custom zone*, or *service-token Access* trigger `record_overflow` on the same SDK build. The remaining suspects are **interactive (SSO/OIDC) Access** — whose user-identity JWT is several KB larger than a service-token JWT — and the **codemode** MCP client's request shape, possibly in combination. Detail in [EVIDENCE.md](./EVIDENCE.md) on the `v0119` branch.

## What's in the repo

| Branch | `agents` version | Worker name(s) | URL(s) |
| --- | --- | --- | --- |
| `main` | `agents@0.12.3` (npm, latest) | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `agents@0.11.9` (npm, matches pka-mcp-hub pin) | `mcp-1433-repro-0119` *(workers.dev)* + `mcp-1433-zone` *(custom zone, optional Access)* | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev <br> https://mcp-1433-test.bacarda.de |
| `fixed` | `pkg.pr.new/agents@1434` | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

The `v0119` branch ships **two** wrangler configs:

- `wrangler.jsonc` → deploys to `mcp-1433-repro-0119.bastian-enterprise.workers.dev` (no zone, no Access)
- `wrangler-zone.jsonc` → deploys the **same source** to `mcp-1433-test.bacarda.de` as `mcp-1433-zone` (custom zone). The hostname is fronted by a self-hosted Cloudflare Access App with a service-token `non_identity` policy. Use `npx wrangler deploy --config wrangler-zone.jsonc`.

All deployments live on the same Cloudflare account (`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`).

## Five-way result

| Deployment | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | --- | --- | --- | --- |
| `0.11.9` on `*.workers.dev` | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` on `*.workers.dev` | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| `pkg.pr.new/1434` on `*.workers.dev` | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| `0.11.9` on `mcp-1433-test.bacarda.de` *(zone, no Access)* | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| **`0.11.9` on `mcp-1433-test.bacarda.de` *(zone + Access service-token)*** | **✓ 317 ms** | **✓ 397 ms** | **✓ 396 ms** | **✓ 557 ms** |
| `0.11.9` on `mcp.bacarda.de` *(zone + interactive Access + codemode client — pka-mcp-hub)* | ✗ **869 ms** | — | — | — |

The base64 `cf-mcp-message` header path is byte-identical in `0.11.9` and `0.12.3` (`dist/mcp/index.js:160`). Five rows pass with that path; one row fails with that path. The differentiating axes between the failing row and the closest passing row (zone + service-token Access) are:

- **Interactive (SSO/OIDC) Access** vs *service-token Access* — interactive flow attaches a user-identity JWT typically several KB larger than a service-token JWT (786 B in our measurement)
- **codemode** MCP client vs `@modelcontextprotocol/sdk` streamable-HTTP client — different transport, possibly different request shape and additional headers

PR #1434 makes both differences moot by moving the JSON-RPC body off the request header path entirely (onto the existing Worker→DO WebSocket).

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
git checkout v0119
npm install
node repro.mjs https://mcp-1433-test.bacarda.de/mcp 24576
# repeat with each URL from the table above
```

For Access-protected endpoints, `repro.mjs` reads two optional env vars:

```bash
export CF_ACCESS_CLIENT_ID=<service-token-id>.access
export CF_ACCESS_CLIENT_SECRET=<service-token-secret>
node repro.mjs https://your-access-protected-endpoint/mcp 24576
```

Generate your own service token at *Zero Trust → Access → Service Auth* and add a `non_identity` policy to your Access App that includes it. Full step-by-step in [EVIDENCE.md](./EVIDENCE.md).

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
- `repro.mjs` — Node driver using `@modelcontextprotocol/sdk` streamable-HTTP client; supports `CF_ACCESS_CLIENT_ID/SECRET` env vars; explicit `record_overflow` detection
- `EVIDENCE.md` *(only on `v0119`)* — full A/B/C/D/E data, hypothesis status, Access provisioning steps

## License

MIT
