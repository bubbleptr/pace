// MCP server management contracts for the Settings MCP section. Pace reuses
// Pi's own `pi mcp` implementation (backend path alias @pace/pi-mcp); these
// types mirror Pi's reports so the renderer never imports the engine.

export type McpExposure =
  | "codemode"
  | "deferred"
  | "direct"
  | "hidden";

export type McpServerState =
  | "connected"
  | "needs-auth"
  | "failed"
  | "disconnected"
  | "connecting"
  | "disabled";

/** One server as the global mcp.json defines it, before any connection probe. */
export type McpServerConfigItem = {
  name: string;
  /** The mcp.json file that defines the server. */
  source: string;
  enabled: boolean;
  exposure: McpExposure;
  kind: "stdio" | "http";
  /** The command line for stdio servers, the URL for HTTP servers. */
  transport: string;
  /** Pi's OAuth rule: HTTP without an Authorization header. */
  usesOAuth: boolean;
  /** OAuth tokens for this server's URL exist in Pi's mcp-auth.json. */
  hasStoredCredentials: boolean;
};

export type McpConfigReport = {
  configPath: string;
  servers: McpServerConfigItem[];
  errors: string[];
};

/** One server's probed state from `pi mcp list --json`. */
export type McpServerProbe = {
  name: string;
  state: McpServerState;
  tools: string[];
  toolExposure?: Record<string, McpExposure>;
  resources?: number;
  resourceTemplates?: number;
  error?: string;
};

export type McpProbeReport = {
  servers: McpServerProbe[];
  errors: string[];
};

export type McpActionResult = {
  ok: boolean;
  message: string;
};

export type McpAddServerInput =
  | {
      kind: "stdio";
      name: string;
      command: string;
      args: string[];
      exposure?: McpExposure;
    }
  | {
      kind: "http";
      name: string;
      url: string;
      exposure?: McpExposure;
    };
