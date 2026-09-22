import { fork } from "node:child_process";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { DemoPanelService } from "./chord-plugin-spike-demo";
import {
  createChildProcessChordPort,
  createChordPortServiceSource,
  createChordPortTransport,
  createMessagePortChordPort,
  relayChordFrames,
  type ChordWireMessage,
  type JsonMessagePort,
} from "./chord-plugin-spike";
import { disposeChild, waitFor, waitForDriverResult, waitForSpikeReady } from "./chord-plugin-spike-test-helpers";

const fixturePath = join(process.cwd(), "packages/backend/src/drivers/fixtures/chord-session-process.mjs");

function tap(port: JsonMessagePort, log: ChordWireMessage[]): JsonMessagePort {
  return {
    send(message) {
      log.push(message);
      port.send(message);
    },
    onMessage: listener => port.onMessage(listener),
  };
}

describe("chord plugin spike: backend relays chord frames to a renderer message port", () => {
  it("hydrates, RPCs and pushes deltas while the driver protocol still replies", async () => {
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

    const channel = new MessageChannel();
    const towardRenderer: ChordWireMessage[] = [];
    let stopRelay: (() => void) | undefined;
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

      // port2 is the backend side of the structured-clone hop; port1 is the renderer.
      stopRelay = relayChordFrames(
        createChildProcessChordPort(child),
        tap(createMessagePortChordPort(channel.port2), towardRenderer),
      );
      transport = createChordPortTransport(createMessagePortChordPort(channel.port1));
      // `message` listeners ref the port. unref so the handle cannot hang vitest.
      channel.port1.unref();
      channel.port2.unref();
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

      expect(towardRenderer.length).toBeGreaterThan(0);
      const kinds = new Set(towardRenderer.map(message => message.kind));
      for (const kind of kinds) expect(["chord_call", "chord_result", "chord_update"]).toContain(kind);
    } finally {
      child.removeAllListeners("exit");
      await presentationHost?.dispose();
      transport?.dispose();
      stopRelay?.();
      channel.port1.close();
      channel.port2.close();
      await disposeChild(child);
    }
  }, 20_000);
});
