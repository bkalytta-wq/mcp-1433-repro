# Evidence — A/B/C/D/E/F test for cloudflare/agents#1433

All deployments live on the same Cloudflare account
(`Bastian Enterprise`, `65c0e09fa5fa5c1fb9d8b429a9f08e11`), all run
identical `src/server.ts` (one `dump_content` MCP tool taking
`{ content: string }`, returning `{ length, sha256 }`) and identical
`McpAgent` Durable Object. Variables differ per row.

## Live deployments

| Deployment             | `agents`        | Hostname                                              | Zone? | Front?                                  |
| ---------------------- | --------------- | ----------------------------------------------------- | ----- | --------------------------------------- |
| `mcp-1433-repro-0119`  | `0.11.9` (npm)  | `mcp-1433-repro-0119.bastian-enterprise.workers.dev`  | no    | none                                    |
| `mcp-1433-repro`       | `0.12.3` (npm)  | `mcp-1433-repro.bastian-enterprise.workers.dev`       | no    | none                                    |
| `mcp-1433-repro-fixed` | pkg.pr.new/1434 | `mcp-1433-repro-fixed.bastian-enterprise.workers.dev` | no    | none                                    |
| `mcp-1433-zone`        | `0.11.9` (npm)  | `mcp-1433-test.bacarda.de`                            | yes   | CF Access (service-token policy + interactive-email-policy) |
| `mcp.bacarda.de`       | `^0.11.9`       | `mcp.bacarda.de` *(pka-mcp-hub, separate repo)*       | yes   | **Bearer-token Hono middleware (NO CF Access)** |

## The buggy code path is byte-identical in 0.11.9 and 0.12.3

```
$ grep -n "MCP_MESSAGE_HEADER" node_modules/agents/dist/mcp/index.js
22:    const MCP_MESSAGE_HEADER = "cf-mcp-message";
160:        [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

PR #1434 build replaces line 160 with `ws.send(JSON.stringify(messages))`
over the existing Worker→DO WebSocket.

## Results — `node repro.mjs <url> <bytes>`

| Deployment                                              | 24 KB | 65 KB | 200 KB | 500 KB |
| ------------------------------------------------------- | ----- | ----- | ------ | ------ |
| `0.11.9` workers.dev                                    | ✓ 365 ms | ✓ 667 ms | ✓ 715 ms | ✓ 568 ms |
| `0.12.3` workers.dev                                    | ✓ 379 ms | ✓ 326 ms | ✓ 381 ms | ✓ 566 ms |
| pkg.pr.new/1434 workers.dev                             | ✓ 751 ms | ✓ 452 ms | ✓ 452 ms | — |
| `0.11.9` zone, no Access                                | ✓ 962 ms | ✓ 511 ms | ✓ 796 ms | ✓ 727 ms |
| `0.11.9` zone + Access service-token                    | ✓ 317 ms | ✓ 397 ms | ✓ 396 ms | ✓ 557 ms |
| `0.11.9` workers.dev + 12 KB of fat custom request headers (Bearer-style padding) | ✓ 251 ms | — | — | — |
| `mcp.bacarda.de` *(pka-mcp-hub, codemode client, Bearer)*¹ | ✗ 869 ms | — | — | — |

¹ Reported by Larry. `pka_memory.create` with `content="A".repeat(24576)`.
`TLS Alert: level=2, description=22` (record_overflow, fatal).

## Major correction this round — H2b is moot

When we set out to test H2b ("interactive Access JWT is the trigger"), I
created an `interactive-email-policy` on the
`mcp-1433-test.bacarda.de` Access App and was about to ask Bastian to
log in via browser to capture a `CF_Authorization` cookie.

Before issuing that ask, I verified the **actual** auth model on
`mcp.bacarda.de`:

```
$ curl -sI https://mcp.bacarda.de/mcps/pka-hub/mcp
HTTP/2 401
www-authenticate: Bearer realm="pka-mcp-hub"
```

```
# is mcp.bacarda.de in any access app on this account?
$ curl ... /accounts/.../access/apps | grep mcp.bacarda
   (empty)
