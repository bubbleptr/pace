import { fileURLToPath } from "node:url";
import { type IPty, spawn as spawnPty } from "@lydell/node-pty";
import { tempDir } from "./support.ts";

const spikeDir = fileURLToPath(new URL("..", import.meta.url));
// CSI, OSC, and the other escape sequences of a differential terminal render.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export interface TuiProcess {
  readonly pty: IPty;
  /** Resolve once what the TUI printed so far, as plain text, satisfies `predicate`. */
  until(predicate: (text: string) => boolean, what: string, timeoutMs?: number): Promise<void>;
  exited(): number | undefined;
}

/** The TUI in a real pseudo-terminal against a host, with an empty agent dir so no user settings leak in. */
export async function startTui(defer: (cleanup: () => Promise<void> | void) => void, url: string, token: string): Promise<TuiProcess> {
  const agentDir = await tempDir();
  defer(agentDir.remove);
  const pty = spawnPty(process.execPath, ["tui/main.ts", "--url", url, "--token", token], {
    cols: 140,
    rows: 40,
    cwd: spikeDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir.path, TERM: "xterm-256color" },
  });
  let screen = "";
  let exited: number | undefined;
  pty.onData((data) => (screen += data));
  pty.onExit(({ exitCode }) => (exited = exitCode));
  defer(() => {
    if (exited === undefined) pty.kill();
  });
  return {
    pty,
    exited: () => exited,
    async until(predicate, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(screen.replace(ANSI, ""))) {
        if (Date.now() > deadline) throw new Error(`TUI never showed ${what}; it printed:\n${screen.replace(ANSI, "").slice(-2000)}`);
        if (exited !== undefined) throw new Error(`TUI exited with ${exited} before showing ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
