import type { BackendRpcEvent } from "@pace/backend";
import { relayTransport } from "@pace/durable-spike/protocol/transport.ts";
import { describe, expect, it, vi } from "vitest";
import { backendRelay } from "./backend-relay";

function envelope(type: string, payload: Record<string, unknown>): BackendRpcEvent {
  return { type: "event", event: { id: "evt-1", seq: 0, sessionId: "", piSessionId: "", type, ts: "2026-10-02T00:00:00Z", payload } };
}

describe("backendRelay", () => {
  it("closes the old transport on backend exit and carries frames on a new connection", async () => {
    const listeners = new Set<(event: BackendRpcEvent) => void>();
    const emit = (event: BackendRpcEvent) => {
      for (const listener of listeners) listener(event);
    };
    const invoke = vi.fn(async () => null) as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    const transport = relayTransport(backendRelay({
      invoke,
      onBackendEvent: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    }), "pace");
    const closed = vi.fn();
    const first = transport.open({ message: vi.fn(), closed });
    const firstId = vi.mocked(invoke).mock.calls[0]![1]!.connectionId;

    const disconnected = envelope("error", { lifecycle: "disconnected", generation: 1 });
    disconnected.event.sessionId = "__backend__";
    emit(disconnected);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith(1006, expect.stringMatching(/backend/i));
    first.send("must-not-reach-the-old-connection");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "durable_spike_send")).toEqual([]);

    const message = vi.fn();
    const second = transport.open({ message, closed: vi.fn() });
    const calls = vi.mocked(invoke).mock.calls;
    const secondId = calls[calls.length - 1]![1]!.connectionId;
    expect(secondId).not.toBe(firstId);
    second.send("new-command");
    emit(envelope("durable_spike.frame", { connectionId: firstId, data: "stale" }));
    emit(envelope("durable_spike.frame", { connectionId: secondId, data: "new-reply" }));
    expect(invoke).toHaveBeenCalledWith("durable_spike_send", { connectionId: secondId, data: "new-command" });
    expect(message).toHaveBeenCalledExactlyOnceWith("new-reply");
    second.close();
  });

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

  it("closes the transport when a frame cannot reach the backend", async () => {
    const invoke = (async (command: string) => {
      if (command === "durable_spike_send") throw new Error("Backend is not connected");
      return null;
    }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    const transport = relayTransport(backendRelay({ invoke, onBackendEvent: () => () => {} }), "pace");
    const closed = vi.fn();
    const connection = transport.open({ message: vi.fn(), closed });
    connection.send("pending-command");
    await Promise.resolve();

    expect(closed).toHaveBeenCalledExactlyOnceWith(1006, "Backend is not connected");
    connection.close();
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
