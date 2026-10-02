import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { connectRemoteDurable, type RemoteDurable } from "../protocol/remote-durable.ts";
import { isBusy, streamingText, transcript } from "../protocol/transcript.ts";
import { freePort, LONG_ANSWER, tempDir, waitForView } from "./support.ts";

const spikeDir = fileURLToPath(new URL("..", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface HostProcess {
  readonly child: ChildProcess;
  readonly url: string;
  readonly token: string;
}

async function spawnHost(dataDir: string, port: number): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    ["host/main.ts", "--data-dir", dataDir, "--cwd", dataDir, "--port", String(port), "--faux", LONG_ANSWER, "--faux-tps", "40", "--lock-stale-ms", "2000"],
    { cwd: spikeDir, stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const lines = createInterface({ input: child.stdout! });
  for await (const line of lines) {
    const event = JSON.parse(line) as { event: string; url: string; token: string };
    if (event.event === "ready") return { child, url: event.url, token: event.token };
  }
  throw new Error("host exited before it was ready");
}

it("resumes both clients after the host is killed mid-stream and restarted", async () => {
  const dir = await tempDir();
  cleanups.push(dir.remove);
  const port = await freePort();
  const first = await spawnHost(dir.path, port);

  const connect = async (): Promise<RemoteDurable> => {
    const client = await connectRemoteDurable({ url: first.url, token: first.token, reconnectDelayMs: { min: 100, max: 500 } });
    cleanups.push(() => client.close());
    return client;
  };
  const a = await connect();
  const b = await connect();

  await a.controller.submit("investigate", "followUp");
  // Kill while the answer is still streaming, partway through.
  await waitForView(b.view, (view) => (streamingText(view.conversation)?.length ?? 0) > 20);
  const seenBeforeKill = streamingText(b.view.current().conversation)!;
  expect(seenBeforeKill.length).toBeLessThan(LONG_ANSWER.length);
  first.child.kill("SIGKILL");
  await once(first.child, "exit");
  await Promise.all([a, b].map((client) => waitForView(client.view, (view) => view.connection === "reconnecting")));

  const second = await spawnHost(dir.path, port);
  expect(second.token).toBe(first.token);

  const settled = (client: RemoteDurable) =>
    waitForView(
      client.view,
      (view) => view.connection === "connected" && !isBusy(view.conversation) && transcript(view.conversation).at(-1)?.role === "assistant",
      30_000,
    );
  await Promise.all([settled(a), settled(b)]);

  // The committed partial survives the crash as an aborted entry; recovery then resends the request.
  const [user, interrupted, answer, ...rest] = transcript(a.view.current().conversation);
  expect(user).toEqual({ role: "user", text: "investigate" });
  expect(interrupted).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(LONG_ANSWER.startsWith(interrupted!.text)).toBe(true);
  expect(interrupted!.text.length).toBeGreaterThanOrEqual(seenBeforeKill.length);
  expect(answer).toEqual({ role: "assistant", text: LONG_ANSWER, stopReason: "stop" });
  expect(rest).toEqual([]);
  expect(b.view.current().conversation).toEqual(a.view.current().conversation);
});
