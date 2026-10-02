import type { BackendRpcEvent } from "@pace/backend";
import { describe, expect, it, vi } from "vitest";
import { backendRelay } from "./backend-relay";

function envelope(type: string, payload: Record<string, unknown>): BackendRpcEvent {
  return { type: "event", event: { id: "evt-1", seq: 0, sessionId: "", piSessionId: "", type, ts: "2026-10-02T00:00:00Z", payload } };
}

describe("backendRelay", () => {
  it("maps relay calls to backend commands", async () => {
    const invoke = vi.fn(async () => null) as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    const relay = backendRelay({ invoke, onBackendEvent: () => () => {} });

    await relay.connect("c1");
    relay.send("c1", "frame");
    relay.disconnect("c1");

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["durable_spike_connect", { connectionId: "c1" }],
      ["durable_spike_send", { connectionId: "c1", data: "frame" }],
      ["durable_spike_disconnect", { connectionId: "c1" }],
    ]);
  });

  it("passes on frames and closes from backend events and drops everything else", () => {
    let emit: (event: BackendRpcEvent) => void = () => {};
    const relay = backendRelay({
      invoke: vi.fn() as never,
      onBackendEvent: (listener) => {
        emit = listener;
        return () => {};
      },
    });
    const received: unknown[] = [];
    relay.subscribe((event) => received.push(event));

    emit(envelope("durable_spike.frame", { connectionId: "c1", data: "{}" }));
    emit(envelope("terminal_output", { terminalId: "t", data: "x" }));
    emit(envelope("durable_spike.frame", { data: "no connection id" }));
    emit(envelope("durable_spike.closed", { connectionId: "c1", code: 4401, reason: "unauthorized" }));
    emit(envelope("durable_spike.closed", { connectionId: "c2", code: 1006 }));

    expect(received).toEqual([
      { kind: "frame", connectionId: "c1", data: "{}" },
      { kind: "closed", connectionId: "c1", code: 4401, reason: "unauthorized" },
      { kind: "closed", connectionId: "c2", code: 1006 },
    ]);
  });
});
