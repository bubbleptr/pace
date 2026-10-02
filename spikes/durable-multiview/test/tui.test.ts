import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@lydell/node-pty";
import { expect, it } from "vitest";
import { transcript } from "../protocol/transcript.ts";
import { connectTo, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const spikeDir = fileURLToPath(new URL("..", import.meta.url));
const defer = useCleanups();
// CSI, OSC, and the other escape sequences of a differential terminal render.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** The TUI in a real pseudo-terminal, with what it printed so far as plain text. */
async function startTui(url: string, token: string) {
  const agentDir = await tempDir();
  defer(agentDir.remove);
  const pty = spawnPty(process.execPath, ["tui/main.ts", "--url", url, "--token", token], {
    cols: 140,
    rows: 40,
    cwd: spikeDir,
    // An empty agent dir: no user theme, keybindings, or settings leak in.
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir.path, TERM: "xterm-256color" },
  });
  let screen = "";
  let exited: number | undefined;
  pty.onData((data) => (screen += data));
  pty.onExit(({ exitCode }) => (exited = exitCode));
  defer(() => {
    if (exited === undefined) pty.kill();
  });
  const until = async (predicate: (text: string) => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(screen.replace(ANSI, ""))) {
      if (Date.now() > deadline) throw new Error(`TUI never showed ${what}; it printed:\n${screen.replace(ANSI, "").slice(-2000)}`);
      if (exited !== undefined) throw new Error(`TUI exited with ${exited} before showing ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { pty, until, exited: () => exited };
}

it("drives the host from the TUI and shows the answer, then the lost host", async () => {
  const host = await startFauxHost(defer, { answers: ["pong-from-the-host"] });
  const observer = await connectTo(defer, host);
  const tui = await startTui(host.url, host.token);

  await tui.until((text) => text.includes("faux/faux-1"), "the footer");
  tui.pty.write("ping-from-the-tui");
  tui.pty.write("\r");

  await waitForView(observer.view, (view) => transcript(view.conversation)[0]?.text === "ping-from-the-tui");
  await tui.until((text) => text.includes("pong-from-the-host"), "the answer");

  await host.close();
  await tui.until((text) => text.includes("reconnecting"), "the reconnect notice");

  tui.pty.write("\u0004");
  await tui.until(() => tui.exited() !== undefined, "exit", 5000).catch(() => {});
  expect(tui.exited()).toBe(0);
});
