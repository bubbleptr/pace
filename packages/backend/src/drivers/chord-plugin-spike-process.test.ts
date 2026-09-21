import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { DemoPanelService } from "./chord-plugin-spike-demo";
import {
  createChildProcessChordPort,
  createChordPortServiceSource,
  createChordPortTransport,
} from "./chord-plugin-spike";

const fixturePath = join(process.cwd(), "packages/backend/src/drivers/fixtures/chord-session-process.mjs");

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

function waitForSpikeReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("Timed out waiting for chord fixture ready"));
    }, 8_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      if ((message as { type?: unknown }).type !== "spike_ready") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve();
    };
    child.on("message", onMessage);
  });
}

function waitForDriverResult(child: ChildProcess, id: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`Timed out waiting for driver reply id=${id}`));
    }, 8_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as { id?: unknown; kind?: unknown; result?: unknown; error?: unknown };
      // Driver replies have an id and no chord `kind`. Ignore the error
      // frames serveSessionProcess currently emits for chord_call traffic.
      if (record.id !== id || typeof record.kind === "string") return;
      if ("error" in record && record.error !== undefined) return;
      if (!("result" in record)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(record.result);
    };
    child.on("message", onMessage);
  });
}

async function disposeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => resolve());
  });
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  try {
    if (child.connected) child.send({ id: 99, method: "dispose", args: [] });
    else child.kill("SIGKILL");
    await exited;
  } finally {
    clearTimeout(killTimer);
  }
}

describe("chord plugin spike: session facet over a forked child IPC channel", () => {
  it("hydrates, RPCs and pushes deltas while the existing driver protocol still replies", async () => {
    const child = fork(fixturePath, [], {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr?.pipe(process.stderr, { end: false });

    const childDied = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        reject(new Error(`chord fixture exited early (${signal ?? code})`));
      });
    });

    let transport: ReturnType<typeof createChordPortTransport> | undefined;
    let presentationHost: Awaited<ReturnType<typeof createFacetHost>> | undefined;
    try {
      await Promise.race([waitForSpikeReady(child), childDied]);

      const driverReply = waitForDriverResult(child, 1);
      child.send({
        id: 1,
        method: "createSession",
        args: [{ sessionId: "a", projectId: "a", cwd: process.cwd() }],
      });

      const rendered: Array<{ step: number; label: string }> = [];
      let panel!: DemoPanelService;
      const presentationFacet = defineFacet({
        id: "pace-spike/presentation",
        setup(env) {
          panel = env.use(DemoPanelService);
          env.onActivate(() => {
            env.own(panel.progress.subscribe(value => rendered.push(value)));
          });
        },
      });

      transport = createChordPortTransport(createChildProcessChordPort(child));
      presentationHost = await Promise.race([
        createFacetHost({
          facets: [presentationFacet],
          serviceSources: [createChordPortServiceSource(transport)],
        }),
        childDied,
      ]);

      expect(panel.progress.value).toEqual({ step: 0, label: "idle" });

      const reply = await panel.advance({ by: 2 }, BACKGROUND_CONTEXT);
      expect(reply).toEqual({ step: 2 });
      await waitFor(() => panel.progress.value?.step === 2, "replica update");
      expect(panel.progress.value).toEqual({ step: 2, label: "step 2" });
      expect(rendered[rendered.length - 1]).toEqual({ step: 2, label: "step 2" });

      await panel.advance({ by: 3 }, BACKGROUND_CONTEXT);
      await waitFor(() => panel.progress.value?.step === 5, "second replica update");
      expect(rendered.map(v => v.step)).toEqual([0, 2, 5]);

      expect(await driverReply).toMatchObject({ sessionId: "a", projectId: "a" });
    } finally {
      child.removeAllListeners("exit");
      await presentationHost?.dispose();
      transport?.dispose();
      await disposeChild(child);
    }
  }, 20_000);
});
