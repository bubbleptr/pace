import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Pace's backend relay, the hop between a host and Pace's renderer.
import { createDurableSpikeBridge, type DurableSpikeBridge } from "../../../packages/backend/src/spikes/durable-bridge.ts";
import { connectRemoteDurable, type RemoteDurable } from "../protocol/remote-durable.ts";
import { transcript } from "../protocol/transcript.ts";
import { type FrameRelay, relayTransport } from "../protocol/transport.ts";
import { connectTo, freePort, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

/** An agent dir holding a host token where the bridge looks for it. */
async function agentDirWithToken(token: string): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  const tokenDir = join(dir.path, "experimental", "durable-multiview", "default");
  await mkdir(tokenDir, { recursive: true });
  await writeFile(join(tokenDir, "token"), `${token}\n`);
  return dir.path;
}

function relayOf(bridge: DurableSpikeBridge, url: string): FrameRelay {
  return {
    connect: (connectionId) => bridge.connect({ connectionId, url }),
    send: (connectionId, data) => bridge.send({ connectionId, data }),
    disconnect: (connectionId) => bridge.disconnect({ connectionId }),
    subscribe: (listener) => bridge.onEvent(listener),
  };
}

async function connectThroughBridge(bridge: DurableSpikeBridge, url: string): Promise<RemoteDurable> {
  const client = await connectRemoteDurable({ transport: relayTransport(relayOf(bridge, url), "pace"), reconnectDelayMs: { min: 100, max: 500 } });
  defer(() => client.close());
  return client;
}

describe("Pace backend relay", () => {
  it("carries a client that sees and drives the same conversation as a direct one", async () => {
    const host = await startFauxHost(defer, { answers: ["answer-through-the-relay"] });
    const bridge = createDurableSpikeBridge({ agentDir: await agentDirWithToken(host.token) });
    defer(() => bridge.dispose());
    const relayed = await connectThroughBridge(bridge, host.url);
    const direct = await connectTo(defer, host);

    await relayed.controller.submit("question-through-the-relay", "followUp");
    const answered = (client: RemoteDurable) =>
      waitForView(client.view, (view) => transcript(view.conversation).at(-1)?.text === "answer-through-the-relay");
    await Promise.all([answered(relayed), answered(direct)]);
    expect(relayed.view.current().conversation).toEqual(direct.view.current().conversation);
  });

  it("reconnects through the relay after the host restarts", async () => {
    const port = await freePort();
    const first = await startFauxHost(defer, { port });
    const bridge = createDurableSpikeBridge({ agentDir: await agentDirWithToken(first.token) });
    defer(() => bridge.dispose());
    const relayed = await connectThroughBridge(bridge, first.url);
    const dataDir = relayed.view.current().session.directory;

    await first.close();
    await waitForView(relayed.view, (view) => view.connection === "reconnecting");
    await startFauxHost(defer, { port, dataDir });
    await waitForView(relayed.view, (view) => view.connection === "connected");
  });

  it("connects to its configured default host when the client names none", async () => {
    const host = await startFauxHost(defer);
    const bridge = createDurableSpikeBridge({ agentDir: await agentDirWithToken(host.token), defaultUrl: host.url });
    defer(() => bridge.dispose());
    const relay: FrameRelay = { ...relayOf(bridge, host.url), connect: (connectionId) => bridge.connect({ connectionId }) };
    const client = await connectRemoteDurable({ transport: relayTransport(relay, "pace") });
    defer(() => client.close());
    expect(client.view.current().connection).toBe("connected");
  });

  it("says to start the host when there is no token yet", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const bridge = createDurableSpikeBridge({ agentDir: dir.path });
    defer(() => bridge.dispose());
    await expect(connectThroughBridge(bridge, "ws://127.0.0.1:7420")).rejects.toThrow(/no host token.*bun run host/i);
  });

  it("refuses a host that is not on this machine", async () => {
    const bridge = createDurableSpikeBridge({ agentDir: await agentDirWithToken("t") });
    defer(() => bridge.dispose());
    await expect(connectThroughBridge(bridge, "ws://example.com:7420")).rejects.toThrow(/loopback/i);
  });
});
