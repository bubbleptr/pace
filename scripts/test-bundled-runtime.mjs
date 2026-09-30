import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the release declares an exact Pi engine combination", async () => {
  const { dependencies } = JSON.parse(await readFile(join(repo, "packages/backend/package.json"), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.match(dependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be pinned before release`);
    const installed = JSON.parse(await readFile(join(repo, "packages/backend/node_modules", name, "package.json"), "utf8"));
    assert.equal(installed.version, dependencies[name]);
  }
});

test("the shipped backend works without global pi or repository node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigui-bundled-runtime-"));
  try {
    const appDir = join(root, "app");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await cp(join(repo, "apps/desktop/out/main"), join(appDir, "out/main"), { recursive: true });
    await cp(join(repo, "apps/desktop/package.json"), join(appDir, "package.json"));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd);
    const secondCwd = join(root, "second-project");
    await mkdir(secondCwd);
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      openai: { type: "api_key", key: "bundled-runtime-test-placeholder" },
    }));
    await writeFile(join(agentDir, "extensions/working.ts"), `
      import assert from "node:assert/strict";
      import { Type } from "typebox";
      import { initTheme, getMarkdownTheme, resizeImage } from "@earendil-works/pi-coding-agent";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        const key = Symbol.for("pace.bundle-process-probe");
        globalThis[key] = (globalThis[key] ?? 0) + 1;
        pi.registerTool({ name: "bundle_probe", label: "Probe", description: "Bundled extension probe",
          parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
        pi.on("session_start", async (_event, ctx) => {
          writeFileSync(join(ctx.cwd, "started.txt"), "ready");
          writeFileSync(join(ctx.cwd, "process.json"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), starts: globalThis[key] }));
        });
        pi.on("session_shutdown", async (_event, ctx) => { writeFileSync(join(ctx.cwd, "closed.txt"), "closed"); });
        pi.registerCommand("bundle-probe", { description: "Probe command", handler: async (_args, ctx) => {
          for (const name of ["dark", "light"]) {
            initTheme(name);
            assert.match(getMarkdownTheme().heading("theme-probe"), /theme-probe/);
          }
          const image = await resizeImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=", "base64"), "image/png", { maxWidth: 1, maxHeight: 1 });
          assert.equal(image?.width, 1, "the Photon WASM module must load");
          writeFileSync(join(ctx.cwd, "command.txt"), "themes-and-image-ready");
        } });
      }
    `);
    await writeFile(join(agentDir, "extensions/broken.ts"), `export default function() { throw new Error("EXTENSION_LOAD_PROBE"); }`);
    const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const pending = new Map();
      const events = [];
      let receive;
      let control;
      let connected;
      const ready = new Promise(resolve => { connected = resolve; });
      process.parentPort = { on(_name, connect) {
        control = connect;
        connect({ data: { type: "connect" }, ports: [{
          on(event, handler) { if (event === "message") { receive = handler; connected(); } }, start() {},
          postMessage(message) {
            if (message.type === "event") events.push(message.event);
            else { pending.get(message.id)?.(message); pending.delete(message.id); }
          },
        }] });
      }, postMessage() {} };
      await import(pathToFileURL(process.env.PROBE_BACKEND));
      await ready;
      let sequence = 0;
      const request = (method, params) => new Promise(resolve => {
        const id = String(++sequence); pending.set(id, resolve); receive({ data: { id, method, params } });
      });
      const preflight = await request("run_environment_preflight");
      const created = await request("create_session", { sessionId: "probe", projectId: "probe", cwd: process.env.PROBE_CWD });
      const piSessionId = created.result?.piSessionId;
      const tools = piSessionId ? await request("resolve_tool_schemas", { piSessionId, names: ["bundle_probe"] }) : null;
      const prompted = piSessionId ? await request("send_prompt", { piSessionId, prompt: "/bundle-probe" }) : null;
      const snapshot = piSessionId ? await request("get_runtime_snapshot", { piSessionId }) : null;
      const second = await request("create_session", { sessionId: "second", projectId: "second", cwd: process.env.PROBE_SECOND_CWD });
      const removed = await request("delete_session", { sessionId: "probe" });
      const survivor = second.result?.piSessionId ? await request("get_runtime_snapshot", { piSessionId: second.result.piSessionId }) : null;
      await control({ data: { type: "shutdown" } });
      console.log("PROBE_RESULT " + JSON.stringify({ preflight, created, tools, prompted, snapshot, second, removed, survivor, events }));
    `], {
      cwd,
      env: {
        ...process.env,
        PATH: "",
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PACE_DATA_DIR: join(root, "data"),
        PROBE_BACKEND: join(appDir, "out/main/backend.js"),
        PI_PACKAGE_DIR: join(appDir, "out/main/pi-assets"),
        PROBE_CWD: cwd,
        PROBE_SECOND_CWD: secondCwd,
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("PROBE_RESULT ")).slice(13));
    if (stderr) console.error(stderr);
    assert.equal(result.created.error, undefined);
    assert.equal(result.second.error, undefined);
    assert.equal(result.removed.error, undefined);
    assert.equal(result.survivor.error, undefined);
    const firstProcess = JSON.parse(await readFile(join(cwd, "process.json"), "utf8"));
    const secondProcess = JSON.parse(await readFile(join(secondCwd, "process.json"), "utf8"));
    assert.notEqual(firstProcess.pid, secondProcess.pid, "root Sessions must have separate processes");
    assert.equal(firstProcess.starts, 1, "plugin globals must belong to one root Session");
    assert.equal(secondProcess.starts, 1);
    assert.equal(await readFile(join(cwd, "closed.txt"), "utf8"), "closed");
    assert.equal(await readFile(join(secondCwd, "closed.txt"), "utf8"), "closed");
    assert.ok(result.created.result.events.some(event => event.payload.code === "extension_load_error"), "startup errors must be in the first snapshot");
    assert.ok(result.tools?.result?.schemas?.bundle_probe, "the extension must resolve bundled peer modules");
    assert.equal(await readFile(join(cwd, "started.txt"), "utf8"), "ready", "session_start must run");
    assert.equal(result.prompted?.error, undefined, JSON.stringify(result.snapshot));
    assert.equal(await readFile(join(cwd, "command.txt"), "utf8"), "themes-and-image-ready", "native commands, built-in themes, and Photon must run");
    assert.ok(result.snapshot?.result?.events?.some(event => JSON.stringify(event.payload).includes("EXTENSION_LOAD_PROBE")), "load errors must survive gateway replay");
    assert.equal(result.preflight.result?.canContinue, true, "a global CLI must not be required");
    const runtimeCheck = result.preflight.result.checks.find(check => check.id === "pi_runtime");
    const appPackage = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
    const piPackage = JSON.parse(await readFile(join(repo, "packages/backend/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    assert.equal(runtimeCheck.detail, `Pace ${appPackage.version} · Pi ${piPackage.version} · SDK`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codemode scripts reach MCP tools in the shipped backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigui-bundled-codemode-"));
  const requests = [];
  let serial = 0;
  // Same SSE shape as the openai-completions mock in e2e/smoke/extension-runner.spec.ts.
  const emit = (response, text, tool) => {
    const id = `fixture-${++serial}`;
    const base = { id, object: "chat.completion.chunk", created: 1, model: "probe" };
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: "assistant", content: text };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages?.at(-1);
    const isToolResult = last?.role === "tool";
    requests.push({ index: requests.length, isToolResult, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Requests without a tools array are side calls like session auto-title.
    if (!Array.isArray(body.tools) || isToolResult) emit(response, "DONE");
    else emit(response, "", { name: "codemode", args: { code: 'const r = await tools.mcp__probe__echo({ text: "bundled" }); return r.content[0].text;' } });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    const appDir = join(root, "app");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await cp(join(repo, "apps/desktop/out/main"), join(appDir, "out/main"), { recursive: true });
    await cp(join(repo, "apps/desktop/package.json"), join(appDir, "package.json"));
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd);
    // A newline-delimited JSON-RPC stdio MCP server. `process.execPath` is an
    // absolute path because the probe environment empties PATH.
    const mcpServer = join(root, "probe-mcp.mjs");
    await writeFile(mcpServer, `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
        const fail = (code, text) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: text } }) + "\\n");
        if (message.method === "initialize") respond({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } });
        else if (message.method === "ping") respond({});
        else if (message.method === "tools/list") respond({ tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
        else if (message.method === "tools/call") respond({ content: [{ type: "text", text: "ECHO:" + (message.params?.arguments?.text ?? "") }] });
        else fail(-32601, "Method not found");
      });
    `);
    // Default exposure ("codemode") keeps the MCP tool out of the model's tool
    // declarations and auto-activates the codemode tool, so the model sees
    // `codemode` and reaches `mcp__probe__echo` only from scripts.
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { probe: { command: process.execPath, args: [mcpServer] } },
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "pace-test": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "bundled-runtime-test-placeholder",
          models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "pace-test",
      defaultModel: "probe",
      defaultThinkingLevel: "off",
    }));
    const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const pending = new Map();
      const events = [];
      let receive;
      let control;
      let connected;
      const ready = new Promise(resolve => { connected = resolve; });
      process.parentPort = { on(_name, connect) {
        control = connect;
        connect({ data: { type: "connect" }, ports: [{
          on(event, handler) { if (event === "message") { receive = handler; connected(); } }, start() {},
          postMessage(message) {
            if (message.type === "event") events.push(message.event);
            else { pending.get(message.id)?.(message); pending.delete(message.id); }
          },
        }] });
      }, postMessage() {} };
      await import(pathToFileURL(process.env.PROBE_BACKEND));
      await ready;
      let sequence = 0;
      const request = (method, params) => new Promise(resolve => {
        const id = String(++sequence); pending.set(id, resolve); receive({ data: { id, method, params } });
      });
      const created = await request("create_session", { sessionId: "probe", projectId: "probe", cwd: process.env.PROBE_CWD });
      const piSessionId = created.result?.piSessionId;
      let prompted;
      let snapshot;
      if (piSessionId) {
        prompted = request("send_prompt", { piSessionId, prompt: "run the probe" });
        const deadline = Date.now() + 45000;
        do {
          await new Promise(resolve => setTimeout(resolve, 250));
          snapshot = await request("get_runtime_snapshot", { piSessionId });
        } while (snapshot.result?.status === "running" && Date.now() < deadline);
        prompted = await prompted;
      }
      await control({ data: { type: "shutdown" } });
      console.log("PROBE_RESULT " + JSON.stringify({ created, prompted, snapshot, events }));
    `], {
      cwd,
      env: {
        ...process.env,
        PATH: "",
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PACE_DATA_DIR: join(root, "data"),
        PROBE_BACKEND: join(appDir, "out/main/backend.js"),
        PI_PACKAGE_DIR: join(appDir, "out/main/pi-assets"),
        PROBE_CWD: cwd,
      },
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("PROBE_RESULT ")).slice(13));
    if (stderr) console.error(stderr);
    assert.equal(result.created.error, undefined);
    assert.equal(result.prompted?.error, undefined, JSON.stringify(result.snapshot).slice(0, 2000));
    // Side calls like session auto-title hit the same endpoint without tools;
    // the run's own model calls always carry the tool declarations.
    const runRequests = requests.filter((entry) => Array.isArray(entry.body.tools));
    const declaredTools = runRequests[0]?.body.tools.map((tool) => tool.function?.name ?? tool.name) ?? [];
    assert.ok(declaredTools.includes("codemode"), `the first request must declare the codemode tool, got ${JSON.stringify(declaredTools)}`);
    assert.equal(runRequests.length, 2, `expected a tool call and a follow-up request, got ${runRequests.length}`);
    const codemodeEnd = result.events.find((event) =>
      event.payload?.type === "tool" && event.payload?.phase === "end" && event.payload?.name === "codemode");
    assert.ok(codemodeEnd, "the runtime events must contain a codemode tool end");
    assert.ok(!codemodeEnd.payload.isError, `codemode must not error: ${JSON.stringify(codemodeEnd.payload.result).slice(0, 2000)}`);
    assert.ok(JSON.stringify(codemodeEnd.payload.result).includes("ECHO:bundled"), `the codemode result must include the MCP echo: ${JSON.stringify(codemodeEnd.payload.result).slice(0, 2000)}`);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
