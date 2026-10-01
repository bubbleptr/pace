// MCP server management for Settings: reads the global mcp.json, probes
// connection state, and performs add/remove/login/logout through Pi's own
// `pi mcp` implementation instead of a Pace-written MCP client, so transport
// choice, the OAuth rule, and the credential store always match the sessions.

import { homedir } from "node:os";
import { join } from "node:path";
import { runMcpCommand } from "@pace/pi-mcp/cli.js";
import {
  loadMcpConfig,
  updateMcpServerConfig,
  type McpServerEntry,
} from "@pace/pi-mcp/config.js";
import { McpOAuthCredentialStore } from "@pace/pi-mcp/oauth.js";
import type { McpExposure as PiMcpExposure } from "@earendil-works/pi-coding-agent";
import type {
  McpActionResult,
  McpAddServerInput,
  McpConfigReport,
  McpExposure,
  McpProbeReport,
  McpServerConfigItem,
  McpServerProbe,
  McpServerState,
} from "@pace/core";
import { openUrlInBrowser } from "./open-url";

// @pace/core re-declares Pi's exposure union so the renderer never imports the
// engine. Both directions are asserted: a Pi release that widens or narrows it
// fails typecheck here instead of silently drifting.
type McpExposureMatchesPi = [McpExposure] extends [PiMcpExposure]
  ? [PiMcpExposure] extends [McpExposure]
    ? true
    : never
  : never;
const mcpExposureMatchesPi: McpExposureMatchesPi = true;
void mcpExposureMatchesPi;

export type McpServersService = {
  getConfig(): Promise<McpConfigReport>;
  probe(): Promise<McpProbeReport>;
  login(name: string): Promise<McpActionResult>;
  logout(name: string): Promise<McpActionResult>;
  setEnabled(name: string, enabled: boolean): Promise<McpConfigReport>;
  setExposure(name: string, exposure: McpExposure): Promise<McpConfigReport>;
  add(input: McpAddServerInput): Promise<McpActionResult>;
  remove(name: string): Promise<McpActionResult>;
};

export type McpServersServiceOptions = {
  agentDir: string;
  /** Opens the OAuth authorization URL; defaults to the platform browser. */
  openExternalUrl?: (url: string) => void | Promise<void>;
};

/** Shape of the `pi mcp list --json` payload (extensions/mcp/cli.js `list()`). */
type PiMcpListOutput = {
  servers?: Array<{
    name: string;
    scope?: string;
    source?: string;
    enabled?: boolean;
    exposure?: McpExposure;
    transport?: string;
    state?: McpServerState;
    tools?: string[];
    toolExposure?: Record<string, McpExposure>;
    resources?: number;
    resourceTemplates?: number;
    error?: string;
  }>;
  errors?: string[];
  note?: string;
};

type CapturedRun = {
  exitCode: number;
  out: string[];
  err: string[];
};

