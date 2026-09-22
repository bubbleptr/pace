import {
  createFacetHost,
  decodeServiceControlCall,
  defineFacet,
  parseWireServiceProviderUpdate,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { DemoPanelService, sessionFacet } from "./chord-plugin-spike-demo";
import {
  createChordPortServiceSource,
  createChordPortTransport,
  createJsonMessagePortPair,
  serveChordFacetHost,
  type ChordWireMessage,
  type JsonMessagePort,
} from "./chord-plugin-spike";

type Progress = { step: number; label: string };
type Delivery = { step: number; label: string; kind: "hydrate" | "update" };

function tap(port: JsonMessagePort, log: ChordWireMessage[]): JsonMessagePort {
  return {
    send(message) {
      log.push(message);
      port.send(message);
    },
    onMessage: listener => port.onMessage(listener),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

function controlKinds(messages: readonly ChordWireMessage[]): string[] {
  return messages.flatMap(message => {
    if (message.kind === "chord_call") {
      const control = decodeServiceControlCall(message.call);
      return [control?.type ?? "rpc"];
    }
    if (message.kind === "chord_update") return [parseWireServiceProviderUpdate(message.update).type];
    return [message.kind];
  });
}

describe("chord plugin spike: hot reload on both hosts", () => {
  it("reloads the presentation facet without resubscribing on the wire", async () => {
    const [sessionPort, presentationPort] = createJsonMessagePortPair();
    const wire: ChordWireMessage[] = [];
    const sessionHost = await createFacetHost({ facets: [sessionFacet] });
    const stopServing = serveChordFacetHost(sessionHost, tap(sessionPort, wire));

    const renderedV1: Progress[] = [];
    const renderedV2: Progress[] = [];
    let panelV1!: DemoPanelService;
    let panelV2!: DemoPanelService;
    const presentationFacetV1 = defineFacet({
      id: "pace-spike/presentation",
      setup(env) {
        panelV1 = env.use(DemoPanelService);
        env.onActivate(() => {
          env.own(panelV1.progress.subscribe(value => renderedV1.push(value)));
        });
      },
    });
    const presentationFacetV2 = defineFacet({
      id: "pace-spike/presentation",
      setup(env) {
        panelV2 = env.use(DemoPanelService);
        env.onActivate(() => {
          env.own(panelV2.progress.subscribe(value => renderedV2.push(value)));
        });
      },
    });

    const transport = createChordPortTransport(tap(presentationPort, wire));
    const presentationHost = await createFacetHost({
      facets: [presentationFacetV1],
      serviceSources: [createChordPortServiceSource(transport)],
    });

    try {
      expect(panelV1.progress.value).toEqual({ step: 0, label: "idle" });
      await panelV1.advance({ by: 2 }, BACKGROUND_CONTEXT);
      await waitFor(() => panelV1.progress.value?.step === 2, "replica update");
      expect(renderedV1.map(value => value.step)).toEqual([0, 2]);

      const wireBeforeReload = wire.length;
      await presentationHost.reload([presentationFacetV2]);
      // The remote binding stays up: reload does not catalogue, unsubscribe, or subscribe again.
      expect(controlKinds(wire.slice(wireBeforeReload))).toEqual([]);

      expect(renderedV1.map(value => value.step)).toEqual([0, 2]);
      expect(renderedV2).toEqual([{ step: 2, label: "step 2" }]);
      expect(panelV2.progress.value).toEqual({ step: 2, label: "step 2" });

      await panelV2.advance({ by: 1 }, BACKGROUND_CONTEXT);
      await waitFor(() => panelV2.progress.value?.step === 3, "post-reload delta");
      expect(panelV2.progress.value).toEqual({ step: 3, label: "step 3" });
      expect(renderedV1.map(value => value.step)).toEqual([0, 2]);
      expect(renderedV2.map(value => value.step)).toEqual([2, 3]);
    } finally {
      await presentationHost.dispose();
      transport.dispose();
      stopServing();
      await sessionHost.dispose();
    }
  });

  it("reloads the session facet and rehydrates the presentation replica", async () => {
    const [sessionPort, presentationPort] = createJsonMessagePortPair();
    const wire: ChordWireMessage[] = [];
    const sessionHost = await createFacetHost({ facets: [sessionFacet] });
    const stopServing = serveChordFacetHost(sessionHost, tap(sessionPort, wire));

    const deliveries: Delivery[] = [];
    let sawUndefined = false;
    let panel!: DemoPanelService;
    const presentationFacet = defineFacet({
      id: "pace-spike/presentation",
      setup(env) {
        panel = env.use(DemoPanelService);
        env.onActivate(() => {
          env.own(
            panel.progress.subscribe((value, _context, delivery) => {
              if (panel.progress.value === undefined) sawUndefined = true;
              deliveries.push({ step: value.step, label: value.label, kind: delivery.kind });
            }),
          );
        });
      },
    });

    const sessionFacetV2 = defineFacet({
      id: "pace-spike/session",
      setup(env) {
        const progress = env.replicatedState({ step: 100, label: "reloaded" });
        env.provide(DemoPanelService, {
          progress,
          async advance({ by }) {
            progress.state.step += by;
            progress.state.label = `step ${progress.state.step}`;
            progress.publish(BACKGROUND_CONTEXT);
            return { step: progress.state.step };
          },
        });
      },
    });

    const transport = createChordPortTransport(tap(presentationPort, wire));
    const presentationHost = await createFacetHost({
      facets: [presentationFacet],
      serviceSources: [createChordPortServiceSource(transport)],
    });

    const polled: string[] = [];
    const note = () => {
      const value = panel.progress.value;
      const token = value === undefined ? "undefined" : `${value.step}:${value.label}`;
      if (polled[polled.length - 1] !== token) polled.push(token);
    };

    try {
      expect(panel.progress.value).toEqual({ step: 0, label: "idle" });
      expect(deliveries).toEqual([{ step: 0, label: "idle", kind: "hydrate" }]);

      const wireBeforeReload = wire.length;
      note();
      await sessionHost.reload([sessionFacetV2]);
      await waitFor(() => {
        note();
        return panel.progress.value?.label === "reloaded";
      }, "reloaded snapshot");
      note();

      expect(sawUndefined).toBe(false);
      expect(panel.progress.value).toEqual({ step: 100, label: "reloaded" });
      // Replacement is delivered as a new hydrate. The replica is never cleared in between.
      expect(deliveries).toEqual([
        { step: 0, label: "idle", kind: "hydrate" },
        { step: 100, label: "reloaded", kind: "hydrate" },
      ]);
      expect(polled).toEqual(["0:idle", "100:reloaded"]);
      expect(controlKinds(wire.slice(wireBeforeReload))).toEqual(["replaced"]);
    } finally {
      await presentationHost.dispose();
      transport.dispose();
      stopServing();
      await sessionHost.dispose();
    }
  });
});
