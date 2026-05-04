# mcp-1433-repro

Minimal Cloudflare Worker reproducer for [cloudflare/agents#1433](https://github.com/cloudflare/agents/issues/1433) — *"MCP streamable-HTTP transport: large JSON-RPC payloads (>16 KB) fail with TLS record_overflow due to header-encoding"*.

> **Status (4 May 2026):** the bug as described in #1433 does **not** currently reproduce against the live Cloudflare edge with `agents@0.12.3`. Both the broken-upstream `main` branch and the patched `fixed` branch (`pkg.pr.new/agents@1434`) succeed at every payload size tested, including 24 KB, 65 KB, 200 KB, and 500 KB tool-call arguments. See [Findings](#findings) below. The repo is left up so maintainers can clone, deploy, and probe further on their own accounts/regions.

## What's in the repo

| Branch | `agents` version | Worker name | URL |
| --- | --- | --- | --- |
| `main` | `agents@0.12.3` (npm, contains `cf-mcp-message` base64-header path on lines `dist/mcp/index.js:160`) | `mcp-1433-repro` | https://mcp-1433-repro.bastian-enterprise.workers.dev |
| `fixed` | `pkg.pr.new/agents@1434` (PR #1434 build, replaces header path with `ws.send(JSON.stringify(messages))`) | `mcp-1433-repro-fixed` | https://mcp-1433-repro-fixed.bastian-enterprise.workers.dev |

Worker exposes one MCP tool, `dump_content`, that takes `{ content: string }` and returns `{ length, sha256 }` — purpose-built to stress the Worker→DO hop with arbitrarily large arguments.

## Repro

```bash
git clone https://github.com/bkalytta-wq/mcp-1433-repro
cd mcp-1433-repro
npm install
node repro.mjs https://mcp-1433-repro.bastian-enterprise.workers.dev/mcp 24576
```

The script does an MCP `initialize` + `tools/call dump_content` with `content = 'A'.repeat(N)` against the deployed Worker. Exit `0` on success, `1` on TLS / fetch failure (with explicit `record_overflow` detection in the error handler).

To deploy your own:

```bash
git checkout main      # or `fixed`
npm install
npx wrangler deploy    # uses your own wrangler-authed account
```

Adjust `account_id` in `wrangler.jsonc` to your own.

## Findings

The streamable-HTTP transport in `agents@0.12.3` does encode the entire JSON-RPC body as base64 into the `cf-mcp-message` request header on the Worker→DO WebSocket upgrade — confirmed in `node_modules/agents/dist/mcp/index.js:160`:

```js
[MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString("base64"),
```

Yet on the live edge, the request *succeeds* across every size we tried:

```text
=== MAIN (broken upstream agents@0.12.3) at 24 KB ===
✓ initialize ok (1297 ms)
✓ tools/call ok (379 ms)
  result: {"length":24576,"sha256":"3273059a02069cbd5b25084d8ca282b4e67da445a063259304ea1db981edda47"}

=== MAIN at 200 KB ===
✓ initialize ok (944 ms)
✓ tools/call ok (381 ms)
  result: {"length":200000,"sha256":"05ece9bde690bf39239aca4213a06d0a5ddb2eb6ec9ce0c2a5593bb1832f5b2a"}

=== FIXED (pkg.pr.new agents@1434) at 24 KB ===
✓ initialize ok (1154 ms)
✓ tools/call ok (751 ms)
  result: {"length":24576,"sha256":"3273059a02069cbd5b25084d8ca282b4e67da445a063259304ea1db981edda47"}

=== FIXED at 200 KB ===
✓ initialize ok (1066 ms)
✓ tools/call ok (452 ms)
  result: {"length":200000,"sha256":"05ece9bde690bf39239aca4213a06d0a5ddb2eb6ec9ce0c2a5593bb1832f5b2a"}
```

A raw `curl` POST with a 100 KB tool-call argument (≈ 133 KB after base64) also succeeds without TLS record_overflow. So either:

- the combined-headers limit on the internal Worker→DO hop has been raised since the original report, or
- the limit is account / region / runtime-version dependent and didn't apply to `bastian-enterprise.workers.dev` in `AMS-DOG` (CF colo we hit), or
- the original failures were caused by something adjacent (e.g. a particular header set being sent along with `cf-mcp-message`) that this minimal repro doesn't replicate.

The PR #1434 fix is still defensible on principle — keeping a JSON-RPC body out of an HTTP header is just the right shape for an internal hop and removes the ~32 KB cliff entirely — but a deployable, reliable reproducer that *fails* on `main` has not been achieved yet from this side.

## Files

- `src/server.ts` — `McpAgent` Durable Object exposing `dump_content`
- `wrangler.jsonc` — deploy config, DO migration
- `repro.mjs` — Node driver using `@modelcontextprotocol/sdk` streamable-HTTP client
- `package.json` — only difference between branches is the `agents` dep

## License

MIT
