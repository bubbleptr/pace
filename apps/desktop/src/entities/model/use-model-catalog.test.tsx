import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BackendRpcEvent } from "@pace/backend";
import type { ModelCatalogRefreshResult, RuntimeModelControls } from "@pace/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveVisibleModels } from "./visible-models";
import { startModelCatalogInvalidationBridge, useModelCatalog } from "./use-model-catalog";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function catalog(...modelIds: string[]): RuntimeModelControls {
  return {
    models: modelIds.map((modelId) => ({ provider: "openai", modelId, name: modelId, thinkingLevels: ["off"] })),
    selected: modelIds[0] ? { provider: "openai", modelId: modelIds[0], thinkingLevel: "off" } : null,
  };
}

function envelope(type: string): BackendRpcEvent {
  return {
    type: "event",
    event: { id: type, seq: 0, sessionId: "", piSessionId: "", type, ts: "2026-09-24T00:00:00Z", payload: {} },
  };
}

let listRequests: Array<Deferred<RuntimeModelControls>>;
let refreshRequests: Array<Deferred<ModelCatalogRefreshResult>>;
let backendListeners: Set<(event: BackendRpcEvent) => void>;
let invoke: ReturnType<typeof vi.fn>;

async function resolveList(index: number, controls: RuntimeModelControls) {
  await waitFor(() => expect(listRequests.length).toBeGreaterThan(index));
  await act(async () => {
    listRequests[index]!.resolve(controls);
  });
}

function modelIds(controls: RuntimeModelControls | null) {
  return controls?.models.map((model) => model.modelId);
}

function countCalls(command: string) {
  return invoke.mock.calls.filter(([called]) => called === command).length;
}

function setup(input?: Parameters<typeof useModelCatalog>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  startModelCatalogInvalidationBridge({ queryClient });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook((props: Parameters<typeof useModelCatalog>[0]) => useModelCatalog(props), {
    wrapper,
    initialProps: input,
  });
  return {
    ...view,
    emit: (type: string) => act(() => {
      for (const listener of backendListeners) listener(envelope(type));
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  listRequests = [];
  refreshRequests = [];
  backendListeners = new Set();
  invoke = vi.fn((command: string) => {
    if (command === "list_available_model_controls") {
      const request = deferred<RuntimeModelControls>();
      listRequests.push(request);
      return request.promise;
    }
    if (command === "refresh_model_catalog") {
      const request = deferred<ModelCatalogRefreshResult>();
      refreshRequests.push(request);
      return request.promise;
    }
    throw new Error(`unexpected backend command ${command}`);
  });
  window.pace = {
    invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
    onBackendEvent: vi.fn((listener: (event: BackendRpcEvent) => void) => {
      backendListeners.add(listener);
      return () => backendListeners.delete(listener);
    }),
    onBrowserEvent: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn(() => vi.fn()),
    onWindowFocusChanged: vi.fn(() => vi.fn()),
    onNavigateRequest: vi.fn(() => vi.fn()),
  };
});

afterEach(() => {
  delete window.pace;
});

describe("useModelCatalog", () => {
  it("refetches once on the global catalog signal and keeps the old list until the new one lands", async () => {
    const { result, emit } = setup();
    await resolveList(0, catalog("gpt-4.1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    emit("workspace.invalidated");
    emit("model_catalog.invalidated");
    await waitFor(() => expect(countCalls("list_available_model_controls")).toBe(2));
    expect(modelIds(result.current.controls)).toEqual(["gpt-4.1"]);

    await resolveList(1, catalog("claude-sonnet-4"));
    await waitFor(() => expect(modelIds(result.current.controls)).toEqual(["claude-sonnet-4"]));
    expect(countCalls("list_available_model_controls")).toBe(2);
  });

  it("never lets an older list response overwrite a newer one", async () => {
    const { result, emit } = setup();
    await resolveList(0, catalog("initial"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    emit("model_catalog.invalidated");
    await waitFor(() => expect(listRequests).toHaveLength(2));
    emit("model_catalog.invalidated");
    await waitFor(() => expect(listRequests).toHaveLength(3));

    await resolveList(2, catalog("fresh"));
    await waitFor(() => expect(modelIds(result.current.controls)).toEqual(["fresh"]));
    await resolveList(1, catalog("stale"));
    expect(modelIds(result.current.controls)).toEqual(["fresh"]);
  });

  it("shares one refresh request between concurrent callers and reports its result", async () => {
    const { result } = setup();
    await resolveList(0, catalog("gpt-4.1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<ModelCatalogRefreshResult>;
    let second!: Promise<ModelCatalogRefreshResult>;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(countCalls("refresh_model_catalog")).toBe(1);
    expect(result.current.refreshing).toBe(true);

    const outcome = { refreshedAt: "2026-09-24T00:00:00Z", errors: { anthropic: "401 Unauthorized" } };
    await act(async () => refreshRequests[0]!.resolve(outcome));
    await expect(first).resolves.toEqual(outcome);
    await expect(second).resolves.toEqual(outcome);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.lastRefresh).toEqual(outcome);
    // The refreshed catalog is re-read even where no backend signal reaches the renderer.
    await waitFor(() => expect(countCalls("list_available_model_controls")).toBe(2));
  });

  it("stays refreshing while an earlier refresh outlives a later forced one", async () => {
    const { result } = setup();
    await resolveList(0, catalog("gpt-4.1"));

    act(() => {
      void result.current.refresh();
      void result.current.refresh({ force: true });
    });
    expect(countCalls("refresh_model_catalog")).toBe(2);

    const outcome = { refreshedAt: "2026-09-24T00:00:00Z", errors: {} };
    await act(async () => refreshRequests[1]!.resolve(outcome));
    expect(result.current.refreshing).toBe(true);

    await act(async () => refreshRequests[0]!.resolve(outcome));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });

  it("prefers a live Session's own models over the global list", async () => {
    const own = catalog("session-model");
    const { result, rerender } = setup({ sessionProjection: { modelControls: own } });
    expect(result.current.controls).toEqual(own);
    expect(result.current.status).toBe("ready");
    expect(countCalls("list_available_model_controls")).toBe(0);

    rerender({ sessionProjection: { modelControls: { models: [], selected: null } } });
    await resolveList(0, catalog("global-model"));
    await waitFor(() => expect(modelIds(result.current.controls)).toEqual(["global-model"]));
  });

  it("lists only visible models but keeps the selected one", async () => {
    const { result } = setup();
    await resolveList(0, catalog("selected", "shown", "hidden"));
    await waitFor(() => expect(modelIds(result.current.controls)).toEqual(["selected", "shown", "hidden"]));

    act(() => saveVisibleModels([{ provider: "openai", modelId: "shown" }]));
    expect(modelIds(result.current.controls)).toEqual(["selected", "shown"]);
    expect(modelIds(result.current.catalog)).toEqual(["selected", "shown", "hidden"]);
  });
});
