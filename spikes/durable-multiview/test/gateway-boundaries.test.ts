import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { PlanDoc } from "../host/demo/state.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type GatewayOptions } from "../host/gateway.ts";
import type { ServerFrame } from "../protocol/frames.ts";
import { startDemoHost, startFauxHost, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();
const spikeDir = fileURLToPath(new URL("..", import.meta.url));

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function socketTo(url: string, token: string, origin?: string) {
  const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`, origin === undefined ? {} : { origin });
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

async function fixture(options: Partial<GatewayOptions> = {}) {
  const host = await startFauxHost(defer);
  const gateway = await startGateway({
    harness: host.harness,
    token: host.token,
    models: createModels(),
    modelSummaries: () => [],
    session: { id: "boundary-test", directory: "", cwd: "" },
    port: 0,
    ...options,
  });
  defer(() => gateway.close());
  return { host, gateway };
}

describe("gateway boundaries", () => {
  it.each([false, true])("keeps the latest subscription when an earlier acquisition settles late (failure: %s)", async (fails) => {
    const { host, gateway } = await fixture();
    const acquire = barrier();
    const release = barrier();
    const finished = barrier();
    const original = host.harness.watchTaskGraph.bind(host.harness);
    const watch = vi.spyOn(host.harness, "watchTaskGraph").mockImplementationOnce(async (context) => {
      const first = await original(context);
      const start = first.start.bind(first);
      const stop = first.stop.bind(first);
      vi.spyOn(first, "start").mockImplementation((listener) => { start(listener); finished.resolve(); });
      vi.spyOn(first, "stop").mockImplementation(async () => { const result = await stop(); finished.resolve(); return result; });
      acquire.resolve();
      await release.promise;
      if (fails) {
        await first.stop();
        throw new Error("obsolete acquisition failed");
      }
      return first;
    });
    defer(() => watch.mockRestore());
    const client = await socketTo(gateway.url, host.token);
    const subscribe = () => client.socket.send(JSON.stringify({ type: "subscribe", stream: "tasks" }));
    subscribe();
    await acquire.promise;
    subscribe();
    while (!client.frames.some((frame) => frame.type === "snapshot" && frame.stream === "tasks")) await once(client.socket, "message");
    release.resolve();
    await finished.promise;
    client.socket.send(JSON.stringify({ type: "subscribe", stream: "conversations" }));
    while (!client.frames.some((frame) => frame.type === "snapshot" && frame.stream === "conversations")) await once(client.socket, "message");
    expect(client.frames.filter((frame) => frame.type === "snapshot" && frame.stream === "tasks")).toHaveLength(1);
    expect(client.frames.filter((frame) => frame.type === "ended" && frame.stream === "tasks")).toEqual([]);
  });

  it("drops an in-flight watch when the client unsubscribes", async () => {
    const { host, gateway } = await fixture();
    const acquire = barrier();
    const release = barrier();
    const stopped = barrier();
    const original = host.harness.watchTaskGraph.bind(host.harness);
    const watch = vi.spyOn(host.harness, "watchTaskGraph").mockImplementationOnce(async (context) => {
      const pending = await original(context);
      const stop = pending.stop.bind(pending);
      vi.spyOn(pending, "stop").mockImplementation(async () => {
        const result = await stop();
        stopped.resolve();
        return result;
      });
      acquire.resolve();
      await release.promise;
      return pending;
    });
    defer(() => watch.mockRestore());
    const client = await socketTo(gateway.url, host.token);
    client.socket.send(JSON.stringify({ type: "subscribe", stream: "tasks" }));
    await acquire.promise;
    client.socket.send(JSON.stringify({ type: "unsubscribe", stream: "tasks" }));
    client.socket.send(JSON.stringify({ type: "subscribe", stream: "conversations" }));
    while (!client.frames.some((frame) => frame.type === "snapshot" && frame.stream === "conversations")) await once(client.socket, "message");
    release.resolve();
    await stopped.promise;
    client.socket.send(JSON.stringify({ type: "subscribe", stream: "approvals" }));
    while (!client.frames.some((frame) => frame.type === "snapshot" && frame.stream === "approvals")) await once(client.socket, "message");
    expect(client.frames.filter((frame) => "stream" in frame && frame.stream === "tasks")).toEqual([]);
  });

  it("streams a document created while its initial absence is being read", async () => {
    const { host } = await startDemoHost(defer);
    const absent = barrier();
    const release = barrier();
    const original = host.harness.watchDoc.bind(host.harness);
    const watch = vi.spyOn(host.harness, "watchDoc").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      expect(result).toBeUndefined();
      absent.resolve();
      await release.promise;
      return result;
    });
    defer(() => watch.mockRestore());
    const client = await socketTo(host.url, host.token);
    const stream = `doc:demo.plan:${ROOT_CONVERSATION_ID}`;
    client.socket.send(JSON.stringify({ type: "subscribe", stream }));
    await absent.promise;
    await host.harness.commit(async (tx) => {
      (await tx.doc(PlanDoc, ROOT_CONVERSATION_ID)).items = [{ text: "Investigate release", status: "doing" }];
    }, BACKGROUND_CONTEXT);
    release.resolve();
    const received = barrier();
    const check = () => {
      if (client.frames.some((frame) => frame.type === "snapshot" && frame.stream === stream && frame.value !== null)) received.resolve();
    };
    client.socket.on("message", check);
    defer(() => { client.socket.off("message", check); });
    // The timeout is only a failure bound; the commit/acquisition barrier triggers the race.
    await Promise.race([received.promise, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("created document never arrived")), 1000))]);
    expect(client.frames.findLast((frame) => frame.type === "snapshot" && frame.stream === stream)).toMatchObject({
      value: { items: [{ text: "Investigate release", status: "doing" }] },
    });
  });

  it("rejects an untrusted browser even when it has the token", async () => {
    const { host, gateway } = await fixture();
    const { socket, frames } = await socketTo(gateway.url, host.token, "https://untrusted.example");
    const result = await Promise.race([
      once(socket, "close").then(([code]) => code),
      once(socket, "message").then(() => "accepted"),
    ]);
    expect(result).toBe(4401);
    expect(frames).toEqual([]);
  });

  it("admits only the configured browser origin while retaining native access", async () => {
    const origin = "http://127.0.0.1:5199";
    const { host, gateway } = await fixture({ browserOrigins: [origin] });
    for (const [candidate, accepted] of [[undefined, true], [origin, true], ["http://127.0.0.1:5200", false], ["null", false]] as const) {
      const { socket, frames } = await socketTo(gateway.url, host.token, candidate);
      const result = frames.length > 0 ? "hello" : await Promise.race([
        once(socket, "message").then(() => "hello"),
        once(socket, "close").then(([code]) => code),
      ]);
      expect(result).toBe(accepted ? "hello" : 4401);
    }
  });

  it("closes malformed clients while keeping the host available", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const child = spawn(process.execPath, ["host/main.ts", "--data-dir", dir.path, "--cwd", dir.path, "--port", "0", "--faux", "done"], {
      cwd: spikeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await once(child, "exit");
    });
    const lines = createInterface({ input: child.stdout! });
    let url: string | undefined;
    for await (const line of lines) {
      const ready = JSON.parse(line) as { event: string; url: string };
      if (ready.event === "ready") {
        url = ready.url;
        break;
      }
    }
    expect(url).toBeDefined();
    const token = (await readFile(join(dir.path, "token"), "utf8")).trim();
    for (const malformed of ["{", "null", '{"type":"subscribe","stream":null}', '{"type":"call","id":1,"method":"submit","args":{}}']) {
      const { socket } = await socketTo(url!, token);
      const closed = once(socket, "close");
      socket.send(malformed);
      expect((await closed)[0]).toBe(1008);
      expect(child.exitCode).toBeNull();
    }
    const healthy = await socketTo(url!, token);
    healthy.socket.send(JSON.stringify({ type: "subscribe", stream: "conversations" }));
    while (!healthy.frames.some((frame) => frame.type === "snapshot")) await once(healthy.socket, "message");
    expect(healthy.frames.some((frame) => frame.type === "snapshot")).toBe(true);
  });
});
