import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PersistedSessionProjection } from "@pace/backend";
import { onBackendEvent } from "@/shared/runtime";
import { shouldUseBrowserDevelopmentData } from "@/dev/browser-development-data";
import {
  defaultRuntimeSummary,
  type ExecutionCheckout,
  type PiRuntimeBridge,
} from "@/entities/runtime/pi-runtime-bridge";
import { createDefaultPiRuntimeBridge } from "@/entities/runtime/pi-runtime-factory";
import {
  createSessionProjection,
  type SessionProjection,
  type SessionProjectionEvent,
} from "@/entities/session/session-projection";
import {
  createSessionProjectionsStore,
  type SessionProjectionsStore,
} from "@/entities/session/session-projections-store";
import { listSessionProjections } from "@/entities/session/sessions";

function sessionStatusFromPersistedProjection(
  status: PersistedSessionProjection["status"],
): SessionProjection["status"] {
  switch (status) {
    case "archived":
      return "archived";
    case "running":
    case "failed":
    case "completed":
      return status;
    case "idle":
    default:
      return "waiting";
  }
}

function checkoutFromPersistedProjection(
  checkout: PersistedSessionProjection["checkout"],
) {
  if (typeof checkout !== "object" || checkout === null) {
    return null;
  }

  return checkout as ExecutionCheckout;
}

export function sessionProjectionFromPersistedProjection(
  record: PersistedSessionProjection,
): SessionProjection {
  const projection = createSessionProjection({
    id: record.sessionId,
    projectId: record.projectId,
    initialPrompt: record.initialPrompt ?? "Untitled Session",
    createdAt: record.updatedAt,
  });
  const sessionFileMissing = Boolean(record.sessionFileMissing || !record.sessionFile);

  return {
    ...projection,
    title: record.title ?? null,
    sessionName: record.sessionName,
    cwd: record.cwd,
    status: sessionStatusFromPersistedProjection(record.status),
    creationStage: "accepted",
    checkout: checkoutFromPersistedProjection(record.checkout),
    runtimeId: record.runtimeId,
    piSessionId: record.piSessionId,
    sessionFile: record.sessionFile ?? null,
    summary: defaultRuntimeSummary(record.summary),
    modelControls: record.modelSelection
      ? {
          models: [],
          selected: { ...record.modelSelection },
        }
      : null,
    stale: sessionFileMissing,
    staleReason: sessionFileMissing
      ? "Session file is missing. Start a new Pace Session to continue from this Project."
      : null,
    archivedAt:
      record.archivedAt ??
      (record.status === "archived" ? record.updatedAt : null),
    lastUserMessageAt: record.lastUserMessageAt,
    updatedAt: record.updatedAt,
  };
}

type SessionProjectionsContextValue = {
  sessionProjections: SessionProjection[];
  sessionsHydrated: boolean;
  backendGeneration: number;
  store: SessionProjectionsStore;
  // The store subscribes on this bridge, so Sessions created or forked on the
  // page must go through the same instance.
  runtimeBridge: PiRuntimeBridge;
};

const SessionProjectionsContext = createContext<SessionProjectionsContextValue | null>(
  null,
);

// Changes only on backend reconnect, so readers of one Session subscribe
// through this context without re-rendering on every list change.
const SessionProjectionsStoreContext = createContext<{
  store: SessionProjectionsStore;
  runtimeGeneration: number;
} | null>(null);

/**
 * Hands one store to `useLiveSession`. The app provider uses it; a Sessions
 * view rendered without the app provider wraps its own store in it.
 */
export function SessionProjectionsStoreProvider({
  store,
  runtimeGeneration,
  children,
}: {
  store: SessionProjectionsStore;
  /** Bumps on backend reconnect; a new generation re-reads viewed history. */
  runtimeGeneration: number;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ store, runtimeGeneration }), [runtimeGeneration, store]);

  return (
    <SessionProjectionsStoreContext.Provider value={value}>
      {children}
    </SessionProjectionsStoreContext.Provider>
  );
}

const retryDelaysMs = [0, 150, 300, 600, 1200, 2000, 3000, 4000];