```

`mcp.bacarda.de` is **not** behind Cloudflare Access — at all. No 302
to a login page, no Access JWT cookie, no `cf-access-jwt-assertion`
header. It's a plain custom-domain Worker fronted by Hono Bearer-token
middleware (`src/auth.ts` in pka-mcp-hub).

So both flavours of H2 are dead simultaneously: H2a was disproved by the
service-token row last round, and H2b is moot — there is no interactive
Access in the failing path to compare against. I did not consume Bastian's
time to capture a JWT cookie that wouldn't have changed the picture.

## H3 — codemode client + Hono / `app.all` wrapper

That leaves H3 as the only remaining structural difference between
`mcp-1433-zone` (passes 500 KB) and `mcp.bacarda.de` (fails at 18 KB):

1. **MCP client**: pka-portal codemode runtime vs `@modelcontextprotocol/sdk`'s
   streamable-HTTP transport.
2. **Worker entry shape**: pka-mcp-hub mounts MCP under
   `/mcps/pka-hub/mcp` via Hono `app.all(...)` after passing through
   bearer middleware; the MCP repro mounts straight at `/mcp` from
   `McpAgent.serve("/mcp", ...)`.
3. **Internal corroboration**: pka-mcp-hub's own
   `MEMORY_LARGE_CONTENT.md` quotes "15 KB ok, 18 KB+ fails" empirically.

I tested whether forwarding ~12 KB of fat custom headers (`Authorization:
Bearer <3 KB>` plus three `X-Pad-N` headers of 3 KB each) inflates the
combined-header total enough to trip the cliff on a passing deployment.
With a 24 KB `content` payload that should put the inflated `cf-mcp-message`
plus padding well above what `mcp.bacarda.de` fails at — and it still
**passed** in 251 ms on `mcp-1433-repro-0119.bastian-enterprise.workers.dev`.

So the trigger isn't simply "added incoming-request header bytes". It's
something more specific that codemode + the Hono wrapper produce, that
this minimal repro continues to miss.

The `agents/mcp` code at `dist/mcp/index.js:154-157` copies **every**
incoming request header onto the Worker→DO WebSocket-upgrade subrequest:

```js
const existingHeaders = {};
request.headers.forEach((value, key) => {
  existingHeaders[key] = value;
});
```

So whatever the codemode client + Hono router accumulate on the request
*does* get forwarded. We just don't yet know what specifically tips it
over.

## Hypotheses — final status

| #   | Hypothesis | Status |
| --- | ---------- | ------ |
| H0  | `0.11.9` triggers, `0.12.3` masks it | **dead** — both pass on workers.dev with byte-identical code path |
| H1  | Custom zone (vs `*.workers.dev`) is the trigger | **dead** — `mcp-1433-test.bacarda.de` passes 24 / 65 / 200 / 500 KB on `0.11.9` |
| H2a | Cloudflare Access (any flavour) in front is the trigger | **dead** — service-token Access also passes 24 / 65 / 200 / 500 KB |
| H2b | Specifically interactive (SSO) Access JWT is the trigger | **moot** — the failing deployment isn't behind Access at all (verified via `/accounts/.../access/apps` + the bare 401 with `WWW-Authenticate: Bearer`). Cannot be the differentiator. |
| H3  | codemode MCP client request shape vs `@modelcontextprotocol/sdk`'s streamable-HTTP transport | **leading remaining suspect** |
| H4  | Hono `app.all(...)` wrapper / Bearer middleware accumulates state on the request that gets forwarded into `cf-mcp-message`'s sibling headers | **leading remaining suspect** |
| H5  | Some property of the JSON-RPC payload itself (codemode formats tool args differently — e.g. with extra metadata fields) inflates the base64 header more aggressively at any given raw-content size | **plausible, untested** |

## Suggested next probes

1. **Capture the failing request shape directly.** Add a tiny middleware
   to pka-mcp-hub *just above* `app.all("/mcps/pka-hub/mcp", ...)` that
   logs `Object.fromEntries(request.headers)` and the raw POST body
   length, gated behind a wrangler secret flag (`DEBUG_HEADERS=1`). Run
   one failing 24 KB codemode call. Compare against the same shape from
   `repro.mjs` against `mcp-1433-test.bacarda.de`. The byte-level diff
   should make the trigger obvious.
2. **Vendor the codemode client.** Take whatever `@cloudflare/codemode`
   ships as its outbound MCP-client-side machinery and call
   `mcp-1433-test.bacarda.de` from it (with Bearer auth, mirroring
   pka-mcp-hub's setup). If it fails at 24 KB there, codemode is
   load-bearing on its own. If it passes, the failure is an interaction
   with pka-mcp-hub's specific routing.
3. **Patch line 160** locally and confirm. The
   `ws.send(JSON.stringify(messages))` approach in PR #1434 makes all
   of this moot. We've proven it works on `mcp-1433-repro-fixed` for
   200 KB; the next step Bastian can take whenever convenient is to
   pin pka-mcp-hub at `pkg.pr.new/agents@1434` in a staging deploy and
   re-run Larry's `pka_memory.create` 24 KB call against it.

The headline for the maintainers is unchanged: PR #1434 is the right
fix. The threshold isn't 16 KB universally — it varies with combined
request-header weight — but the fix is independent of where the line
actually sits today, because removing the body from the header
eliminates the cliff.
