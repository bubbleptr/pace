// Dependency-free MCP test server for the mcp-servers contract tests.
// `handleMcpMessage` is shared by the stdio transport below and the in-process
// HTTP server the tests spin up, so both transports exercise the same handler.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function replyError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Answer one JSON-RPC request. Notifications (no id) return undefined — the
 * transport must not send a response for them.
 */
export function handleMcpMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return replyError(null, -32600, "Invalid Request");
  }
  if (message.id === undefined || message.id === null) {
    return undefined;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      // The client rejects a protocolVersion it does not support; echoing the
      // requested version always lands inside its supported list.
      const requested = params?.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "pace-mcp-test", version: "1.0.0" },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name === "echo") {
        return reply(id, {
          content: [{ type: "text", text: String(args?.text ?? "") }],
        });
      }
      if (name === "add") {
        return reply(id, {
          content: [
            { type: "text", text: String(Number(args?.a) + Number(args?.b)) },
          ],
        });
      }
      return reply(id, {
        isError: true,
        content: [{ type: "text", text: `Unknown tool "${name}".` }],
      });
    }
    default:
      return replyError(id, -32601, `Unknown method "${method}".`);
  }
}

// Pi's StdioTransport frames messages as newline-delimited JSON.
const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify(replyError(null, -32700, "Parse error"))}\n`,
        );
        continue;
      }
      const response = handleMcpMessage(message);
      if (response !== undefined) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
  });
}
