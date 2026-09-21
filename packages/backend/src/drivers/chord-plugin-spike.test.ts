import {
  createFacetHost,
  defineFacet,
  isJsonValue,
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

async function spikeHarness() {
  const [sessionPort, presentationPort] = createJsonMessagePortPair();
  const wire: ChordWireMessage[] = [];

  const sessionHost = await createFacetHost({ facets: [sessionFacet] });
  const stopServing = serveChordFacetHost(sessionHost, tap(sessionPort, wire));

  // Stand-in for the plugin's presentation facet: a GUI panel that renders
  // `progress` and drives `advance`. In Pace this would live in the renderer.
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

  const transport = createChordPortTransport(tap(presentationPort, wire));
  const presentationHost = await createFacetHost({
    facets: [presentationFacet],
    serviceSources: [createChordPortServiceSource(transport)],
  });

  return {
    panel: () => panel,
    rendered,
    wire,
    async dispose() {
      await presentationHost.dispose();
      transport.dispose();
      stopServing();
      await sessionHost.dispose();
    },
  };
}

describe("chord plugin spike: session facet ↔ presentation facet over a JSON port", () => {
  it("hydrates replicated state into the presentation host before activation", async () => {
    const h = await spikeHarness();
    try {
      expect(h.panel().progress.value).toEqual({ step: 0, label: "idle" });
    } finally {
      await h.dispose();
    }
  });

  it("carries RPC calls and pushes state deltas back to the presentation replica", async () => {
    const h = await spikeHarness();
    try {
      const reply = await h.panel().advance({ by: 2 }, BACKGROUND_CONTEXT);
      expect(reply).toEqual({ step: 2 });

      await waitFor(() => h.panel().progress.value?.step === 2, "replica update");
      expect(h.panel().progress.value).toEqual({ step: 2, label: "step 2" });
      expect(h.rendered[h.rendered.length - 1]).toEqual({ step: 2, label: "step 2" });

      await h.panel().advance({ by: 3 }, BACKGROUND_CONTEXT);
      await waitFor(() => h.panel().progress.value?.step === 5, "second replica update");
      expect(h.rendered.map(v => v.step)).toEqual([0, 2, 5]);
    } finally {
      await h.dispose();
    }
  });

  it("only ever puts strict JSON on the wire, so child_process IPC can carry it unchanged", async () => {
    const h = await spikeHarness();
    try {
      await h.panel().advance({ by: 1 }, BACKGROUND_CONTEXT);
      await waitFor(() => h.panel().progress.value?.step === 1, "replica update");
      expect(h.wire.length).toBeGreaterThan(0);
      for (const message of h.wire) expect(isJsonValue(message)).toBe(true);
      const kinds = new Set(h.wire.map(m => m.kind));
      expect(kinds).toEqual(new Set(["chord_call", "chord_result", "chord_update"]));
    } finally {
      await h.dispose();
    }
  });
});
