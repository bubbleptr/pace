import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfigItem } from "@pace/core";
import { createMcpServersService } from "./mcp-servers";

// Contract test against the real @earendil-works/pi-coding-agent package: it
// must break when a Pi upgrade changes the mcp.json shape, the `pi mcp`
// argument syntax, or the `list --json` report the service parses.

const tempDirs: string[] = [];

let agentDir: string;

async function writeMcpJson(dir: string, value: unknown) {
  await writeFile(join(dir, "mcp.json"), JSON.stringify(value, null, 2));
}

async function readMcpJson(dir: string) {
  return JSON.parse(await readFile(join(dir, "mcp.json"), "utf8"));
}

function serversByName(servers: McpServerConfigItem[]) {
  return new Map(servers.map((server) => [server.name, server]));
}

describe("mcp-servers service", () => {
  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pigui-mcp-"));
    tempDirs.push(agentDir);
    // runMcpCommand resolves mcp-auth.json through Pi's getAgentDir(), which
    // reads PI_CODING_AGENT_DIR at call time; without the stub the default
    // credential store would read the real ~/.pi/agent.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reports the global mcp.json servers", async () => {
    await writeMcpJson(agentDir, {
      mcpServers: {
        "stdio-one": { command: "node", args: ["server.js", "--flag"] },
        "http-oauth": { url: "https://example.com/mcp" },
        "http-keyed": {
          url: "https://example.com/keyed",
          headers: { AUTHORIZATION: "Bearer token" },
        },
        "disabled-one": { command: "node", enabled: false },
        "direct-one": { command: "node", exposure: "direct" },
      },
    });

    const report = await createMcpServersService({ agentDir }).getConfig();

    expect(report.configPath).toBe(join(agentDir, "mcp.json"));
    expect(report.errors).toEqual([]);
    const servers = serversByName(report.servers);
    expect([...servers.keys()].sort()).toEqual([
      "direct-one",
      "disabled-one",
      "http-keyed",
      "http-oauth",
      "stdio-one",
    ]);
    expect(servers.get("stdio-one")).toMatchObject({
      kind: "stdio",
      transport: "node server.js --flag",
      usesOAuth: false,
      enabled: true,
      exposure: "codemode",
    });
    expect(servers.get("http-oauth")).toMatchObject({
      kind: "http",
      transport: "https://example.com/mcp",
      usesOAuth: true,
    });
    // An Authorization header under any casing opts out of OAuth.
    expect(servers.get("http-keyed")?.usesOAuth).toBe(false);
    expect(servers.get("disabled-one")?.enabled).toBe(false);
    expect(servers.get("direct-one")?.exposure).toBe("direct");
  });

  it("reports mcp.json parse errors without servers", async () => {
    await writeFile(join(agentDir, "mcp.json"), "{ not json");

    const report = await createMcpServersService({ agentDir }).getConfig();

    expect(report.servers).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("reports an empty config when mcp.json does not exist", async () => {
    const report = await createMcpServersService({ agentDir }).getConfig();

    expect(report).toEqual({
      configPath: join(agentDir, "mcp.json"),
      servers: [],
      errors: [],
    });
  });

  it("probes server states through pi mcp list --json", async () => {
    await writeMcpJson(agentDir, {
      mcpServers: {
        off: { command: "pigui-no-such-command", enabled: false },
        broken: { command: "pigui-no-such-command", timeout: 5 },
      },
    });

    const report = await createMcpServersService({ agentDir }).probe();

    expect(report.errors).toEqual([]);
    const servers = new Map(report.servers.map((server) => [server.name, server]));
    expect(servers.get("off")).toMatchObject({ state: "disabled", tools: [] });
    const broken = servers.get("broken");
    expect(broken?.state).toBe("failed");
    expect(broken?.error).toBeTruthy();
  });

  it("probes an empty report when no servers are configured", async () => {
    const report = await createMcpServersService({ agentDir }).probe();

    expect(report).toEqual({ servers: [], errors: [] });
  });

  it("writes enabled and exposure changes back to mcp.json", async () => {
    await writeMcpJson(agentDir, {
      mcpServers: { srv: { command: "node", enabled: false } },
    });
    const service = createMcpServersService({ agentDir });

    const enabledReport = await service.setEnabled("srv", true);
    expect(serversByName(enabledReport.servers).get("srv")?.enabled).toBe(true);
    // `enabled: true` is the default, so Pi removes the key.
    expect((await readMcpJson(agentDir)).mcpServers.srv.enabled).toBeUndefined();

    const disabledReport = await service.setEnabled("srv", false);
    expect(serversByName(disabledReport.servers).get("srv")?.enabled).toBe(false);
    expect((await readMcpJson(agentDir)).mcpServers.srv.enabled).toBe(false);

    const exposureReport = await service.setExposure("srv", "direct");
    expect(serversByName(exposureReport.servers).get("srv")?.exposure).toBe("direct");
    expect((await readMcpJson(agentDir)).mcpServers.srv.exposure).toBe("direct");

    // `codemode` is the default exposure, so Pi removes the key.
    const codemodeReport = await service.setExposure("srv", "codemode");
    expect(serversByName(codemodeReport.servers).get("srv")?.exposure).toBe("codemode");
    expect((await readMcpJson(agentDir)).mcpServers.srv.exposure).toBeUndefined();
  });

  it("adds and removes servers in mcp.json", async () => {
    const service = createMcpServersService({ agentDir });

    const addedStdio = await service.add({
      kind: "stdio",
      name: "echo",
      command: "node",
      args: ["echo.js"],
    });
    expect(addedStdio.ok).toBe(true);
    const addedHttp = await service.add({
      kind: "http",
      name: "docs",
      url: "https://example.com/mcp",
      exposure: "direct",
    });
    expect(addedHttp.ok).toBe(true);

    const file = await readMcpJson(agentDir);
    expect(file.mcpServers.echo).toMatchObject({
      command: "node",
      args: ["echo.js"],
    });
    expect(file.mcpServers.docs).toMatchObject({
      url: "https://example.com/mcp",
      exposure: "direct",
    });

    const removed = await service.remove("echo");
    expect(removed.ok).toBe(true);
    expect((await readMcpJson(agentDir)).mcpServers.echo).toBeUndefined();

    const missing = await service.remove("echo");
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("echo");
  });

  it("rejects invalid add input without touching mcp.json", async () => {
    await writeMcpJson(agentDir, { mcpServers: { keep: { command: "node" } } });
    const before = await readFile(join(agentDir, "mcp.json"), "utf8");
    const service = createMcpServersService({ agentDir });

    await expect(
      service.add({ kind: "stdio", name: "", command: "node", args: [] }),
    ).rejects.toThrow();
    await expect(
      service.add({ kind: "stdio", name: "x", command: " ", args: [] }),
    ).rejects.toThrow();
    await expect(
      service.add({ kind: "http", name: "x", url: "" }),
    ).rejects.toThrow();

    expect(await readFile(join(agentDir, "mcp.json"), "utf8")).toBe(before);
  });

  it("fails logout for a server that does not use OAuth", async () => {
    await writeMcpJson(agentDir, {
      mcpServers: { stdio: { command: "node" } },
    });

    const result = await createMcpServersService({ agentDir }).logout("stdio");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not use OAuth");
  });
});
