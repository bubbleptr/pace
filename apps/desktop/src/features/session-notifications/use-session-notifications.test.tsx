import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionNotifications } from "./use-session-notifications";
import type { SessionNotificationSource } from "./session-notices";
import type { SessionStatus } from "@/entities/session/session-projection";

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

function sessionsWith(status: SessionStatus): SessionNotificationSource[] {
  return [{ id: "s1", title: "Fix the bug", status }];
}

describe("useSessionNotifications", () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(window, "focus").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not notify while the window is in front", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const onOpen = vi.fn();
    const { rerender } = renderHook(
      ({ sessions }) => useSessionNotifications(sessions, onOpen),
      { initialProps: { sessions: sessionsWith("running") } },
    );

    rerender({ sessions: sessionsWith("completed") });

    expect(FakeNotification.instances).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("notifies when the window is not in front and opens the session on click", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const onOpen = vi.fn();
    const { rerender } = renderHook(
      ({ sessions }) => useSessionNotifications(sessions, onOpen),
      { initialProps: { sessions: sessionsWith("running") } },
    );

    rerender({ sessions: sessionsWith("completed") });

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0];
    expect(notification.title).toBe("Fix the bug");
    expect(notification.options).toEqual({ body: "Finished", tag: "s1" });

    notification.onclick?.();

    expect(window.focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("s1");
    expect(notification.close).toHaveBeenCalled();
  });

  it("does not notify when permission is not granted", () => {
    FakeNotification.permission = "denied";
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const onOpen = vi.fn();
    const { rerender } = renderHook(
      ({ sessions }) => useSessionNotifications(sessions, onOpen),
      { initialProps: { sessions: sessionsWith("running") } },
    );

    rerender({ sessions: sessionsWith("completed") });

    expect(FakeNotification.instances).toHaveLength(0);
  });
});
