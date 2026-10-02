import { describe, expect, it } from "vitest";
import type { RemoteDurable } from "../protocol/remote-durable.ts";
import { streamingText, transcript } from "../protocol/transcript.ts";
import { connectTo, LONG_ANSWER, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

describe("gateway", () => {
  it("shows one streamed answer to two clients, driven by either", async () => {
    const host = await startFauxHost(defer);
    const a = await connectTo(defer, host);
    const b = await connectTo(defer, host);
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
    const host = await startFauxHost(defer);
    await expect(connectTo(defer, host, "not-the-token")).rejects.toThrow(/unauthorized/i);
  });

  it("lists the same conversation titles before and after the host restarts", async () => {
    const first = await startFauxHost(defer, { answers: ["done"] });
    const before = await connectTo(defer, first);
    await before.controller.submit("what broke v2.3?", "followUp");
    await waitForView(before.view, (view) => view.conversations[0]?.title === "what broke v2.3?");
    const dataDir = before.view.current().session.directory;
    before.close();
    await first.close();

    const second = await startFauxHost(defer, { dataDir });
    const after = await connectTo(defer, second);
    expect(after.view.current().conversations).toEqual(before.view.current().conversations);
    expect(after.view.current().conversations).toMatchObject([{ label: "main", title: "what broke v2.3?" }]);
  });

  it("lists the conversations and opens the task graph on request", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const rootId = client.view.current().conversation.conversation.id;
    expect(client.view.current().conversations.map((summary) => summary.id)).toEqual([rootId]);

    expect(client.view.current().tasks).toBeUndefined();
    await client.controller.toggleTasks();
    await waitForView(client.view, (view) => view.tasks !== undefined);
    await client.controller.toggleTasks();
    expect(client.view.current().tasks).toBeUndefined();
  });
});
