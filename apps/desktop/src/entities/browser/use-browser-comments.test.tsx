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

function installPreload(options: { listGate?: Promise<void>; revision?: number } = {}) {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const invoke = vi.fn(async (command: string, args?: unknown) => {
    if (command === "browser_list_comments") {
      await options.listGate;
      void args;
      return { revision: options.revision ?? 1, comments: [comment("c1", 1)] };
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
      publish({
        type: "comments-changed",
        sessionId: "s",
        revision: 2,
        comments: next,
      });
    });

    expect(result.current.comments).toBe(next);
    // latest() reads the ref the event wrote synchronously — a submit in the
    // same tick already sees the new list.
    expect(result.current.latest()).toBe(next);
  });

  it("drops a list reply older than an event it was overtaken by", async () => {
    let release = () => {};
    const { publish } = installPreload({
      listGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
      revision: 1,
    });
    const { result } = renderHook(() => useBrowserComments("s"));

    const newer = [comment("c9", 1)];
    act(() => {
      publish({
        type: "comments-changed",
        sessionId: "s",
        revision: 5,
        comments: newer,
      });
    });
    await act(async () => release());

    // The reply was older news than the event: applying it would resurrect a
    // comment the store has already dropped.
    expect(result.current.comments).toBe(newer);
  });

  it("applies a list reply newer than the events seen so far", async () => {
    const { publish } = installPreload({ revision: 7 });
    const { result } = renderHook(() => useBrowserComments("s"));

    act(() => {
      publish({
        type: "comments-changed",
        sessionId: "s",
        revision: 5,
        comments: [comment("c9", 1)],
      });
    });

    // Events can overtake the reply en route: a fresh answer still lands.
    await waitFor(() =>
      expect(result.current.comments[0]).toMatchObject({ id: "c1" }),
    );
  });

  it("drops an event older than the revision already applied", async () => {
    const { publish } = installPreload();
    const { result } = renderHook(() => useBrowserComments("s"));

    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    const latest = [comment("c2", 1), comment("c1", 2)];
    act(() => {
      publish({
        type: "comments-changed",
        sessionId: "s",
        revision: 3,
        comments: latest,
      });
      publish({
        type: "comments-changed",
        sessionId: "s",
        revision: 2,
        comments: [comment("ghost", 1)],
      });
    });

    expect(result.current.comments).toBe(latest);
  });

  it("ignores another Session's events", async () => {
    const { publish } = installPreload();
    const { result } = renderHook(() => useBrowserComments("s"));

    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => {
      publish({
        type: "comments-changed",
        sessionId: "other",
        revision: 9,
        comments: [comment("x", 1), comment("y", 2)],
      });
    });

    expect(result.current.comments).toHaveLength(1);
  });

  it("hands the page's submit request to its callback", async () => {
    const { publish } = installPreload();
    const onSubmitRequested = vi.fn();
    renderHook(() =>
      useBrowserComments("s", { onSubmitRequested }),
    );

    act(() => {
      publish({ type: "submit-requested", sessionId: "s" });
      publish({ type: "submit-requested", sessionId: "other" });
    });

    expect(onSubmitRequested).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callback, not the one rendered with", async () => {
    const { publish } = installPreload();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onSubmitRequested }) =>
        useBrowserComments("s", { onSubmitRequested }),
      { initialProps: { onSubmitRequested: first } },
    );

    rerender({ onSubmitRequested: second });
    act(() => {
      publish({ type: "submit-requested", sessionId: "s" });
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
