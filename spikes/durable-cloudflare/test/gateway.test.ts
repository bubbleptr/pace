import type { Miniflare } from "miniflare";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startRuntime } from "./runtime.ts";

let runtime: Miniflare;
const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
beforeAll(async () => { runtime = await startRuntime("src/worker.ts"); });
afterAll(async () => { await runtime?.dispose(); });

it("submits a turn once and lets another client retrieve the same result", async () => {
  const submit = () => runtime.dispatchFetch("http://spike/sessions/shared/submit", {
    method: "POST", headers, body: JSON.stringify({ input: "hello", operationId: "turn-1" }),
  });
  const first = await submit();
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ operationId: "turn-1", session: "1", accepted: true });
  const retry = await submit();
  expect(await retry.json()).toMatchObject({ operationId: "turn-1", accepted: false });
  const result = await runtime.dispatchFetch("http://spike/sessions/shared/operations/turn-1", { headers });
  expect(await result.json()).toMatchObject({ status: "done", text: "Faux: hello" });
  const state = await runtime.dispatchFetch("http://spike/sessions/shared", { headers });
  const snapshot = await state.json() as { messages: { kind: string }[] };
  expect(snapshot.messages.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
});

it("rejects untrusted commands before they can mutate a conversation", async () => {
  const endpoint = "http://spike/sessions/protected/submit";
  for (const authorization of ["", "Bearer wrong"]) {
    const response = await runtime.dispatchFetch(endpoint, {
      method: "POST", headers: { ...headers, authorization },
      body: JSON.stringify({ input: "unauthorized", operationId: "bad" }),
    });
    expect(response.status).toBe(401);
  }
  for (const body of ["{", "null", JSON.stringify({ input: 42, operationId: "bad" }), JSON.stringify({ input: "missing id" })]) {
    const response = await runtime.dispatchFetch(endpoint, { method: "POST", headers, body });
    expect(response.status).toBe(400);
  }
  const state = await runtime.dispatchFetch("http://spike/sessions/protected", { headers });
  expect(await state.json()).toMatchObject({ messages: [], pending: [] });
});

it("streams committed events to two observers and reconnects with a fresh snapshot", async () => {
  const open = async () => {
    const response = await runtime.dispatchFetch("http://spike/sessions/observed/events", { headers });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Missing event stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    return {
      close: () => reader.cancel(),
      async frame(): Promise<AgentEvent[]> {
        while (!pending.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Stream ended before a frame arrived");
          pending += decoder.decode(chunk.value, { stream: true });
        }
        const newline = pending.indexOf("\n");
        const frame = JSON.parse(pending.slice(0, newline)) as AgentEvent[];
        pending = pending.slice(newline + 1);
        return frame;
      },
    };
  };
  const first = await open();
  const second = await open();
  try {
    expect(await first.frame()).toMatchObject([{ type: "snapshot", entries: [] }]);
    expect(await second.frame()).toMatchObject([{ type: "snapshot", entries: [] }]);
    const observe = async (client: typeof first) => {
      const received: AgentEvent[] = [];
      while (!received.some((event) => event.type === "run_end")) received.push(...await client.frame());
      return received.filter((event) => event.type === "message_end").map((event) => event.entry);
    };
    const observed = Promise.all([observe(first), observe(second)]);
    await runtime.dispatchFetch("http://spike/sessions/observed/submit", {
      method: "POST", headers, body: JSON.stringify({ input: "two observers", operationId: "broadcast" }),
    });
    const [left, right] = await observed;
    expect(left).toEqual(right);
    expect(left.some((entry) => entry.kind === "pi.assistant")).toBe(true);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  const reconnected = await open();
  try {
    const [snapshot] = await reconnected.frame();
    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
    expect(snapshot.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    expect(snapshot.entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
    await runtime.dispatchFetch("http://spike/sessions/observed/submit", {
      method: "POST", headers, body: JSON.stringify({ input: "keep running ".repeat(80), operationId: "detached" }),
    });
    let started = false;
    while (!started) started = (await reconnected.frame()).some((event) => event.type === "run_start");
  } finally {
    await reconnected.close();
  }
  const detached = await runtime.dispatchFetch("http://spike/sessions/observed/operations/detached", { headers });
  expect(await detached.json()).toMatchObject({ status: "done" });
});

it("preserves a completed conversation and its operation ID across runtime replacement", async () => {
  const persist = await mkdtemp(join(tmpdir(), "pace-cf-"));
  let mf: Miniflare | undefined;
  try {
    mf = await startRuntime("src/worker.ts", { persist });
    const endpoint = "http://spike/sessions/persistent";
    const submit = { method: "POST", headers, body: JSON.stringify({ input: "persist me", operationId: "persisted" }) };
    await mf.dispatchFetch(`${endpoint}/submit`, submit);
    const result = await mf.dispatchFetch(`${endpoint}/operations/persisted`, { headers });
    expect(await result.json()).toMatchObject({ status: "done" });
    const before = await (await mf.dispatchFetch(endpoint, { headers })).json() as { instanceId: string; messages: unknown[] };
    await mf.dispose();
    mf = await startRuntime("src/worker.ts", { persist });
    const after = await (await mf.dispatchFetch(endpoint, { headers })).json() as typeof before;
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.messages).toEqual(before.messages);
    expect(await (await mf.dispatchFetch(`${endpoint}/submit`, submit)).json()).toMatchObject({ accepted: false });
    const other = await mf.dispatchFetch("http://spike/sessions/another", { headers });
    expect(await other.json()).toMatchObject({ messages: [], pending: [] });
  } finally {
    await mf?.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
