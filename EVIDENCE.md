# Evidence — A/B/C/D test for cloudflare/agents#1433

All deployments live on the same Cloudflare account
(`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`). All run
identical `src/server.ts` (one `dump_content` MCP tool taking
`{ content: string }`, returning `{ length, sha256 }`) and identical
`McpAgent` Durable Object. The deliberate variables are listed per-row.

## Live deployments

| Deployment           | `agents`       | Hostname                                          | Zone? | Access? |
| -------------------- | -------------- | ------------------------------------------------- | ----- | ------- |
| `mcp-1433-repro-0119`| `0.11.9` (npm) | `mcp-1433-repro-0119.bastian-enterprise.workers.dev` | no    | no      |
| `mcp-1433-repro`     | `0.12.3` (npm) | `mcp-1433-repro.bastian-enterprise.workers.dev`      | no    | no      |
| `mcp-1433-repro-fixed`| pkg.pr.new/1434| `mcp-1433-repro-fixed.bastian-enterprise.workers.dev`| no    | no      |
| `mcp-1433-zone`      | `0.11.9` (npm) | `mcp-1433-test.bacarda.de`                        | yes   | no      |
| `mcp.bacarda.de`     | `^0.11.9`      | `mcp.bacarda.de` *(pka-mcp-hub, separate repo)*   | yes   | yes     |

## The buggy code path is byte-identical in 0.11.9 and 0.12.3

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## Results — `node repro.mjs <url> <bytes>`

| Deployment              | 24 KB | 65 KB | 200 KB | 500 KB |
| ----------------------- | ----- | ----- | ------ | ------ |
| `0.11.9` workers.dev    | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` workers.dev    | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| pkg.pr.new/1434 workers.dev | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| **`0.11.9` custom zone, no Access** | **✓ 962 ms** | **✓ 511 ms** | **✓ 796 ms** | **✓ 727 ms** |
| `0.11.9` custom zone + Access (pka-mcp-hub¹) | ✗ 869 ms² | — | — | — |

¹ pka-mcp-hub is a separate, private repo on this account, runs the same
`agents@^0.11.9` build and is fronted by Cloudflare Access. Not part of
this repo, but the closest live datapoint we have.
² `TLS Alert: level=2, description=22` (record_overflow, fatal). Reported
by Larry on a `pka_memory.create` call with `content="A".repeat(24576)`.

## Hypotheses status

| # | Hypothesis | Status |
| - | ---------- | ------ |
| H0 | `0.11.9` triggers, `0.12.3` masks it | **dead** — both pass on workers.dev with identical code path |
| H1 | Custom zone (vs `*.workers.dev`) is the trigger | **dead** — `mcp-1433-test.bacarda.de` passes at 24/65/200/500 KB on `agents@0.11.9` |
| H2 | Cloudflare Access in front (added headers) is the trigger | **untested** — see "Test B blocked" below |
| H3 | codemode MCP client (different request shape than the SDK streamable-HTTP client) is the trigger | **untested** |

H1 was the dominant suspect after the previous round; it's now ruled out
on the same SDK version. H2 is the leading remaining candidate — Access
adds `cf-access-jwt-assertion` and `cf-access-authenticated-user-email`
which together easily run several KB and would push the combined
header total past whatever real limit applies to the Worker→DO hop.

## Test B (Access) — blocked at setup

The wrangler OAuth token on this machine has scopes
`account:read user:read workers:* zone:read d1:write pages:write
ssl_certs:write ai:write queues:write pipelines:write secrets_store:write
containers:write cloudchamber:* connectivity:admin offline_access` — but
no `access:edit` or `access:read`. Access App / Service Token creation via
`/accounts/{id}/access/apps` returns `code:10000 Authentication error`.

To unblock Test B we need exactly one of:

1. A Cloudflare API token with `Access: Apps and Policies — Edit` scope,
   exported as `CLOUDFLARE_API_TOKEN`. The repro will then create the
   Access App, a service token, attach the policy, and run end-to-end.
2. Manual Access App creation by Bastian on the dashboard:
   - Application type: *self-hosted*
   - Domain: `mcp-1433-test.bacarda.de`
   - Path: leave empty (cover the whole hostname)
   - Policy: any (we just need *some* Access JWT in the request)
   - Generate a service token; export both halves locally:
     ```
     export CF_ACCESS_CLIENT_ID=...
     export CF_ACCESS_CLIENT_SECRET=...
     node repro.mjs https://mcp-1433-test.bacarda.de/mcp 24576
     ```
   - `repro.mjs` already supports those env vars (no code change needed
     once Access is in place; default behaviour unchanged when unset).

`cloudflared access` only consumes Access (login / curl / token), it
cannot provision an App. Wrangler has no Access management.

## Suggested next probe — H3 in parallel

Independently of Test B, capture the full header set the codemode runtime
sends to `mcp.bacarda.de` (e.g. `wrangler tail` on the worker, or echo
back `request.headers` from a temporary tool) and compare combined-header
size against `repro.mjs`. If codemode adds large headers beyond
Access JWTs, that's a separate trigger axis.
