import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getVisibleModels,
  saveVisibleModels,
  useVisibleModels,
  visibleModelsStorageKey,
} from "@/entities/model/visible-models";

describe("visible models preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the visible model set and starts out unconfigured", () => {
    expect(getVisibleModels()).toBeNull();

    saveVisibleModels([
      { provider: "xai", modelId: "grok-4" },
      { provider: "anthropic", modelId: "claude-sonnet-4" },
    ]);

    expect(getVisibleModels()).toEqual([
      { provider: "xai", modelId: "grok-4" },
      { provider: "anthropic", modelId: "claude-sonnet-4" },
    ]);
  });

  it("reads an unusable stored value as unconfigured instead of throwing", () => {
    window.localStorage.setItem(visibleModelsStorageKey, "{not json");

    expect(getVisibleModels()).toBeNull();

    window.localStorage.setItem(visibleModelsStorageKey, '[{"provider":"xai"}]');

    expect(getVisibleModels()).toBeNull();
  });

  it("keeps an explicitly emptied set apart from never configured", () => {
    saveVisibleModels([]);

    expect(getVisibleModels()).toEqual([]);
  });

  it("updates a mounted reader when Settings saves a new set", () => {
    // Settings opens as a dialog over the workspace, so the composer never
    // remounts; the selector must follow the save without one.
    const { result } = renderHook(() => useVisibleModels());
    expect(result.current).toBeNull();

    act(() => {
      saveVisibleModels([{ provider: "xai", modelId: "grok-4" }]);
    });

    expect(result.current).toEqual([{ provider: "xai", modelId: "grok-4" }]);

    // useSyncExternalStore re-renders forever on a snapshot that changes
    // identity without changing content.
    const { result: again } = renderHook(() => useVisibleModels());
    expect(again.current).toBe(result.current);
  });
});
