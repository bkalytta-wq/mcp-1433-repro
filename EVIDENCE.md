# Evidence — three-way A/B/C test for cloudflare/agents#1433

All three workers deploy to the same Cloudflare account (`Bastian Enterprise`,
`65c0e09fa5fa5c1fb9d8b429a9f08e11`), all reach the edge via
`*.bastian-enterprise.workers.dev` (no custom domain, no CF Access).
All three contain identical `src/server.ts`, identical `wrangler.jsonc`
(modulo `name`), and the same `dump_content` MCP tool. The only deliberate
variable is the `agents` package version.

## The buggy code path is present in all three published builds

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

Same line, same encoding, in **`agents@0.11.9`** and **`agents@0.12.3`**.
The PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## Live results — `node repro.mjs <url> <bytes>`

| `agents` version | Worker | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | --- | --- | --- | --- | --- |
| `0.11.9` (npm)            | `mcp-1433-repro-0119`  | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` (npm, current)   | `mcp-1433-repro`       | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| `pkg.pr.new/agents@1434`  | `mcp-1433-repro-fixed` | ✓ 751 ms | ✓ 452 ms¹ | ✓ 452 ms¹ | ✓ — |

¹ same single test run, fixed branch tested at 24 KB and 200 KB only.

All three branches succeed at every payload we tested. The version-difference
hypothesis ("0.11.9 trips it but 0.12.3 doesn't") is not supported.

## Counter-evidence from pka-mcp-hub

A separate `pka_memory.create` call with `content="A".repeat(24576)` against
`mcp.bacarda.de` (private, runs `agents@^0.11.9` on the same Cloudflare
account) failed after **869 ms** with `TLS Alert: level=2, description=22`
(record_overflow, fatal). So the bug is real and live on at least one
deployment in this account. The version *cannot* be the differentiator
because `mcp-1433-repro-0119` runs **the exact same `agents@0.11.9` build**
on the same account and *does not* fail.

## What's different between pka-mcp-hub and this repro

| | pka-mcp-hub (fails) | mcp-1433-repro-0119 (passes) |
| --- | --- | --- |
| `agents`               | `^0.11.9` | `0.11.9` |
| Hostname               | `mcp.bacarda.de` (zone) | `*.bastian-enterprise.workers.dev` |
| In front of edge       | unknown (likely Cloudflare Access) | none |
| DO class / migration   | application-specific | minimal `DumpMCP`, `new_sqlite_classes` |
| Tool surface           | `pka_memory.create` etc. | single `dump_content` |
| MCP client             | codemode runtime | `@modelcontextprotocol/sdk` |

The trigger has to live in one of those rows — most likely the **hostname /
zone path** (different edge/header machinery between
`*.workers.dev` and a customer zone) or the **MCP client** (codemode may
batch / pre-resolve / annotate the JSON-RPC payload differently than the
streamable-HTTP SDK client used in `repro.mjs`).

## Suggested next probes (for maintainers or for us)

1. Re-deploy `mcp-1433-repro` (the broken-upstream branch) **behind a
   custom zone** (e.g. a route on `bacarda.de`) and re-run `repro.mjs`. If
   *that* trips `record_overflow`, the trigger is the zone path, not the
   SDK version.
2. Re-run `pka_memory.create` against the *workers.dev* address of
   pka-mcp-hub directly (bypass `mcp.bacarda.de`). If that passes, same
   conclusion.
3. Capture the raw HTTP request from the codemode runtime (size of all
   headers combined, not just `cf-mcp-message`) and compare against the
   `repro.mjs` request. If codemode adds large additional headers (auth
   tokens, session metadata, observability), they could push the combined
   header total past the limit even at smaller `cf-mcp-message` sizes.
4. Diff `agents@v0.11.9..v0.12.3` for any code that touches header
   construction on the Worker→DO hop. (Cheap probe; this report's three-way
   data already says it almost certainly isn't the differentiator, but
   worth ruling out for completeness.)
