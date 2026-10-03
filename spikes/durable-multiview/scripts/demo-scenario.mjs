// P4 proof: the on-call scenario (HANDOFF §6) on one scripted-model host, walked through Pace's
// dev page, the web page and the TUI at once. One kill -9 and one hot reload on the way.
// A node client watches alongside to check what the screens cannot show. Isolated like
// three-clients.mjs: its own ports, Pace profile, data and agent dirs, and a copy of the
// investigation module to edit.
//
//   node scripts/demo-scenario.mjs [evidence-dir]    # default: a new temp dir, printed at the end
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@lydell/node-pty";
import { chromium } from "@playwright/test";
import xterm from "@xterm/headless";
import { connectRemoteDurable } from "../protocol/remote-durable.ts";

const spike = fileURLToPath(new URL("..", import.meta.url));
const repo = resolve(spike, "../..");
const T = mkdtempSync(join(tmpdir(), "dmv-demo-"));
const hostDir = join(T, "agent/experimental/durable-multiview/default");
mkdirSync(join(T, "data"), { recursive: true });
writeFileSync(join(T, "data/preflight-status.json"), JSON.stringify({ completedAt: "2026-10-02T00:00:00.000Z" }));
// The host must import the copy with the spike's node_modules in reach, so it lives in the spike.
const moduleDir = join(spike, ".tmp", `scenario-${process.pid}`);
mkdirSync(moduleDir, { recursive: true });
const investigation = join(moduleDir, "investigation.ts");
copyFileSync(join(spike, "host/demo/investigation.ts"), investigation);
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const [PORT, cdpPort, pacePort, webPort] = await Promise.all(Array.from({ length: 4 }, freePort));
const paceConfig = join(moduleDir, "electron.vite.config.mjs");
writeFileSync(paceConfig, `import config from ${JSON.stringify(join(repo, "apps/desktop/electron.vite.config.ts"))};
config.renderer.server.port = ${pacePort};
config.renderer.cacheDir = ${JSON.stringify(join(T, "vite-cache"))};
export default config;
`);
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "dmv-demo-evidence-")));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let paceLog = "";
let screenAtFailure;
let pagesAtFailure;
let observer;
let browser;

console.log(`Evidence: ${out}`);

async function readyLine(child, predicate, label) {
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => lines.close(), 30_000);
  try {
    for await (const line of lines) if (predicate(line)) return line;
    throw new Error(`${label} did not become ready (exit ${child.exitCode})`);
  } finally {
    clearTimeout(timeout);
    lines.close();
  }
}

async function startHost() {
  const args = ["host/main.ts", "--faux-demo", "--data-dir", hostDir, "--cwd", T, "--port", String(PORT), "--lock-stale-ms", "2000"];
  args.push("--browser-origin", `http://127.0.0.1:${webPort}`, "--faux-tps", "60", "--pace-ms", "300", "--step-ms", "1500", "--reminder-seconds", "8", "--investigation-module", investigation);
  const host = spawn(process.execPath, args, { cwd: spike, stdio: ["ignore", "pipe", "inherit"] });
  children.push(host);
  const ready = JSON.parse(await readyLine(host, (line) => line.startsWith("{") && JSON.parse(line).event === "ready", "host"));
  const token = readFileSync(ready.tokenFile, "utf8").trim();
  const web = new URL(ready.web);
  web.hash = new URLSearchParams({ token, url: ready.url }).toString();
  return { host, ready: { ...ready, token, web: web.href } };
}
async function until(what, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
  console.log("  ok:", what);
}
const step = (title) => console.log(`\n${title}`);

