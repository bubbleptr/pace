import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaceRendererApi } from "@/shared/runtime";
import type {
  BrowserComment,
  BrowserEvent,
} from "@/shared/browser-protocol";
import { useBrowserComments } from "./use-browser-comments";

function comment(id: string, index: number): BrowserComment {
  return {
    id,
    index,
    selector: `#${id}`,
    tag: "button",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    tabId: "t1",
    url: "http://localhost:3000/",
    title: "A",
    viewport: { width: 800, height: 600, dpr: 1 },
    stale: false,
    hasImage: false,
    createdAt: "2026-10-10T09:00:00.000Z",
  };
}

function installPreload(options: { listGate?: Promise<void> } = {}) {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const invoke = vi.fn(async (command: string, args?: unknown) => {
    if (command === "browser_list_comments") {
      await options.listGate;
      void args;
      return [comment("c1", 1)];
    }
    return null;
  });

  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: () => () => {},
    onBrowserEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onWindowFocusChanged: () => () => {},
    onNavigateRequest: () => () => {},
    onUpdateEvent: () => () => {},
  };

  return {
    invoke,
    publish(event: BrowserEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

afterEach(() => {
  delete window.pace;
});

describe("useBrowserComments", () => {
  it("starts empty outside the Electron runtime", () => {
    const { result } = renderHook(() => useBrowserComments("s"));

    expect(result.current.comments).toEqual([]);
    expect(result.current.latest()).toEqual([]);
  });

  it("lists the Session's comments on mount", async () => {
    installPreload();
    const { result } = renderHook(() => useBrowserComments("s"));

    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0]).toMatchObject({ id: "c1" });
    expect(result.current.latest()[0]).toMatchObject({ id: "c1" });
  });

  it("replaces the list when the Session's store changes", async () => {
    const { publish } = installPreload();
    const { result } = renderHook(() => useBrowserComments("s"));

    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    const next = [comment("c2", 1), comment("c1", 2)];
    act(() => {
      publish({ type: "comments-changed", sessionId: "s", comments: next });
    });

    expect(result.current.comments).toBe(next);
    // latest() reads the ref the event wrote synchronously — a submit in the
    // same tick already sees the new list.
    expect(result.current.latest()).toBe(next);
  });

  it("lets an event that beat the list reply win", async () => {
    let release = () => {};
    const { publish } = installPreload({
      listGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const { result } = renderHook(() => useBrowserComments("s"));

    const newer = [comment("c9", 1)];
    act(() => {
      publish({ type: "comments-changed", sessionId: "s", comments: newer });
    });
    await act(async () => release());

    // The reply was older news than the event: applying it would resurrect a
    // comment the store has already dropped.
    expect(result.current.comments).toBe(newer);
  });

  it("ignores another Session's events", async () => {
    const { publish } = installPreload();
    const { result } = renderHook(() => useBrowserComments("s"));

    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => {
      publish({
        type: "comments-changed",
        sessionId: "other",
        comments: [comment("x", 1), comment("y", 2)],
      });
    });

    expect(result.current.comments).toHaveLength(1);
  });
});
