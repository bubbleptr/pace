import type { PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import {
  applySessionProjectionEvent,
  type SessionProjection,
  type SessionProjectionEvent,
} from "@/entities/session/session-projection";

type SessionProjectionsBridge = Pick<
  PiRuntimeBridge,
  "subscribeToEvents" | "subscribeToAgentEvents" | "subscribeToModelControls"
>;

export type SessionProjectionsStore = {
  get(sessionId: string): SessionProjection | undefined;
  list(): SessionProjection[];
  /** Seeds a Session the store has not seen: a draft or fork being created, or a browser fixture. */
  insert(projection: SessionProjection): SessionProjection;
  apply(sessionId: string, event: SessionProjectionEvent): SessionProjection;
  /**
   * @deprecated transitional (ADR-0044 PR ②): LiveSessionColumn still commits
   * whole projections through `onProjectionChange`. PR ② deletes this.
   */
  save(projection: SessionProjection): void;
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

  const commit = (next: SessionProjection[]) => {
    projections = next;
    for (const listener of listeners) listener();
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
    save(projection) {
      if (get(projection.id)) {
        replace(projection);
      } else {
        commit([projection, ...projections]);
      }
    },
    rename(sessionId, name) {
      const current = get(sessionId);
      if (current) replace({ ...current, ...name });
    },
    remove(sessionId) {
      release(sessionId);
      commit(projections.filter((projection) => projection.id !== sessionId));
    },
    async rehydrate() {
      const records = await options.listSessions();
      // Merge against the store as it is now: Sessions may have been created
      // or advanced while the backend list was in flight.
      const listed = new Set(records.map((record) => record.id));
      const merged = records.map((record) => {
        const current = get(record.id);
        return current && isLiveOwned(current, subscriptions.has(current.id))
          ? current
          : record;
      });
      // The backend has no record of a Session until creation binds a runtime.
      const creating = projections.filter(
        (projection) => !listed.has(projection.id) && projection.status === "creating",
      );
      const kept = new Set([...merged, ...creating].map((projection) => projection.id));
      for (const sessionId of subscriptions.keys()) {
        if (!kept.has(sessionId)) release(sessionId);
      }
      commit([...creating, ...merged]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
