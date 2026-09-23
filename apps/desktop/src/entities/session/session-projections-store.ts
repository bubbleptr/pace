import type { PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import {
  applySessionProjectionEvent,
  type SessionProjection,
  type SessionProjectionEvent,
} from "@/entities/session/session-projection";

type SessionProjectionsBridge = Pick<
  PiRuntimeBridge,
  "subscribeToEvents" | "subscribeToAgentEvents" | "subscribeToModelControls" | "loadSession"
>;

export type SessionHistoryState = "idle" | "loading" | "loaded" | "failed";

export type SessionProjectionsStore = {
  get(sessionId: string): SessionProjection | undefined;
  list(): SessionProjection[];
  /** Seeds a Session the store has not seen: a draft or fork being created, or a browser fixture. */
  insert(projection: SessionProjection): SessionProjection;
  apply(sessionId: string, event: SessionProjectionEvent): SessionProjection;
  /**
   * Reads a viewed Session's history once per (piSessionId, sessionFile,
   * runtimeGeneration) and follows its runtime from then on. Concurrent calls
   * share the read; a failed read waits for `retryHistory`.
   */
  ensureHistory(sessionId: string, input: { runtimeGeneration: number }): void;
  retryHistory(sessionId: string): void;
  historyState(sessionId: string): SessionHistoryState;
  rename(
    sessionId: string,
    name: { title: string } | { sessionName: string },
  ): void;
  remove(sessionId: string): void;
  rehydrate(): Promise<void>;
  subscribe(listener: () => void): () => void;
};

// A projection this process has advanced past its persisted record. Replacing
// it with the backend's cold snapshot (lastSeq 0, no events) would erase live
// chat state, so rehydrate keeps it wholesale.
function isLiveOwned(projection: SessionProjection, subscribed: boolean) {
  return (
    subscribed ||
    projection.runtimeModel.lastSeq > 0 ||
    projection.creationStage !== "accepted"
  );
}

/**
 * The renderer's single writer of Session Projections (ADR-0044). It also owns
 * one bridge subscription per Session made live in this process, so
 * background Sessions keep updating whether or not a view is showing them.
 */
export function createSessionProjectionsStore(options: {
  bridge: SessionProjectionsBridge;
  listSessions: () => Promise<SessionProjection[]>;
}): SessionProjectionsStore {
  const { bridge } = options;
  // Replaced on every mutation so `list()` is a stable useSyncExternalStore snapshot.
  let projections: SessionProjection[] = [];
  const listeners = new Set<() => void>();
  const subscriptions = new Map<string, { piSessionId: string; release: () => void }>();
  const history = new Map<
    string,
    { key: string; piSessionId: string; state: Exclude<SessionHistoryState, "idle"> }
  >();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const commit = (next: SessionProjection[]) => {
    projections = next;
    notify();
  };
  const get = (sessionId: string) =>
    projections.find((projection) => projection.id === sessionId);
  const replace = (projection: SessionProjection) =>
    commit(projections.map((current) => (current.id === projection.id ? projection : current)));

  const release = (sessionId: string) => {
    subscriptions.get(sessionId)?.release();
    subscriptions.delete(sessionId);
  };
  const subscribe = (sessionId: string, piSessionId: string) => {
    if (subscriptions.get(sessionId)?.piSessionId === piSessionId) return;
    release(sessionId);

    // Events apply on the store's current projection, never a caller's snapshot.
    const unsubscribeLegacy = bridge.subscribeToEvents(piSessionId, (event) => {
      apply(sessionId, { type: "runtime-event-received", event });
    });
    const unsubscribeAgent = bridge.subscribeToAgentEvents?.(piSessionId, (entry) => {
      apply(sessionId, { type: "agent-event-received", entry });
    });
    const unsubscribeModelControls = bridge.subscribeToModelControls?.(
      piSessionId,
      (modelControls, occurredAt) => {
        apply(sessionId, { type: "model-controls-changed", modelControls, occurredAt });
      },
    );
    subscriptions.set(sessionId, {
      piSessionId,
      release: () => {
        unsubscribeLegacy();
        unsubscribeAgent?.();
        unsubscribeModelControls?.();
      },
    });
  };

  function apply(sessionId: string, event: SessionProjectionEvent) {
    const current = get(sessionId);
    if (!current) {
      throw new Error(`Session "${sessionId}" is not in the projection store.`);
    }

    // The reducer throws on events it cannot place (an unknown queued id);
    // that propagates before anything is stored.
    const next = applySessionProjectionEvent(current, event);
    replace(next);

    if (event.type === "runtime-bound") {
      subscribe(sessionId, event.piSessionId);
    } else if (event.type === "session-archived" || event.type === "creation-failed") {
      // A failed creation never becomes a Session to follow; the creator used
      // to drop its subscription on this path too.
      release(sessionId);
    }

    return next;
  }

  const loadHistory = (sessionId: string, piSessionId: string, key: string) => {
    const loadSession = bridge.loadSession!;
    const current = () => history.get(sessionId)?.key === key;

    history.set(sessionId, { key, piSessionId, state: "loading" });
    notify();

    // A read superseded by a newer key (or a removed Session) lands nowhere.
    void loadSession({ sessionId, piSessionId })
      .then((state) => {
        const base = get(sessionId);
        if (!current() || !base) return;

        // The snapshot predates whatever the subscription applied while it
        // was in flight, so it resyncs onto the projection as it is now.
        let next = applySessionProjectionEvent(base, { type: "runtime-state-resynced", state });
        const snapshotEventIds = new Set(state.events.map((event) => event.id));
        // Gateway reads already merge concurrent events in sequence. Only
        // legacy bridges need to retain echoes absent from their snapshots.
        for (const event of state.replay ? [] : base.runtimeEvents) {
          if (!snapshotEventIds.has(event.id)) {
            next = applySessionProjectionEvent(next, { type: "runtime-event-received", event });
          }
        }
        history.set(sessionId, { key, piSessionId, state: "loaded" });
        replace(next);
      })
      .catch((error: unknown) => {
        if (!current()) return;

        history.set(sessionId, { key, piSessionId, state: "failed" });
        const base = get(sessionId);
        if (!base) return notify();
        replace(
          applySessionProjectionEvent(base, {
            type: "projection-marked-stale",
            reason: error instanceof Error ? error.message : "Pace could not load session history.",
            occurredAt: new Date().toISOString(),
          }),
        );
      });
  };

  return {
    get,
    list: () => projections,
    insert(projection) {
      if (get(projection.id)) {
        throw new Error(`Session "${projection.id}" is already in the projection store.`);
      }
      commit([projection, ...projections]);
      return projection;
    },
    apply,
    ensureHistory(sessionId, { runtimeGeneration }) {
      const projection = get(sessionId);
      // A Session still being created is already followed from
      // `runtime-bound`; its history is what the creator is writing.
      if (!projection?.piSessionId || projection.creationStage !== "accepted") return;

      // Viewing a Session makes it live in this process (ADR-0044 §2).
      subscribe(sessionId, projection.piSessionId);
      if (!bridge.loadSession) return;

      const key = [projection.piSessionId, projection.sessionFile, runtimeGeneration].join("\u0000");
      if (history.get(sessionId)?.key === key) return;
      loadHistory(sessionId, projection.piSessionId, key);
    },
    retryHistory(sessionId) {
      const entry = history.get(sessionId);
      if (entry?.state === "failed") loadHistory(sessionId, entry.piSessionId, entry.key);
    },
    historyState: (sessionId) => history.get(sessionId)?.state ?? "idle",
    rename(sessionId, name) {
      const current = get(sessionId);
      if (current) replace({ ...current, ...name });
    },
    remove(sessionId) {
      release(sessionId);
      history.delete(sessionId);
      commit(projections.filter((projection) => projection.id !== sessionId));
    },
    async rehydrate() {
      const records = await options.listSessions();
      // Merge against the store as it is now: Sessions may have been created
      // or advanced while the backend list was in flight.
      const liveOwned = (projection: SessionProjection) =>
        isLiveOwned(projection, subscriptions.has(projection.id));
      const listed = new Set(records.map((record) => record.id));
      const merged = records.map((record) => {
        const current = get(record.id);
        return current && liveOwned(current) ? current : record;
      });
      // A Session being created has no backend record until its runtime is bound.
      const unlisted = projections.filter(
        (projection) => !listed.has(projection.id) && liveOwned(projection),
      );
      commit([...unlisted, ...merged]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