export function SessionProjectionsProvider({
  children,
  bridge,
}: {
  children: ReactNode;
  bridge?: PiRuntimeBridge;
}) {
  const browserDevelopmentData = useMemo(() => shouldUseBrowserDevelopmentData(), []);
  const [runtimeBridge] = useState(() => bridge ?? createDefaultPiRuntimeBridge());
  const [store] = useState(() =>
    createSessionProjectionsStore({
      bridge: runtimeBridge,
      listSessions: async () =>
        (await listSessionProjections()).map(sessionProjectionFromPersistedProjection),
    }),
  );
  const sessionProjections = useSyncExternalStore(store.subscribe, store.list);
  const [sessionsHydrated, setSessionsHydrated] = useState(
    () => browserDevelopmentData,
  );
  const [backendGeneration, setBackendGeneration] = useState(0);

  useEffect(
    () =>
      onBackendEvent((event) => {
        const payload = event.event.payload;
        if (payload.type === "session_info_changed" && typeof payload.name === "string") {
          store.rename(event.event.sessionId, { sessionName: payload.name.trim() });
        }
        if (
          event.event.sessionId === "__backend__" &&
          event.event.payload.lifecycle === "connected"
        ) {
          setBackendGeneration((generation) => generation + 1);
        }
      }),
    [store],
  );

  useEffect(() => {
    // Browser fixtures have no backend list; rehydrating would wipe them.
    if (browserDevelopmentData) {
      setSessionsHydrated(true);
      return;
    }

    let cancelled = false;

    void (async () => {
      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (cancelled) {
          return;
        }

        const delayMs = retryDelaysMs[attempt] ?? 0;
        if (delayMs > 0) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, delayMs);
          });
        }

        if (cancelled) {
          return;
        }

        try {
          await store.rehydrate();
          setSessionsHydrated(true);
          return;
        } catch {
          // Keep prior list; retry. Never wipe to [] on transient errors.
        }
      }

      if (!cancelled) {
        setSessionsHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backendGeneration, browserDevelopmentData, store]);

  const value = useMemo(
    () => ({
      sessionProjections,
      sessionsHydrated,
      backendGeneration,
      store,
      runtimeBridge,
    }),
    [backendGeneration, runtimeBridge, sessionProjections, sessionsHydrated, store],
  );

  return (
    <SessionProjectionsStoreProvider store={store} runtimeGeneration={backendGeneration}>
      <SessionProjectionsContext.Provider value={value}>
        {children}
      </SessionProjectionsContext.Provider>
    </SessionProjectionsStoreProvider>
  );
}

export function useSessionProjections() {
  const value = useContext(SessionProjectionsContext);

  if (!value) {
    throw new Error("useSessionProjections requires SessionProjectionsProvider");
  }

  return value;
}

/** Safe for tests / pages that may render AppFrame without the provider. */
export function useSessionProjectionsOptional(): SessionProjectionsContextValue | null {
  return useContext(SessionProjectionsContext);
}

/** The store `useLiveSession` reads, when one is provided. */
export function useSessionProjectionsStoreOptional() {
  return useContext(SessionProjectionsStoreContext);
}

/**
 * One Session's projection, read and written through the store. Selecting by
 * id keeps other Sessions' events from re-rendering the Live Session View.
 * Viewing a Session loads its history and follows its runtime.
 */
export function useLiveSession(sessionId: string | null) {
  const context = useContext(SessionProjectionsStoreContext);

  if (!context) {
    throw new Error("useLiveSession requires SessionProjectionsProvider");
  }

  const { store, runtimeGeneration } = context;
  const projection = useSyncExternalStore(store.subscribe, () =>
    sessionId ? store.get(sessionId) : undefined,
  );
  const history = useSyncExternalStore(store.subscribe, () =>
    sessionId ? store.historyState(sessionId) : "idle",
  );

  // Re-runs on every projection change: the history key follows the
  // projection's runtime identity, and the store makes repeats free.
  useEffect(() => {
    if (sessionId) store.ensureHistory(sessionId, { runtimeGeneration });
  }, [projection, runtimeGeneration, sessionId, store]);

  const apply = useCallback(
    (event: SessionProjectionEvent) => {
      if (!sessionId) throw new Error("No Session is on screen.");
      return store.apply(sessionId, event);
    },
    [sessionId, store],
  );
  const retryHistory = useCallback(() => {
    if (sessionId) store.retryHistory(sessionId);
  }, [sessionId, store]);

  return { projection, history, apply, retryHistory };
}
