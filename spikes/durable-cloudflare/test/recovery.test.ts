import { Response as WorkerResponse } from "miniflare";
import { expect, it } from "vitest";
import { startRuntime } from "./runtime.ts";

interface WitnessEvent {
  kind: "alarm" | "alarm-complete" | "tool" | "completed";
  bootId: string;
  operationId: string;
  attempt?: number;
}

function witness() {
  const events: WitnessEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    events,
    async fetch(request: Request) {
      const event = await request.json() as WitnessEvent;
      if (event.kind === "tool") {
        event.attempt = events.filter((item) => item.kind === "tool" && item.operationId === event.operationId).length + 1;
      }
      events.push(event);
      for (const listener of listeners) listener();
      return WorkerResponse.json({ attempt: event.attempt });
    },
    waitFor(predicate: (event: WitnessEvent) => boolean, timeoutMs = 50_000): Promise<WitnessEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Witness event missing: ${JSON.stringify(events)}`));
        }, timeoutMs);
        function check() {
          const event = events.find(predicate);
          if (!event) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(event);
        }
        listeners.add(check);
        check();
      });
    },
  };
}

it.concurrent("recovers a safe tool through the SDK alarm without a client waking the object", async () => {
  const observed = witness();
  const mf = await startRuntime("test/recovery-worker.ts", {
    serviceBindings: { WITNESS: observed.fetch },
  });
  try {
    const operationId = "safe-recovery";
    const submit = await mf.dispatchFetch("http://spike/safe/submit", {
      method: "POST",
      body: JSON.stringify({ operationId, replay: "safe" }),
    });
    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({ operationId, accepted: true });
    const first = await observed.waitFor((event) => event.kind === "tool" && event.attempt === 1);

    // ctx.abort terminates the live object. Only its alarm can wake it from here.
    await mf.dispatchFetch("http://spike/safe/crash", { method: "POST" }).catch(() => undefined);
    const recovered = await observed.waitFor((event) => event.kind === "tool" && event.attempt === 2);
    expect(recovered.bootId).not.toBe(first.bootId);
    const alarm = observed.events.find((event) => event.kind === "alarm" && event.bootId === recovered.bootId);
    expect(alarm).toBeDefined();
    expect(observed.events.indexOf(alarm!)).toBeLessThan(observed.events.indexOf(recovered));
    await observed.waitFor((event) => event.kind === "completed" && event.bootId === recovered.bootId, 10_000);

    const response = await mf.dispatchFetch("http://spike/safe/result");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operationId,
      status: "done",
      text: "Recovered safely.",
      userEntries: 1,
      toolErrors: [],
    });
    expect(observed.events.filter((event) => event.kind === "tool")).toHaveLength(2);
  } finally {
    await mf.dispose();
  }
}, 70_000);

it.concurrent("reports an interrupted unsafe tool without executing it twice", async () => {
  const observed = witness();
  const mf = await startRuntime("test/recovery-worker.ts", {
    serviceBindings: { WITNESS: observed.fetch },
  });
  try {
    const operationId = "unsafe-recovery";
    const submit = await mf.dispatchFetch("http://spike/unsafe/submit", {
      method: "POST",
      body: JSON.stringify({ operationId, replay: "unsafe" }),
    });
    expect(submit.status).toBe(202);
    const first = await observed.waitFor((event) => event.kind === "tool" && event.attempt === 1);

    await mf.dispatchFetch("http://spike/unsafe/crash", { method: "POST" }).catch(() => undefined);
    // Observe the settled operation before any request can participate in its recovery.
    const recovered = await observed.waitFor((event) => event.kind === "completed" && event.bootId !== first.bootId);
    expect(observed.events.find((event) => event.kind === "alarm" && event.bootId === recovered.bootId)).toBeDefined();

    const response = await mf.dispatchFetch("http://spike/unsafe/result");
    expect(response.status).toBe(200);
    const result = await response.json() as { operationId: string; status: string; text: string; userEntries: number; toolErrors: unknown[] };
    expect(result).toMatchObject({
      operationId,
      status: "done",
      text: "Interrupted tool was not replayed.",
      userEntries: 1,
    });
    expect(result.toolErrors).toHaveLength(1);
    expect(JSON.stringify(result.toolErrors)).toContain("was interrupted and may have partially run");
    expect(observed.events.filter((event) => event.kind === "tool")).toHaveLength(1);
  } finally {
    await mf.dispose();
  }
}, 70_000);
