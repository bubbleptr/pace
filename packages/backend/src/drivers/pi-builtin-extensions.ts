import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * SDK sessions do not load Pi's built-in extensions, so Pace supplies the same
 * set the CLI registers (llama.cpp is intentionally left out for now). Keeping
 * the CLI's `builtin: true` + `replaceable: true` shape makes `-builtin:<name>`
 * in the `extensions` setting and third-party replacement (e.g. an extension
 * registering `codemode` or `/mcp`) behave exactly like the CLI. Factories take
 * no options so user settings (`codemode.mode`, MCP servers, ...) apply.
 */
export function createPaceBuiltInExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
  ];
}
