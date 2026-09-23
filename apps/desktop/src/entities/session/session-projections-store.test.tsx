import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntimeEventEntry,
  PiRuntimeBridge,
  PiRuntimeEvent,
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
// still attached after a Session's lifecycle ends.
function createFakeBridge() {
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
  };

  return {
    bridge,
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
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    const accepted = { ...bound, creationStage: "accepted" as const };
    store.save(accepted);

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

  // Transitional (ADR-0044 PR ②): LiveSessionColumn still writes whole projections.
  it("saves a whole projection by id, inserting unknown Sessions first", () => {
    const store = createStore();
    store.insert(coldSession("older"));
    store.insert(coldSession("newer"));

    const replaced = coldSession("older", { title: "Replaced" });
    store.save(replaced);
    store.save(coldSession("newest"));

    expect(store.list().map((projection) => projection.id)).toEqual(["newest", "newer", "older"]);
    expect(store.get("older")).toBe(replaced);
  });
});
