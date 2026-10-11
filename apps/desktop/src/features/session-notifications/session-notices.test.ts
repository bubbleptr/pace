import { describe, expect, it } from "vitest";
import {
  diffSessionNotices,
  type SessionNotificationSource,
  type SessionStatusBaseline,
} from "./session-notices";
import type { SessionStatus } from "@/entities/session/session-projection";

function source(
  id: string,
  status: SessionStatus,
  title = `Session ${id}`,
): SessionNotificationSource {
  return { id, title, status };
}

function baselineOf(
  entries: ReadonlyArray<readonly [string, SessionStatus]>,
): SessionStatusBaseline {
  return new Map(entries);
}

describe("diffSessionNotices", () => {
  it("seeds the baseline silently on the first snapshot", () => {
    const { notices, baseline } = diffSessionNotices(undefined, [
      source("a", "running"),
      source("b", "completed"),
      source("c", "failed"),
    ]);

    expect(notices).toEqual([]);
    expect(baseline.get("a")).toBe("running");
    expect(baseline.get("b")).toBe("completed");
    expect(baseline.get("c")).toBe("failed");
    expect(baseline.size).toBe(3);
  });

  it("notifies Finished when a running session completes", () => {
    const { notices } = diffSessionNotices(
      baselineOf([["a", "running"]]),
      [source("a", "completed", "Fix the bug")],
    );

    expect(notices).toEqual([
      { sessionId: "a", title: "Fix the bug", body: "Finished" },
    ]);
  });

  it("notifies Finished when a running session goes idle (waiting)", () => {
    const { notices } = diffSessionNotices(
      baselineOf([["a", "running"]]),
      [source("a", "waiting")],
    );

    expect(notices).toEqual([
      { sessionId: "a", title: "Session a", body: "Finished" },
    ]);
  });

  it("notifies Failed when a running session fails", () => {
    const { notices } = diffSessionNotices(
      baselineOf([["a", "running"]]),
      [source("a", "failed")],
    );

    expect(notices).toEqual([
      { sessionId: "a", title: "Session a", body: "Failed" },
    ]);
  });

  it("notifies Failed when a creating session fails", () => {
    const { notices } = diffSessionNotices(
      baselineOf([["a", "creating"]]),
      [source("a", "failed")],
    );

    expect(notices).toEqual([
      { sessionId: "a", title: "Session a", body: "Failed" },
    ]);
  });

  it("stays silent while a run continues or stays ended", () => {
    for (const [previous, current] of [
      ["creating", "running"],
      ["waiting", "running"],
      ["completed", "completed"],
    ] as const) {
      const { notices } = diffSessionNotices(baselineOf([["a", previous]]), [
        source("a", current),
      ]);
      expect(notices).toEqual([]);
    }
  });

  it("never notifies for a session absent from the previous baseline", () => {
    const { notices } = diffSessionNotices(baselineOf([["a", "running"]]), [
      source("a", "running"),
      source("new", "completed"),
      source("other", "failed"),
    ]);

    expect(notices).toEqual([]);
  });

  it("emits one notice per session ending in the same update", () => {
    const { notices, baseline } = diffSessionNotices(
      baselineOf([
        ["a", "running"],
        ["b", "running"],
        ["c", "running"],
      ]),
      [source("a", "completed"), source("b", "failed"), source("c", "running")],
    );

    expect(notices).toEqual([
      { sessionId: "a", title: "Session a", body: "Finished" },
      { sessionId: "b", title: "Session b", body: "Failed" },
    ]);
    expect(baseline.get("c")).toBe("running");
  });

  it("drops sessions that disappeared from the input", () => {
    const { baseline } = diffSessionNotices(
      baselineOf([
        ["a", "running"],
        ["gone", "completed"],
      ]),
      [source("a", "running")],
    );

    expect(baseline.has("gone")).toBe(false);
    expect(baseline.size).toBe(1);
  });
});
