# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Status (4 May 2026):** the bug is **live** on at least one deployment we own (`mcp.bacarda.de`, runs `agents@^0.11.9`, fails after 869 ms with `TLS Alert: level=2, description=22`). However it does **not** reproduce against any of the three branches in this repo when deployed to `*.bastian-enterprise.workers.dev` — including the exact same `agents@0.11.9` build. Conclusion: the differentiator is **deployment shape, not SDK version**. Custom zone / Cloudflare Access / codemode-client header surface are the next things to probe. Detail in [EVIDENCE.md](./EVIDENCE.md) on the `v0119` branch.

## What's in the repo

| Branch | `agents` version | Worker name | URL |
| --- | --- | --- | --- |
| `main` | `agents@0.12.3` (npm, latest) | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `v0119` | `agents@0.11.9` (npm, matches pka-mcp-hub pin) | `mcp-1433-repro-0119` | https://mcp-1433-repro-0119.bastian-enterprise.workers.dev |
| `fixed` | `pkg.pr.new/agents@1434` (PR #1434 build) | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

All three contain identical `src/server.ts`, expose one MCP tool (`dump_content` taking `{ content: string }` and returning `{ length, sha256 }`), and live on the same Cloudflare account (`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`). Only the `agents` package and the worker `name` differ between branches.

## Three-way result on `*.workers.dev`

| `agents` version | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | --- | --- | --- | --- |
| `0.11.9` (npm) | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` (npm) | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| `pkg.pr.new/agents@1434` | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |

The base64-encoded `cf-mcp-message` header path is provably present in both `0.11.9` and `0.12.3` (`dist/mcp/index.js:160`) yet neither trips `record_overflow` on `*.workers.dev`.

## Counter-data (where the bug *does* fire)

`pka_memory.create` against `mcp.bacarda.de` (private, `agents@^0.11.9`, same CF account) with `content="A".repeat(24576)` — `TLS Alert: level=2, description=22` (record_overflow, fatal) after **869 ms**. So the bug is real and triggered by *something* about that deployment that this minimal repo does not replicate. Most likely candidates:

- the request travels through a **custom zone** (`bacarda.de`) rather than the `workers.dev` shortcut, and edge header limits / TLS handling differ on the zone path
- **Cloudflare Access** sits in front and adds large headers (`cf-access-jwt-assertion` etc.) that push the combined-header total past the limit even at smaller `cf-mcp-message` sizes
- the **codemode** MCP client used to call pka-mcp-hub serializes the JSON-RPC payload differently than `@modelcontextprotocol/sdk`'s streamable-HTTP transport

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
npm install
node repro.mjs https://mcp-1433-repro.bastian-enterprise.workers.dev/mcp 24576
# repeat with v0119 / fixed URLs to match the table above
```

To deploy your own copy, change `account_id` in `wrangler.jsonc` and run `npx wrangler deploy`. Each branch deploys to its own worker name.

## Files

- `src/server.ts` — `McpAgent` Durable Object exposing `dump_content`
- `wrangler.jsonc` — deploy config, DO migration; only the `name` changes per branch
- `repro.mjs` — Node driver using `@modelcontextprotocol/sdk` streamable-HTTP client; explicit `record_overflow` detection in the error path
- `EVIDENCE.md` *(only on `v0119` branch)* — full three-way data, suggested follow-up probes

## License

MIT
