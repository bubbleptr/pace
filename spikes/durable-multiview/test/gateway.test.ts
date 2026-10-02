import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { openHost, type OpenedHost } from "../host/host.ts";
import { connectRemoteDurable, type RemoteDurable } from "../protocol/remote-durable.ts";
import { streamingText, transcript } from "../protocol/transcript.ts";
import { LONG_ANSWER, tempDir, waitForView } from "./support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startFauxHost(): Promise<OpenedHost> {
  const dir = await tempDir();
  cleanups.push(dir.remove);
  const faux = fauxProvider({ tokensPerSecond: 200 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(LONG_ANSWER)]);
  const model = faux.getModel();
  const host = await openHost({
    dataDir: dir.path,
    cwd: dir.path,
    models,
    modelSummaries: () => [{ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }],
    initialModel: { provider: model.provider, modelId: model.id },
    port: 0,
  });
  cleanups.push(() => host.close());
  return host;
}

async function connect(host: OpenedHost, token = host.token): Promise<RemoteDurable> {
  const client = await connectRemoteDurable({ url: host.url, token });
  cleanups.push(() => client.close());
  return client;
}

describe("gateway", () => {
  it("shows one streamed answer to two clients, driven by either", async () => {
    const host = await startFauxHost();
    const a = await connect(host);
    const b = await connect(host);
    expect(b.view.current().conversation.conversation.id).toBe(a.view.current().conversation.conversation.id);

    const partialsSeenByB: string[] = [];
    b.view.subscribe(() => {
      const text = streamingText(b.view.current().conversation);
      if (text !== undefined && text !== "") partialsSeenByB.push(text);
    });

    await a.controller.submit("investigate", "followUp");

    const answered = (client: RemoteDurable) =>
      waitForView(client.view, (view) => transcript(view.conversation).at(-1)?.text === LONG_ANSWER);
    await Promise.all([answered(a), answered(b)]);

    expect(transcript(b.view.current().conversation)).toEqual([
      { role: "user", text: "investigate" },
      { role: "assistant", text: LONG_ANSWER, stopReason: "stop" },
    ]);
    expect(b.view.current().conversation).toEqual(a.view.current().conversation);
    expect(partialsSeenByB.length).toBeGreaterThan(0);
    for (const partial of partialsSeenByB) expect(LONG_ANSWER.startsWith(partial)).toBe(true);
    expect(partialsSeenByB.some((partial) => partial.length < LONG_ANSWER.length)).toBe(true);
  });

  it("rejects a client with the wrong token", async () => {
    const host = await startFauxHost();
    await expect(connect(host, "not-the-token")).rejects.toThrow(/unauthorized/i);
  });

  it("lists the conversations and opens the task graph on request", async () => {
    const host = await startFauxHost();
    const client = await connect(host);
    const rootId = client.view.current().conversation.conversation.id;
    expect(client.view.current().conversations.map((summary) => summary.id)).toEqual([rootId]);

    expect(client.view.current().tasks).toBeUndefined();
    await client.controller.toggleTasks();
    await waitForView(client.view, (view) => view.tasks !== undefined);
    await client.controller.toggleTasks();
    expect(client.view.current().tasks).toBeUndefined();
  });
});
