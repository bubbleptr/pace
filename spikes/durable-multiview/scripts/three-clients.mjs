// P3 proof: one faux host and three clients (Pace's dev page through its backend relay, the web
// page, the TUI), each driving the shared conversation; then a kill -9 mid-stream and a restart.
// Isolated from an operator's host (7420), web server (5199) and Pace profile. Pace runs under
// `electron-vite dev` because its page is DEV-only and builds always drop the DEV branch.
//
//   node scripts/three-clients.mjs [evidence-dir]    # default: a new temp dir, printed at the end
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@lydell/node-pty";
import { chromium } from "@playwright/test";
import xterm from "@xterm/headless";

const spike = fileURLToPath(new URL("..", import.meta.url));
const repo = resolve(spike, "../..");
const T = mkdtempSync(join(tmpdir(), "dmv-three-"));
const hostDir = join(T, "agent/experimental/durable-multiview/default");
mkdirSync(join(T, "data"), { recursive: true });
writeFileSync(join(T, "data/preflight-status.json"), JSON.stringify({ completedAt: "2026-10-02T00:00:00.000Z" }));
const PORT = 7466;
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "dmv-evidence-")));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
// Drained so Electron never blocks on a full pipe; printed when a run fails.
let paceLog = "";
const answer = "Root cause: the v2.3 migration locks the orders table for 40 s; deploys time out at 30 s. Fix: run the backfill in batches.";

async function startHost() {
  const host = spawn(process.execPath, ["host/main.ts", "--data-dir", hostDir, "--cwd", T, "--port", String(PORT), "--faux", answer, "--faux-tps", "5", "--lock-stale-ms", "2000"], { cwd: spike, stdio: ["ignore", "pipe", "inherit"] });
  children.push(host);
  const ready = await new Promise((resolve) => host.stdout.on("data", (d) => { const s = String(d); if (s.includes("ready")) resolve(JSON.parse(s)); }));
  return { host, ready };
}
async function until(what, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
  console.log("ok:", what);
}

try {
  let { host, ready } = await startHost();

  // Pace in dev mode (the route is DEV-only), isolated like the e2e fixture.
  const pace = spawn(join(repo, "node_modules/.bin/electron-vite"), ["dev", "--remoteDebuggingPort", "9339", "--", `--user-data-dir=${join(T, "profile")}`], {
    cwd: join(repo, "apps/desktop"),
    env: { ...process.env, PACE_DATA_DIR: join(T, "data"), PI_CODING_AGENT_DIR: join(T, "agent"), PACE_DURABLE_SPIKE_URL: ready.url, PACE_E2E: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(pace);
  pace.stdout.on("data", (d) => (paceLog += d));
  pace.stderr.on("data", (d) => (paceLog += d));
  let cdp;
  await until("Pace CDP", async () => { try { cdp = await chromium.connectOverCDP("http://127.0.0.1:9339"); return true; } catch { return false; } }, 90000);
  let pacePage;
  await until("Pace window", async () => { pacePage = cdp.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools")); return pacePage !== undefined; });
  await pacePage.waitForLoadState("domcontentloaded");
  await pacePage.evaluate(() => { window.location.hash = "#/durable-spike"; });
  await until("Pace page connected", async () => (await pacePage.getByText("Durable host").count()) > 0, 30000);

  // The web page on its own port.
  const web = spawn(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "--config", "web/vite.config.ts", "--port", "5299"], { cwd: spike, stdio: ["ignore", "pipe", "inherit"] });
  children.push(web);
  await new Promise((resolve) => web.stdout.on("data", (d) => String(d).includes("5299") && resolve()));
  const browser = await chromium.launch();
  const webPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await webPage.goto(ready.web.replace("5199", "5299"));

  // The TUI in a pty, rendered by a headless terminal.
  const cols = 110, rows = 24;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  mkdirSync(join(T, "tui-agent"), { recursive: true });
  const tui = spawnPty(process.execPath, ["tui/main.ts", "--url", ready.url, "--token", ready.token], { cols, rows, cwd: spike, env: { ...process.env, PI_CODING_AGENT_DIR: join(T, "tui-agent"), TERM: "xterm-256color" } });
  children.push({ kill: () => tui.kill() });
  let tuiText = "";
  tui.onData((d) => { term.write(d); tuiText += d; });
  const screen = () => Array.from({ length: rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true).trimEnd() ?? "").join("\n");
  const tuiShows = (text) => screen().includes(text);
  await until("TUI footer", () => tuiShows("faux/faux-1"));

  const ask = async (page, text) => { await page.getByRole("textbox").fill(text); await page.getByRole("textbox").press("Enter"); };
  await ask(pacePage, "question-from-pace");
  await until("web shows Pace's question", async () => (await webPage.getByText("question-from-pace").count()) > 0);
  await until("TUI shows Pace's question", () => tuiShows("question-from-pace"));
  await until("Pace shows the answer", async () => (await pacePage.getByText("Fix: run the backfill in batches.").count()) > 0);
  await ask(webPage, "question-from-web");
  await until("Pace shows web's question", async () => (await pacePage.getByText("question-from-web").count()) > 0);
  await until("idle after web turn", async () => (await pacePage.getByText("Fix: run the backfill in batches.").count()) >= 2);
  for (const ch of "question-from-tui") { tui.write(ch); await sleep(5); }
  tui.write("\r");
  await until("Pace shows TUI's question", async () => (await pacePage.getByText("question-from-tui").count()) > 0);
  await sleep(2500);
  await pacePage.screenshot({ path: join(out, "pace-streaming.png") });
  await webPage.screenshot({ path: join(out, "web-streaming.png") });
  writeFileSync(join(out, "tui-streaming.txt"), screen());

  // Crash mid-stream, restart, and watch Pace resume.
  host.kill("SIGKILL");
  await until("Pace shows the lost host", async () => (await pacePage.getByText("Host connection lost").count()) > 0);
  await pacePage.screenshot({ path: join(out, "pace-host-lost.png") });
  ({ host } = await startHost());
  await until("Pace reconnected", async () => (await pacePage.getByText("Host connection lost").count()) === 0, 30000);
  await until("Pace shows the interrupted partial", async () => (await pacePage.getByText("interrupted").count()) > 0, 30000);
  await until("third answer complete", async () => (await pacePage.getByText("Fix: run the backfill in batches.").count()) >= 3, 60000);
  await pacePage.screenshot({ path: join(out, "pace-recovered.png") });
  await webPage.screenshot({ path: join(out, "web-recovered.png") });
  writeFileSync(join(out, "tui-recovered.txt"), screen());
  console.log(`DONE; evidence in ${out}`);
  await browser.close();
} catch (error) {
  console.error("FAILED:", error.message);
  console.error(paceLog.slice(-3000));
  process.exitCode = 1;
} finally {
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
  process.exit();
}
