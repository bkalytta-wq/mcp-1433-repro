/**
 * Minimal repro for cloudflare/agents#1433.
 *
 * Exposes a single MCP tool `dump_content` that accepts an arbitrary string
 * and returns its byte length and SHA-256 hash. With a content payload above
 * ~16 KB raw (~12 KB after base64 inflation push the cf-mcp-message header
 * past Cloudflare's combined ~32 KB header limit), the Worker→DO hop fails
 * with a TLSv1.3 record_overflow because the streamable-HTTP transport in
 * `agents` ships the JSON-RPC body inside the `cf-mcp-message` HTTP header.
 *
 * Bug only surfaces on a deployed Worker (real edge TLS), NOT in
 * `wrangler dev`. See README.md for the full repro flow.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = Record<string, never>;

export class DumpMCP extends McpAgent<Env, State, Record<string, never>> {
  server = new McpServer({
    name: "mcp-1433-repro",
    version: "0.0.0"
  });

  initialState: State = {};

  async init() {
    this.server.registerTool(
      "dump_content",
      {
        description:
          "Accepts an arbitrary string and returns its byte length and SHA-256 hash. Used to exercise the Worker→DO hop with large payloads.",
        inputSchema: { content: z.string() }
      },
      async ({ content }) => {
        const bytes = new TextEncoder().encode(content);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ length: bytes.byteLength, sha256: hex })
            }
          ]
        };
      }
    );
  }
}

export default DumpMCP.serve("/mcp", { binding: "DumpMCP" });