try {
  let { host, ready } = await startHost();
  observer = await connectRemoteDurable({ url: ready.url, token: ready.token, clientName: "observer", reconnectDelayMs: { min: 100, max: 500 } });
  await observer.controller.toggleTasks();
  const seen = () => observer.view.current();
  const subagents = () => seen().conversations.filter((summary) => summary.label.startsWith("subagent"));

  const pace = spawn(join(repo, "node_modules/.bin/electron-vite"), ["dev", "--config", paceConfig, "--remoteDebuggingPort", String(cdpPort), "--", `--user-data-dir=${join(T, "profile")}`], {
    cwd: join(repo, "apps/desktop"),
    env: { ...process.env, PACE_DATA_DIR: join(T, "data"), PI_CODING_AGENT_DIR: join(T, "agent"), PACE_DURABLE_SPIKE_URL: ready.url, PACE_E2E: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(pace);
  pace.stdout.on("data", (d) => (paceLog += d));
  pace.stderr.on("data", (d) => (paceLog += d));
  let cdp;
  await until("Pace CDP", async () => {
    if (pace.exitCode !== null) throw new Error(`Pace exited before CDP was ready (${pace.exitCode})`);
    try { cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true; } catch { return false; }
  }, 90000);
  let p;
  await until("Pace window", async () => { p = cdp.contexts().flatMap((c) => c.pages()).find((page) => page.url().startsWith(`http://127.0.0.1:${pacePort}`)); return p !== undefined; });
  await p.waitForLoadState("domcontentloaded");
  await p.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await p.evaluate(() => { window.location.hash = "#/durable-spike"; });
  await until("Pace page connected", async () => (await p.getByText("Durable host").count()) > 0, 30000);

  const webServer = spawn(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "--config", "web/vite.config.ts", "--port", String(webPort), "--strictPort"], { cwd: spike, stdio: ["ignore", "pipe", "inherit"] });
  children.push(webServer);
  await readyLine(webServer, (line) => line.includes(`:${webPort}/`), "web server");
  browser = await chromium.launch();
  const w = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const webUrl = new URL(ready.web);
  webUrl.port = String(webPort);
  await w.goto(webUrl.href);
  pagesAtFailure = { pace: p, web: w };
  await until("web connected", async () => (await w.getByText("Durable host").count()) > 0);

  const cols = 140, rows = 44;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  mkdirSync(join(T, "tui-agent"), { recursive: true });
  const tui = spawnPty(process.execPath, ["tui/main.ts", "--url", ready.url, "--token", ready.token], { cols, rows, cwd: spike, env: { ...process.env, PI_CODING_AGENT_DIR: join(T, "tui-agent"), TERM: "xterm-256color" } });
  children.push({ kill: () => tui.kill() });
  tui.onData((d) => term.write(d));
  const screen = () => Array.from({ length: rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true).trimEnd() ?? "").join("\n");
  // Long lines wrap, so compare with the line breaks folded into spaces.
  const tuiShows = (text) => screen().replace(/\s+/g, " ").includes(text);
  const tuiType = async (text) => { for (const ch of text) { tui.write(ch); await sleep(4); } tui.write("\r"); };
  screenAtFailure = screen;
  await until("TUI footer", () => tuiShows("faux/faux-1"));

  const shoot = async (name, pages = { pace: p, web: w }) => {
    for (const [client, page] of Object.entries(pages)) await page.screenshot({ path: join(out, `${name}-${client}.png`) });
    writeFileSync(join(out, `${name}-tui.txt`), screen());
  };
  const shows = (page, text) => async () => (await page.getByText(text).count()) > 0;
  const ask = async (page, text) => { await page.getByRole("textbox").first().fill(text); await page.getByRole("textbox").first().press("Enter"); };

  step("1. The web asks; the plan shows everywhere");
  await ask(w, "v2.3 release failed, find out why");
  await until("Pace shows the plan", shows(p, "Search the deploy logs"));
  await until("TUI shows the plan", () => tuiShows("Plan") && tuiShows("Search the deploy logs"));

  step("2. Three subagents in parallel");
  await until("three subagents run their tools", () => {
    const children = new Set(subagents().map((summary) => summary.id));
    return Object.values(seen().tasks?.tasks ?? {}).filter((node) => node.kind === "pi.tool" && children.has(node.conversationId)).length === 3;
  });
  const before = subagents().map((summary) => summary.id);
  await shoot("02-subagents");

  step("3. kill -9 the host mid-investigation, then restart it");
  host.kill("SIGKILL");
  await until("Pace shows the lost host", shows(p, "Host connection lost"));
  await until("web shows the lost host", shows(w, "Host connection lost"));
  await until("TUI shows the lost host", () => tuiShows("reconnecting"));
  await shoot("03-host-lost");
  ({ host } = await startHost());
  await until("Pace shows the recommendation", shows(p, "I recommend rolling back to v2.2"), 60000);
  await until("TUI shows the recommendation", () => tuiShows("recommend rolling back"), 30000);
  if (subagents().map((summary) => summary.id).join() !== before.join()) throw new Error(`subagents changed: ${before} -> ${subagents().map((s) => s.id)}`);
  console.log("  ok: the same three subagents after the restart");
  await shoot("03-recovered");

  step("5. Pace talks to a subagent directly");
  await p.getByText(/^subagent \d+ · logs/).click();
  await until("Pace shows the logs subagent", shows(p, "Found in search_logs"));
  await ask(p, "also look at ap-south");
  const logsId = subagents().find((summary) => summary.title.startsWith("logs:")).id;
  await until("the logs subagent is running a tool", () => Object.values(seen().tasks?.tasks ?? {}).some((node) => node.kind === "pi.tool" && node.conversationId === logsId));
  await p.getByRole("textbox").first().fill("focus on the connection pool limit");
  await p.getByRole("button", { name: "Send", exact: true }).waitFor();
  await shoot("05-steer-ready", { pace: p });
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await until("Pace steers the running subagent", shows(p, "focus on the connection pool limit"));
  await until("the subagent answers Pace", async () => (await p.getByText("Found in search_logs").count()) >= 2);
  await shoot("05-pace-subagent", { pace: p });
  await p.getByText(/^main/).first().click();
  await until("Pace is back on main", shows(p, "I recommend rolling back to v2.2"));

  step("6. A rollback asks every client for approval");
  await ask(w, "roll back to v2.2");
  await until("Pace asks", shows(p, "Approve rollback?"));
  await until("web asks", shows(w, "Approve rollback?"));
  await until("TUI asks", () => tuiShows("Approve rollback?"));

  step("4. While it waits: the TUI steers, the web queues a follow-up");
  await tuiType("keep eu-west drained until the fix ships");
  await w.getByRole("textbox").first().fill("then draft the status page update");
  await w.getByRole("button", { name: "Follow-up" }).click();
  await until("Pace shows both queued", async () => (await shows(p, "keep eu-west drained until the fix ships")()) && (await shows(p, "then draft the status page update")()));
  await until("TUI shows both queued", () => tuiShows("[steer] keep eu-west") && tuiShows("[followUp] then draft"));
  await shoot("06-approval-and-queue");

  step("6. Pace approves first; the TUI's later /approve is told");
  await p.getByRole("button", { name: "Approve", exact: true }).click();
  await tuiType("/approve");
  await until("TUI hears it was already decided", () => tuiShows("Already approved by pace"));
  await until("the banners are gone", async () => (await p.getByText("Approve rollback?").count()) === 0 && (await w.getByText("Approve rollback?").count()) === 0);

  step("7. The rollback: one region fails, the others are compensated");
  await until("region tasks in the task graph", () => Object.values(seen().tasks?.tasks ?? {}).some((node) => node.kind === "demo.region-rollback"));
  await until("healthy regions are switching while eu-west is checking", () => {
    const run = Object.values(seen().docs["demo.rollout"]?.runs ?? {})[0] ?? {};
    return run["us-east"] === "switching to v2.2" && run["ap-south"] === "switching to v2.2";
  });
  await shoot("07-rollback-running");
  await until("the rollout settles", () => {
    const run = Object.values(seen().docs["demo.rollout"]?.runs ?? {})[0] ?? {};
    return run["eu-west"] === "failed: health check" && run["us-east"] === "compensated: traffic restored" && run["ap-south"] === "compensated: traffic restored";
  });

  step("8. Esc, and the scheduled check still arrives");
  await until("Pace shows the check scheduled", shows(p, "Check scheduled"), 30000);
  tui.write("\u001b");
  await until("the reminder arrives as a follow-up", shows(p, /^Reminder: verify the error rate/), 30000);
  await until("and is answered", shows(p, "back to baseline"), 30000);
  await shoot("08-reminder");

  step("9. The web forks at the recommendation without the rollback tool");
  const answer = w.locator("*", { has: w.getByText("I recommend rolling back to v2.2") }).filter({ has: w.getByRole("button", { name: "Fork" }) }).last();
  await answer.getByRole("button", { name: "Fork" }).click();
  await w.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  await until("the web shows the fork's postmortem", shows(w, "Postmortem:"), 30000);
  await until("Pace lists the fork", shows(p, /^fork \d+/));
  await shoot("09-fork");

  step("10. Pace compacts main; every client sees it");
  await w.getByText(/^main/).first().click();
  await p.getByRole("button", { name: "Compact" }).click();
  await until("Pace shows the summary marker", shows(p, "Earlier context summarized"), 30000);
  await until("web shows the same summary marker", shows(w, "Earlier context summarized"));
  // Compaction precedes the retained recent turns, outside the bottom viewport.
  tui.write("\u001b[H");
  await until("TUI shows compaction", () => tuiShows("[compaction]"));
  // The host tells the client that asked.
  await until("Pace hears the compaction completed", shows(p, "Compaction completed."), 30000);
  await shoot("10-compacted");
  tui.write("\u001b[F");

  step("11. Edit the investigation tools; the host reloads them");
  writeFileSync(investigation, readFileSync(investigation, "utf8").replace(`const FORMAT = "plain"`, `const FORMAT = "table"`));
  await until("the host reports the reload", () => seen().notices.some((notice) => /Reloaded the investigation tools \(load 2\)/.test(notice.message)));
  await ask(p, "check the metrics again");
  await until("a fourth subagent ran", () => subagents().length === 4);
  const fresh = subagents().at(-1);
  await until("its output is a table now", async () => {
    await observer.controller.switchConversation(fresh.id);
    return seen().conversation.entries.some((entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model).includes("| metric | change | where |"));
  });
  await p.getByText(new RegExp(`^subagent ${fresh.id} `)).click();
  await sleep(500);
  await shoot("11-reloaded", { pace: p });

  step("12. Usage, the thinking block, and the narrow layout");
  await p.getByText(/^main/).first().click();
  await until("Pace shows usage", shows(p, "Usage"));
  await p.getByText("Thinking", { exact: true }).first().click();
  await until("the thinking block opens", shows(p, "Same cause."));
  await shoot("12-usage-thinking", { pace: p });
  await w.setViewportSize({ width: 900, height: 860 });
  await until("the narrow web hides the panel", async () => (await w.getByRole("button", { name: "Live state" }).count()) > 0);
  await w.getByRole("button", { name: "Live state" }).click();
  await until("the live state opens in a dialog", async () => (await w.getByRole("dialog").getByText("Tasks").count()) > 0);
  // Let the dialog finish fading in.
  await sleep(600);
  await w.screenshot({ path: join(out, "12-narrow-web.png") });
  await w.keyboard.press("Escape");
  await w.setViewportSize({ width: 390, height: 844 });
  await until("phone chat keeps a usable input", async () => (await w.getByRole("textbox").boundingBox())?.width > 300);
  if (await w.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("phone layout overflows horizontally");
  await w.screenshot({ path: join(out, "12-phone-web.png") });
  await w.getByRole("button", { name: "Conversations", exact: true }).click();
  await until("phone navigation opens", async () => (await w.getByRole("dialog").getByText(/^main/).count()) > 0);
  await w.screenshot({ path: join(out, "12-phone-navigation-web.png") });

  console.log(`\nDONE; evidence in ${out}`);
} catch (error) {
  console.error("FAILED:", error.message);
  for (const [name, page] of Object.entries(pagesAtFailure ?? {})) {
    await page.screenshot({ path: join(out, `failure-${name}.png`) }).catch(() => {});
    writeFileSync(join(out, `failure-${name}.txt`), await page.locator("body").innerText().catch(() => "page closed"));
  }
  try {
    writeFileSync(join(out, "failure-tui.txt"), screenAtFailure?.() ?? "");
  } catch {}
  console.error(paceLog.slice(-3000));
  process.exitCode = 1;
} finally {
  observer?.close();
  await browser?.close();
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {
      try {
        child.kill();
      } catch {}
    }
  }
  // electron-vite starts Electron outside its process group; end only the one on this run's profile.
  const profile = join(T, "profile");
  for (const line of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (pid && command.join(" ").includes(`--user-data-dir=${profile}`)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
  }
  await sleep(1000);
  rmSync(T, { recursive: true, force: true });
  rmSync(moduleDir, { recursive: true, force: true });
  process.exit();
}
