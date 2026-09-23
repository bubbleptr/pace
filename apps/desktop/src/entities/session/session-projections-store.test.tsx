import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntimeEventEntry,
  PiRuntimeBridge,
  PiRuntimeEvent,
  PiSessionState,
  RuntimeModelControls,
} from "@/entities/runtime/pi-runtime-bridge";
import { createSessionFromDraft } from "@/entities/session/session-creation";
import {
  applySessionProjectionEvent,
  createSessionProjection,
  type SessionProjection,
} from "@/entities/session/session-projection";
import { createSessionProjectionsStore } from "@/entities/session/session-projections-store";
import {
  SessionProjectionsProvider,
  useLiveSession,
  useSessionProjections,
} from "@/entities/session/use-session-projections";

type Listener<T extends unknown[]> = (...args: T) => void;

// Counts live listeners per stream and piSessionId so a test can see who is
// still attached after a Session's lifecycle ends. History reads stay pending
// until the test settles them.
function createFakeBridge() {
  const loads: Array<{
    input: { sessionId: string; piSessionId: string };
    settle: ReturnType<typeof deferred<PiSessionState>>;
  }> = [];
  const streams = {
    legacy: new Map<string, Set<Listener<[PiRuntimeEvent]>>>(),
    agent: new Map<string, Set<Listener<[AgentRuntimeEventEntry]>>>(),
    modelControls: new Map<string, Set<Listener<[RuntimeModelControls, string]>>>(),
  };
  const add = <T extends unknown[]>(
    stream: Map<string, Set<Listener<T>>>,
    piSessionId: string,
    listener: Listener<T>,
  ) => {
    const listeners = stream.get(piSessionId) ?? new Set();
    listeners.add(listener);
    stream.set(piSessionId, listeners);
    return () => {
      listeners.delete(listener);
    };
  };
  const bridge: PiRuntimeBridge = {
    async startRuntime(input) {
      return {
        runtimeId: `runtime:${input.sessionId}`,
        sessionId: input.sessionId,
        projectId: input.projectId,
        checkout: input.checkout,
        status: "ready",
      };
    },
    async createPiSessionState(input) {
      return {
        piSessionId: `pi:${input.runtimeId}`,
        runtimeId: input.runtimeId,
        projectId: input.projectId,
        cwd: input.cwd,
        status: "idle",
        events: [],
        updatedAt: "2026-09-24T10:00:00.000Z",
      };
    },
    async sendInitialPrompt(input) {
      return {
        accepted: true,
        piSessionId: input.piSessionId,
        event: {
          id: "user-echo",
          piSessionId: input.piSessionId,
          kind: "message",
          role: "user",
          body: input.prompt,
          timestamp: "2026-09-24T10:00:00.500Z",
        },
      };
    },
    queueFollowUp: () => Promise.reject(new Error("unused")),
    withdrawQueuedMessage: () => Promise.reject(new Error("unused")),
    reorderQueuedMessages: () => Promise.reject(new Error("unused")),
    steerFromQueue: () => Promise.reject(new Error("unused")),
    steerRun: () => Promise.reject(new Error("unused")),
    abortRun: () => Promise.reject(new Error("unused")),
    getSessionState: () => Promise.reject(new Error("unused")),
    subscribeToEvents: (piSessionId, listener) => add(streams.legacy, piSessionId, listener),
    subscribeToAgentEvents: (piSessionId, listener) => add(streams.agent, piSessionId, listener),
    subscribeToModelControls: (piSessionId, listener) =>
      add(streams.modelControls, piSessionId, listener),
    loadSession(input) {
      const settle = deferred<PiSessionState>();
      loads.push({ input, settle });
      return settle.promise;
    },
  };

  return {
    bridge,
    loads,
    listenerCounts(piSessionId: string) {
      return {
        legacy: streams.legacy.get(piSessionId)?.size ?? 0,
        agent: streams.agent.get(piSessionId)?.size ?? 0,
        modelControls: streams.modelControls.get(piSessionId)?.size ?? 0,
      };
    },
    emitLegacy(event: PiRuntimeEvent) {
      for (const listener of streams.legacy.get(event.piSessionId) ?? []) listener(event);
    },
    emitAgent(piSessionId: string, entry: AgentRuntimeEventEntry) {
      for (const listener of streams.agent.get(piSessionId) ?? []) listener(entry);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function boundSession(id: string, piSessionId = `pi:${id}`): SessionProjection {
  return applySessionProjectionEvent(
    createSessionProjection({
      id,
      projectId: "pig",
      initialPrompt: `Prompt ${id}`,
      createdAt: "2026-09-24T09:00:00.000Z",
    }),
    {
      type: "runtime-bound",
      stage: "starting runtime",
      runtimeId: `runtime:${id}`,
      piSessionId,
      occurredAt: "2026-09-24T09:00:01.000Z",
    },
  );
}

// A persisted-looking record: accepted, never touched by this process.
function coldSession(id: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    ...createSessionProjection({
      id,
      projectId: "pig",
      initialPrompt: `Prompt ${id}`,
      createdAt: "2026-09-24T08:00:00.000Z",
    }),
    status: "completed",
    creationStage: "accepted",
    piSessionId: `pi:${id}`,
    ...overrides,
  };
}

function runStart(seq: number, runId: string): AgentRuntimeEventEntry {
  return {
    seq,
    timestamp: `2026-09-24T10:00:0${seq}.000Z`,
    event: {
      type: "run",
      runId,
      phase: "start",
      trigger: "prompt",
      surface: "hidden",
      origin: "sdk",
    },
  };
}

function createStore(
  fake = createFakeBridge(),
  listSessions: () => Promise<SessionProjection[]> = async () => [],
) {
  return createSessionProjectionsStore({ bridge: fake.bridge, listSessions });
}

describe("Session Projections store", () => {
  it("owns the only runtime subscription of a created Session and releases it on remove", async () => {
    const fake = createFakeBridge();
    const store = createStore(fake);

    const result = await createSessionFromDraft({
      bridge: fake.bridge,
      store,
      draft: { projectId: "pig", prompt: "Ship it", updatedAt: "2026-09-24T10:00:00.000Z" },
      project: { id: "pig", projectRoot: "/repo" },
      now: () => "2026-09-24T10:00:00.000Z",
      idFactory: () => "created",
    });
    const piSessionId = result.projection.piSessionId!;

    expect(result.ok).toBe(true);
    expect(fake.listenerCounts(piSessionId)).toEqual({ legacy: 1, agent: 1, modelControls: 1 });

    // Both streams keep the created Session current after the creator returned.
    fake.emitAgent(piSessionId, runStart(1, "run-1"));
    fake.emitLegacy({
      id: "steer-echo",
      piSessionId,
      kind: "message",
      role: "user",
      body: "Also update the docs",
      timestamp: "2026-09-24T10:00:02.000Z",
    });
    const created = store.get("created")!;
    expect(created.status).toBe("running");
    expect(created.runtimeModel.lastSeq).toBe(1);
    // The legacy mirror slots between agent events instead of advancing seq.
    expect(created.runtimeModel.order.map((entry) => entry.seq)).toContain(1.5);

    store.remove("created");
    expect(fake.listenerCounts(piSessionId)).toEqual({ legacy: 0, agent: 0, modelControls: 0 });
  });

  it("updates a background Session without re-rendering a Live Session View of another one", () => {
    const fake = createFakeBridge();
    let store!: ReturnType<typeof useSessionProjections>["store"];
    const renders: Array<SessionProjection | undefined> = [];

    function StoreProbe() {
      store = useSessionProjections().store;
      return null;
    }
    function LiveView() {
      renders.push(useLiveSession("session-a").projection);
      return null;
    }

    render(
      <SessionProjectionsProvider bridge={fake.bridge}>
        <StoreProbe />
        <LiveView />
      </SessionProjectionsProvider>,
    );
    act(() => {
      store.insert(boundSession("session-a"));
      store.insert(createSessionProjection({
        id: "session-b",
        projectId: "pig",
        initialPrompt: "Background",
        createdAt: "2026-09-24T09:00:00.000Z",
      }));
      store.apply("session-b", {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime:b",
        piSessionId: "pi:b",
        occurredAt: "2026-09-24T09:00:01.000Z",
      });
    });
    const rendersBefore = renders.length;
    const sessionA = store.get("session-a");

    act(() => {
      fake.emitAgent("pi:b", runStart(1, "run-b"));
    });

    expect(store.get("session-b")?.status).toBe("running");
    expect(store.get("session-a")).toBe(sessionA);
    expect(renders).toHaveLength(rendersBefore);
  });

  it("rehydrates cold records but keeps projections this process made live", async () => {
    const fake = createFakeBridge();
    const listed = deferred<SessionProjection[]>();
    const store = createStore(fake, () => listed.promise);
    const live = applySessionProjectionEvent(boundSession("live"), {
      type: "agent-event-received",
      entry: runStart(1, "run-live"),
    });
    const stale = coldSession("stale", { title: "Old title" });
    store.insert(stale);
    store.insert(live);

    const rehydrating = store.rehydrate();
    // A Session created while the backend list is in flight has no record yet.
    const creating = createSessionProjection({
      id: "creating",
      projectId: "pig",
      initialPrompt: "Brand new",
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    store.insert(creating);
    listed.resolve([
      coldSession("live"),
      coldSession("stale", { title: "New title" }),
      coldSession("other"),
    ]);
    await rehydrating;

    expect(store.get("live")).toBe(live);
    expect(store.get("stale")?.title).toBe("New title");
    expect(store.get("creating")).toBe(creating);
    expect(store.list().map((projection) => projection.id).sort()).toEqual(
      ["creating", "live", "other", "stale"],
    );
    // Historical Sessions never touched by this process stay unsubscribed.
    expect(fake.listenerCounts("pi:other").legacy).toBe(0);
    expect(fake.listenerCounts("pi:stale").legacy).toBe(0);
  });

  it("keeps a subscribed Session wholesale across rehydrate even before any agent event", async () => {
    const fake = createFakeBridge();
    const store = createStore(fake, async () => [coldSession("bound", { title: "Cold" })]);
    store.insert(coldSession("bound"));
    const bound = store.apply("bound", {
      type: "runtime-bound",
      stage: "starting runtime",
      runtimeId: "runtime:bound",
      piSessionId: "pi:bound",
      occurredAt: "2026-09-24T09:00:01.000Z",
    });
    const accepted = store.apply("bound", {
      type: "creation-accepted",
      initialPrompt: "Forked text",
      occurredAt: "2026-09-24T09:00:02.000Z",
    });
    expect(bound.runtimeModel.lastSeq).toBe(0);

    await store.rehydrate();

    expect(store.get("bound")).toBe(accepted);
  });

  it("leaves the stored projection unchanged when the reducer rejects an event", () => {
    const store = createStore();
    const projection = boundSession("session-q");
    store.insert(projection);

    expect(() =>
      store.apply("session-q", {
        type: "queued-messages-reordered",
        orderedIds: ["missing"],
        occurredAt: "2026-09-24T10:00:00.000Z",
      }),
    ).toThrow(/missing/);
    expect(store.get("session-q")).toBe(projection);
  });

  it("releases the bridge subscription when a Session is archived or removed", () => {
    const fake = createFakeBridge();
    const store = createStore(fake);
    for (const id of ["archived", "removed"]) {
      store.insert(createSessionProjection({
        id,
        projectId: "pig",
        initialPrompt: id,
        createdAt: "2026-09-24T09:00:00.000Z",
      }));
      store.apply(id, {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: `runtime:${id}`,
        piSessionId: `pi:${id}`,
        occurredAt: "2026-09-24T09:00:01.000Z",
      });
      store.apply(id, {
        type: "creation-stage-changed",
        stage: "sending prompt",
        occurredAt: "2026-09-24T09:00:02.000Z",
      });
      expect(fake.listenerCounts(`pi:${id}`)).toEqual({ legacy: 1, agent: 1, modelControls: 1 });
    }
    // Archiving an active Session is rejected; settle it first.
    store.apply("archived", {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "done",
        piSessionId: "pi:archived",
        kind: "status",
        body: "Done",
        timestamp: "2026-09-24T09:00:03.000Z",
      },
    });

    store.apply("archived", { type: "session-archived", occurredAt: "2026-09-24T09:05:00.000Z" });
    store.remove("removed");

    expect(fake.listenerCounts("pi:archived")).toEqual({ legacy: 0, agent: 0, modelControls: 0 });
    expect(fake.listenerCounts("pi:removed")).toEqual({ legacy: 0, agent: 0, modelControls: 0 });
    expect(store.get("archived")?.archivedAt).toBe("2026-09-24T09:05:00.000Z");
    expect(store.get("removed")).toBeUndefined();
  });

  describe("history", () => {
    const loadedState = (
      piSessionId: string,
      overrides: Partial<PiSessionState> = {},
    ): PiSessionState => ({
      piSessionId,
      runtimeId: `runtime:${piSessionId}`,
      projectId: "pig",
      cwd: "/repo",
      status: "idle",
      events: [],
      updatedAt: "2026-09-24T10:00:00.000Z",
      ...overrides,
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("shares one read between concurrent views and resyncs onto the projection as it is when the read lands", async () => {
      const fake = createFakeBridge();
      const store = createStore(fake);
      store.insert(coldSession("viewed"));

      store.ensureHistory("viewed", { runtimeGeneration: 0 });
      store.ensureHistory("viewed", { runtimeGeneration: 0 });
      expect(fake.loads).toHaveLength(1);
      expect(store.historyState("viewed")).toBe("loading");

      // A run starts while the snapshot is in flight; the snapshot predates it.
      fake.emitAgent("pi:viewed", runStart(1, "run-1"));
      fake.loads[0]!.settle.resolve(loadedState("pi:viewed", { sessionName: "From history" }));
      await settle();

      const viewed = store.get("viewed")!;
      expect(store.historyState("viewed")).toBe("loaded");
      expect(viewed.sessionName).toBe("From history");
      expect(viewed.runtimeModel.lastSeq).toBe(1);
      expect(viewed.status).toBe("running");
    });

    it("keeps a failed read failed through projection changes until an explicit retry reads once", async () => {
      const fake = createFakeBridge();
      const store = createStore(fake);
      store.insert(coldSession("broken"));

      store.ensureHistory("broken", { runtimeGeneration: 0 });
      fake.loads[0]!.settle.reject(new Error("journal unreadable"));
      await settle();

      expect(store.historyState("broken")).toBe("failed");
      expect(store.get("broken")?.stale).toBe(true);
      expect(store.get("broken")?.staleReason).toBe("journal unreadable");

      // A refresh of the same Session (a live event, a re-render) is not a retry.
      fake.emitAgent("pi:broken", runStart(1, "run-1"));
      store.ensureHistory("broken", { runtimeGeneration: 0 });
      expect(fake.loads).toHaveLength(1);

      store.retryHistory("broken");
      store.retryHistory("broken");
      store.ensureHistory("broken", { runtimeGeneration: 0 });
      expect(fake.loads).toHaveLength(2);
      expect(store.historyState("broken")).toBe("loading");

      fake.loads[1]!.settle.resolve(loadedState("pi:broken"));
      await settle();
      expect(store.historyState("broken")).toBe("loaded");
      store.retryHistory("broken");
      expect(fake.loads).toHaveLength(2);
    });

    it.each([
      ["a legacy snapshot keeps", undefined, ["history-answer", "echo-during-read"]],
      ["a Gateway replay drops", [], ["history-answer"]],
    ] as const)(
      "%s echoes the snapshot does not carry",
      async (_label, replay, expectedIds) => {
        const fake = createFakeBridge();
        const store = createStore(fake);
        store.insert(coldSession("echoed"));

        store.ensureHistory("echoed", { runtimeGeneration: 0 });
        fake.emitLegacy({
          id: "echo-during-read",
          piSessionId: "pi:echoed",
          kind: "message",
          role: "user",
          body: "Sent while history loads",
          timestamp: "2026-09-24T10:00:01.000Z",
        });
        fake.loads[0]!.settle.resolve(
          loadedState("pi:echoed", {
            ...(replay ? { replay: [...replay] } : {}),
            events: [{
              id: "history-answer",
              piSessionId: "pi:echoed",
              kind: "message",
              role: "assistant",
              body: "From the journal",
              timestamp: "2026-09-24T09:59:00.000Z",
            }],
          }),
        );
        await settle();

        expect(store.get("echoed")?.runtimeEvents.map((event) => event.id)).toEqual(expectedIds);
      },
    );

    it("reads again once after the backend runtime generation changes", async () => {
      const fake = createFakeBridge();
      const store = createStore(fake);
      store.insert(coldSession("reconnected"));

      store.ensureHistory("reconnected", { runtimeGeneration: 0 });
      fake.loads[0]!.settle.resolve(loadedState("pi:reconnected"));
      await settle();
      store.ensureHistory("reconnected", { runtimeGeneration: 0 });
      expect(fake.loads).toHaveLength(1);

      store.ensureHistory("reconnected", { runtimeGeneration: 1 });
      store.ensureHistory("reconnected", { runtimeGeneration: 1 });
      expect(fake.loads).toHaveLength(2);
      expect(store.historyState("reconnected")).toBe("loading");
    });

    it("follows a viewed historical Session on one subscription per stream until it is removed", () => {
      const fake = createFakeBridge();
      const store = createStore(fake);
      store.insert(coldSession("historical"));
      expect(fake.listenerCounts("pi:historical")).toEqual({ legacy: 0, agent: 0, modelControls: 0 });

      store.ensureHistory("historical", { runtimeGeneration: 0 });
      store.ensureHistory("historical", { runtimeGeneration: 1 });
      expect(fake.listenerCounts("pi:historical")).toEqual({ legacy: 1, agent: 1, modelControls: 1 });

      store.remove("historical");
      expect(fake.listenerCounts("pi:historical")).toEqual({ legacy: 0, agent: 0, modelControls: 0 });
    });
  });
});
