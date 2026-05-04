# Evidence — A/B/C/D/E test for cloudflare/agents#1433

All deployments run on the same Cloudflare account
(`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`), all share
identical `src/server.ts` (one `dump_content` MCP tool taking
`{ content: string }`, returning `{ length, sha256 }`) and identical
`McpAgent` Durable Object. The deliberate variables are listed per-row.

## Live deployments

| Deployment             | `agents`        | Hostname                                              | Zone? | Access?                       |
| ---------------------- | --------------- | ----------------------------------------------------- | ----- | ----------------------------- |
| `mcp-1433-repro-0119`  | `0.11.9` (npm)  | `mcp-1433-repro-0119.bastian-enterprise.workers.dev`  | no    | no                            |
| `mcp-1433-repro`       | `0.12.3` (npm)  | `mcp-1433-repro.bastian-enterprise.workers.dev`       | no    | no                            |
| `mcp-1433-repro-fixed` | pkg.pr.new/1434 | `mcp-1433-repro-fixed.bastian-enterprise.workers.dev` | no    | no                            |
| `mcp-1433-zone`        | `0.11.9` (npm)  | `mcp-1433-test.bacarda.de`                            | yes   | yes (service-token policy)    |
| `mcp.bacarda.de`       | `^0.11.9`       | `mcp.bacarda.de` *(pka-mcp-hub, separate repo)*       | yes   | yes (interactive SSO + codemode client) |

The same Worker `mcp-1433-zone` is hit twice in the result table — once
with the service-token headers attached (Access bypassed via
`non_identity` policy), and once without (Access enforces the 302 redirect
and the request never reaches the Worker — not actually a fail mode for
the bug, just a baseline).

## The buggy code path is byte-identical in 0.11.9 and 0.12.3

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## Results — `node repro.mjs <url> <bytes>`

| Deployment | 24 KB | 65 KB | 200 KB | 500 KB |
| --- | --- | --- | --- | --- |
| `0.11.9` workers.dev                              | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` workers.dev                              | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| `pkg.pr.new/1434` workers.dev                     | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | —        |
| `0.11.9` zone, no Access (Test A)                 | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| **`0.11.9` zone + Access service-token (Test B)** | **✓ 317 ms** | **✓ 397 ms** | **✓ 396 ms** | **✓ 557 ms** |
| `0.11.9` zone + Access (interactive) + codemode (pka-mcp-hub) | ✗ 869 ms ¹ | — | — | — |

¹ `TLS Alert: level=2, description=22` (record_overflow, fatal). Live datapoint
from a `pka_memory.create` call with `content="A".repeat(24576)`.

## Hypotheses status

| # | Hypothesis | Status |
| - | ---------- | ------ |
| H0 | `0.11.9` triggers, `0.12.3` masks it | **dead** — both pass on workers.dev with byte-identical code path |
| H1 | Custom zone (vs `*.workers.dev`) is the trigger | **dead** — `mcp-1433-test.bacarda.de` passes 24 / 65 / 200 / 500 KB on `0.11.9` |
| H2a | Cloudflare Access in front (any flavour) is the trigger | **dead in this form** — service-token Access also passes 24 / 65 / 200 / 500 KB |
| H2b | **Interactive (SSO/OIDC) Access** specifically — its larger user-identity JWT (~3-4 KB) on every request — is the trigger | **leading remaining suspect** |
| H3 | **codemode** MCP client (different request shape than `@modelcontextprotocol/sdk` streamable-HTTP client) is the trigger or a contributor | **leading remaining suspect** |
| H4 | Some combination of H2b + H3 (interactive Access JWT *plus* codemode-side header bloat) crosses the limit, neither alone does | plausible; the simplest model that fits the data |

## What we learned about Access JWT size

Service-token Access issues a `CF_Authorization` JWT of ~786 bytes on the
response that subsequent requests echo back as a cookie:

```
{
  "type": "app",
  "iat": ..., "exp": ..., "iss": "https://bacarda.cloudflareaccess.com",
  "sub": "",
  "aud": "<app uid>",
  "common_name": "<service token client_id>"
}
```

Replaying tool-call requests with both `CF-Access-Client-Id` /
`CF-Access-Client-Secret` *and* the cookie attached at 24 KB still passes
cleanly. So 786 bytes of JWT on top of a ~32 KB `cf-mcp-message` header is
not enough to trip the cliff. Interactive-user JWTs include `email`,
`identity_nonce`, `groups`, possibly SAML attributes and run substantially
larger — that's the next thing to measure on the failing deployment.

## How to reproduce Test B (without using anyone else's secrets)

1. Deploy this repo's `v0119` branch to a custom domain on a Cloudflare
   zone you control:
   ```
   npx wrangler deploy --config wrangler-zone.jsonc
   ```
   (edit `account_id`, `routes[].pattern` first)
2. Create a self-hosted Access App over that hostname on the dashboard
   (Zero Trust → Access → Applications → Add). Domain = your hostname,
   path = empty, session = 24h.
3. Generate an Access Service Token (Zero Trust → Access → Service
   Auth). Copy client id + secret.
4. Add a *non-identity* policy on the App: include = service token = the
   one you just generated. Decision = Allow.
5. Run:
   ```
   export CF_ACCESS_CLIENT_ID=<id>.access
   export CF_ACCESS_CLIENT_SECRET=<secret>
   node repro.mjs https://your-app/mcp 24576
   node repro.mjs https://your-app/mcp 65536
   ```
   Both should pass. Trying the same with an interactive (SSO) Access policy
   instead of the service-token policy is the next probe — that's the
   remaining unknown.