// Mirrors usesOAuth() in Pi's extensions/mcp/runtime.js: HTTP servers
// authenticate with OAuth unless the config supplies an Authorization header.
function hasAuthorizationHeader(headers: Record<string, string> | undefined) {
  return Object.keys(headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

function requiredName(name: string) {
  if (!name.trim()) {
    throw new Error("MCP server name is required.");
  }
}

function toConfigItem(
  entry: McpServerEntry,
  credentials: McpOAuthCredentialStore,
): McpServerConfigItem {
  const { config } = entry;
  const http = "url" in config;
  const usesOAuth = http && !hasAuthorizationHeader(config.headers);
  return {
    name: entry.name,
    source: entry.source,
    enabled: config.enabled !== false,
    exposure: config.exposure ?? "codemode",
    kind: http ? "http" : "stdio",
    transport: http
      ? config.url
      : [config.command, ...(config.args ?? [])].join(" "),
    usesOAuth,
    // Read through Pi's own store so "signed in" matches what `pi mcp
    // logout` would remove; keyed by the normalized URL.
    hasStoredCredentials:
      usesOAuth && credentials.tokens(config.url) !== undefined,
  };
}

export function createMcpServersService(
  options: McpServersServiceOptions,
): McpServersService {
  const configPath = join(options.agentDir, "mcp.json");
  const openExternal = options.openExternalUrl ?? openUrlInBrowser;
  // homedir() as cwd keeps the project file (<cwd>/.pi/mcp.json) unrelated to
  // any real project; servers are additionally filtered to the global file.
  const commandBase = { cwd: homedir(), agentDir: options.agentDir };

  async function runCommand(args: string[]): Promise<CapturedRun> {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runMcpCommand(args, {
      ...commandBase,
      // Passing openUrl also makes `login` non-interactive (no stdin prompt);
      // other subcommands ignore it.
      openUrl: openExternal,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { exitCode, out, err };
  }

  function toActionResult(run: CapturedRun): McpActionResult {
    const ok = run.exitCode === 0;
    const lines = ok ? run.out : run.err.length > 0 ? run.err : run.out;
    return { ok, message: lines.join("\n") };
  }

  async function getConfig(): Promise<McpConfigReport> {
    const loaded = loadMcpConfig({
      agentDir: options.agentDir,
      cwd: commandBase.cwd,
      projectTrusted: false,
    });
    // The default store resolves <agentDir>/mcp-auth.json via Pi's getAgentDir(),
    // the same store runMcpCommand's commands read.
    const credentials = new McpOAuthCredentialStore();
    return {
      configPath,
      servers: loaded.servers
        .filter((entry) => entry.scope === "global" && entry.source === configPath)
        .map((entry) => toConfigItem(entry, credentials)),
      errors: loaded.errors,
    };
  }

  return {
    getConfig,

    async probe() {
      // `list` exits 1 when any server failed to connect; that is a probe
      // result, not a command failure, so the output is still parsed.
      const run = await runCommand(["list", "--json"]);
      const payload = run.out.find((line) => line.trimStart().startsWith("{"));
      let parsed: PiMcpListOutput;
      try {
        parsed = JSON.parse(payload ?? "") as PiMcpListOutput;
      } catch {
        throw new Error(
          `"pi mcp list --json" output did not parse: ${[...run.out, ...run.err].join("\n")}`,
        );
      }
      const servers: McpServerProbe[] = (parsed.servers ?? [])
        .filter(
          (server) =>
            (server.scope ?? "global") === "global" && server.source === configPath,
        )
        .map((server) => ({
          name: server.name,
          state: server.state ?? "failed",
          tools: server.tools ?? [],
          ...(server.toolExposure ? { toolExposure: server.toolExposure } : {}),
          ...(server.resources !== undefined
            ? { resources: server.resources }
            : {}),
          ...(server.resourceTemplates !== undefined
            ? { resourceTemplates: server.resourceTemplates }
            : {}),
          ...(server.error ? { error: server.error } : {}),
        }));
      return { servers, errors: parsed.errors ?? [] };
    },

    async login(name) {
      requiredName(name);
      return toActionResult(
        await runCommand(["login", name, "--timeout", "120"]),
      );
    },

    async logout(name) {
      requiredName(name);
      return toActionResult(await runCommand(["logout", name]));
    },

    async setEnabled(name, enabled) {
      requiredName(name);
      updateMcpServerConfig(configPath, name, { enabled });
      return getConfig();
    },

    async setExposure(name, exposure) {
      requiredName(name);
      updateMcpServerConfig(configPath, name, { exposure });
      return getConfig();
    },

    async add(input) {
      requiredName(input.name);
      const exposureArgs = input.exposure
        ? ["--exposure", input.exposure]
        : [];
      const args =
        input.kind === "http"
          ? (() => {
              if (!input.url.trim()) {
                throw new Error("MCP server URL is required.");
              }
              return ["add", input.name, ...exposureArgs, "--url", input.url];
            })()
          : (() => {
              if (!input.command.trim()) {
                throw new Error("MCP server command is required.");
              }
              return [
                "add",
                input.name,
                ...exposureArgs,
                "--",
                input.command,
                ...input.args,
              ];
            })();
      return toActionResult(await runCommand(args));
    },

    async remove(name) {
      requiredName(name);
      return toActionResult(await runCommand(["remove", name]));
    },
  };
}
