// The renderer's one read point for the Model Catalog (ADR-0043 §6). Every
// surface that lists models — Settings, the Draft composer and the Live
// composer's fallback — reads one TanStack entry, so a refresh or a
// credential change reaches all of them at once.

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ModelCatalogRefreshResult, RuntimeModelControls } from "@pace/core";
import { invoke, onBackendEvent as onRuntimeBackendEvent } from "@/shared/runtime";
import { visibleModelsOf } from "@/shared/ui/model-selector/model-selector-logic";
import { useVisibleModels } from "./visible-models";

const modelCatalogQueryKey = ["available-model-controls"] as const;

/**
 * App-level, started once: the backend's global model_catalog.invalidated
 * signal (startup refresh, credential change, manual refresh) re-reads the
 * catalog for every mounted reader (ADR-0043 §4). Invalidation keeps the
 * previous list on screen until the new one resolves.
 */
export function startModelCatalogInvalidationBridge({
  queryClient,
  onBackendEvent = onRuntimeBackendEvent,
}: {
  queryClient: QueryClient;
  onBackendEvent?: typeof onRuntimeBackendEvent;
}) {
  return onBackendEvent((event) => {
    if (event.type !== "event" || event.event.type !== "model_catalog.invalidated") return;
    void queryClient.invalidateQueries({ queryKey: modelCatalogQueryKey });
  });
}

type RefreshState = {
  refreshing: boolean;
  lastRefresh: ModelCatalogRefreshResult | null;
};

// TanStack's mutation isPending follows only the latest call, so a refresh
// started earlier could still be running after it flips false and re-enable
// Refresh models over an open request. This list is the busy signal, and
// non-force callers join the request already in flight. Kept per QueryClient
// so it lives exactly as long as the catalog it refreshes.
type RefreshGate = {
  inFlight: Array<Promise<ModelCatalogRefreshResult>>;
  state: RefreshState;
  listeners: Set<() => void>;
};

const refreshGates = new WeakMap<QueryClient, RefreshGate>();

function refreshGateFor(queryClient: QueryClient) {
  let gate = refreshGates.get(queryClient);
  if (!gate) {
    gate = { inFlight: [], state: { refreshing: false, lastRefresh: null }, listeners: new Set() };
    refreshGates.set(queryClient, gate);
  }
  return gate;
}

function publish(gate: RefreshGate, patch: Partial<RefreshState>) {
  gate.state = { ...gate.state, ...patch };
  for (const listener of gate.listeners) listener();
}

function startRefresh(queryClient: QueryClient, force: boolean) {
  const gate = refreshGateFor(queryClient);
  if (!force && gate.inFlight.length > 0) return gate.inFlight[0];

  const promise = invoke<ModelCatalogRefreshResult>("refresh_model_catalog", { force })
    .then((result) => {
      if (!("offline" in result)) {
        // The browser shell and dev mocks have no backend signal; re-read here too.
        void queryClient.invalidateQueries({ queryKey: modelCatalogQueryKey });
      }
      publish(gate, { lastRefresh: result });
      return result;
    })
    .finally(() => {
      gate.inFlight = gate.inFlight.filter((entry) => entry !== promise);
      publish(gate, { refreshing: gate.inFlight.length > 0 });
    });
  gate.inFlight = [...gate.inFlight, promise];
  publish(gate, { refreshing: true });
  return promise;
}

export type ModelCatalog = {
  /** Visible-filtered; the selected model always survives the filter. */
  controls: RuntimeModelControls | null;
  /** Unfiltered, for Settings, where hidden models are switched back on. */
  catalog: RuntimeModelControls | null;
  status: "loading" | "ready" | "error";
  error: unknown;
  refresh(input?: { force?: boolean }): Promise<ModelCatalogRefreshResult>;
  refreshing: boolean;
  lastRefresh: ModelCatalogRefreshResult | null;
};

export function useModelCatalog(input?: {
  /** A live Session's own catalog wins over the global list once it has models. */
  sessionProjection?: { modelControls: RuntimeModelControls | null } | null;
}): ModelCatalog {
  const queryClient = useQueryClient();
  const projected = input?.sessionProjection?.modelControls?.models.length
    ? input.sessionProjection.modelControls
    : null;
  const query = useQuery({
    queryKey: modelCatalogQueryKey,
    queryFn: () => invoke<RuntimeModelControls>("list_available_model_controls"),
    enabled: !projected,
  });
  const gate = refreshGateFor(queryClient);
  const { refreshing, lastRefresh } = useSyncExternalStore(
    useCallback((listener: () => void) => {
      gate.listeners.add(listener);
      return () => {
        gate.listeners.delete(listener);
      };
    }, [gate]),
    () => gate.state,
  );
  const visibleModels = useVisibleModels();
  const catalog = projected ?? query.data ?? null;
  const controls = useMemo(
    () => catalog && {
      ...catalog,
      models: visibleModelsOf(catalog.models, visibleModels, catalog.selected),
    },
    [catalog, visibleModels],
  );
  const refresh = useCallback(
    (options?: { force?: boolean }) => startRefresh(queryClient, options?.force ?? false),
    [queryClient],
  );

  return {
    controls,
    catalog,
    status: projected || query.isSuccess ? "ready" : query.isError ? "error" : "loading",
    error: projected ? null : query.error,
    refresh,
    refreshing,
    lastRefresh,
  };
}
