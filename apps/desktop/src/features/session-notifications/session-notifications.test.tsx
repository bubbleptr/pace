import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionProjection,
  type SessionProjection,
} from "@/entities/session/session-projection";
import type { SessionProjectionsStore } from "@/entities/session/session-projections-store";
import {
  SessionProjectionsProvider,
  useSessionProjections,
} from "@/entities/session/use-session-projections";
import type { PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import { render } from "@/test/render";
import { SessionNotifications } from "./session-notifications";

class FakeNotification {
  static permission: "granted" | "denied" | "default" = "granted";
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

const bridge = {
  subscribeToEvents: () => () => {},
  subscribeToAgentEvents: () => () => {},
  subscribeToModelControls: () => () => {},
} as unknown as PiRuntimeBridge;

function runningProjection(): SessionProjection {
  return {
    ...createSessionProjection({
      id: "session-notif",
      projectId: "pig-docs",
      initialPrompt: "Notify me",
      createdAt: "2026-09-20T08:00:00.000Z",
    }),
    status: "running",
    runtimeId: "pi-sdk:session-notif",
    piSessionId: "pi-session-notif",
  };
}

describe("SessionNotifications", () => {
  beforeEach(() => {
    // Skips the provider's rehydrate path, which needs a backend list.
    window.__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__ = true;
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(window, "focus").mockImplementation(() => {});
  });

  afterEach(() => {
    delete window.__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("notifies when a store-driven run ends and opens the Session on click", () => {
    let store: SessionProjectionsStore | null = null;
    function Probe() {
      store = useSessionProjections().store;
      return null;
    }
    const onOpen = vi.fn();
    render(
      <SessionProjectionsProvider bridge={bridge}>
        <Probe />
        <SessionNotifications onOpen={onOpen} />
      </SessionProjectionsProvider>,
    );

    act(() => {
      store!.insert(runningProjection());
    });
    act(() => {
      store!.apply("session-notif", {
        type: "run-completed",
        event: {
          id: "evt-done",
          piSessionId: "pi-session-notif",
          kind: "message",
          role: "assistant",
          body: "done",
          timestamp: "2026-09-20T08:01:00.000Z",
        },
      });
    });

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0];
    expect(notification.title).toBe("Notify me");
    expect(notification.options).toEqual({
      body: "Finished",
      tag: "session-notif",
    });

    notification.onclick?.();

    expect(onOpen).toHaveBeenCalledWith({
      id: "session-notif",
      projectId: "pig-docs",
    });
  });
});
