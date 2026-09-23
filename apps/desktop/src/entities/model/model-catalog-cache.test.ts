import { QueryClient } from "@tanstack/react-query";
import type { BackendRpcEvent } from "@pace/backend";
import { describe, expect, it, vi } from "vitest";
import {
  readCachedModelCatalog,
  rememberModelCatalog,
  startModelCatalogInvalidationBridge,
  subscribeModelCatalogInvalidation,
} from "./model-catalog-cache";

function envelope(type: string): BackendRpcEvent {
  return {
    type: "event",
    event: { id: type, seq: 0, sessionId: "", piSessionId: "", type, ts: "2026-09-24T00:00:00Z", payload: {} },
  };
}

describe("model catalog invalidation bridge", () => {
  it("turns the global catalog signal into cache and query invalidation", () => {
    let receive!: (event: BackendRpcEvent) => void;
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const composerReload = vi.fn();
    subscribeModelCatalogInvalidation(composerReload);
    rememberModelCatalog([{ provider: "openai", modelId: "gpt-4.1", name: "GPT-4.1", thinkingLevels: ["off"] }]);
    startModelCatalogInvalidationBridge({
      queryClient,
      onBackendEvent: (listener) => {
        receive = listener;
        return () => {};
      },
    });

    receive(envelope("workspace.invalidated"));
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(composerReload).not.toHaveBeenCalled();
    expect(readCachedModelCatalog()).toHaveLength(1);

    receive(envelope("model_catalog.invalidated"));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["available-model-controls"] });
    expect(composerReload).toHaveBeenCalledTimes(1);
    expect(readCachedModelCatalog()).toEqual([]);
  });
});
