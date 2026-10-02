import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy, streamingText, transcript } from "../protocol/transcript.ts";
import { connectTo, LONG_ANSWER, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const inboxOf = (view: { conversation: { docs: Record<string, unknown> } }) =>
  ((view.conversation.docs["pi.inbox"] ?? { items: [] }) as { items: { mode: string }[] }).items;

describe("remote controller", () => {
  it("steers a busy conversation from another client; both see the queue and the steered turn", async () => {
    const host = await startFauxHost(defer, { answers: [LONG_ANSWER, "steered"], tokensPerSecond: 60 });
    const driver = await connectTo(defer, host);
    const steerer = await connectTo(defer, host);

    await driver.controller.submit("investigate", "followUp");
    await waitForView(steerer.view, (view) => isBusy(view.conversation));
    await steerer.controller.submit("focus on the logs", "steer");
    await waitForView(driver.view, (view) => inboxOf(view).some((item) => item.mode === "steer"));

    await waitForView(driver.view, (view) => !isBusy(view.conversation) && transcript(view.conversation).at(-1)?.text === "steered");
    expect(transcript(driver.view.current().conversation).map((line) => line.text)).toEqual([
      "investigate",
      LONG_ANSWER,
      "focus on the logs",
      "steered",
    ]);
  });

  it("aborts a streaming answer; the partial stays as an aborted entry", async () => {
    const host = await startFauxHost(defer, { tokensPerSecond: 40 });
    const client = await connectTo(defer, host);

    await client.controller.submit("investigate", "followUp");
    await waitForView(client.view, (view) => (streamingText(view.conversation)?.length ?? 0) > 10);
    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation));

    const [user, answer, ...rest] = transcript(client.view.current().conversation);
    expect(user).toEqual({ role: "user", text: "investigate" });
    expect(answer).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(rest).toEqual([]);
  });

  it("switches to another conversation and talks to it; the other client stays on main", async () => {
    const host = await startFauxHost(defer, { answers: ["from the other conversation"] });
    const switcher = await connectTo(defer, host);
    const bystander = await connectTo(defer, host);
    const rootId = switcher.view.current().conversation.conversation.id;
    // An ownerless conversation starts with an empty agent; a subagent's would copy its parent's.
    const { model } = (await host.harness.snapshot(AgentDoc, rootId, BACKGROUND_CONTEXT))!;
    const other = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model! } }, BACKGROUND_CONTEXT);

    await waitForView(switcher.view, (view) => view.conversations.some((summary) => summary.id === other.id));
    await switcher.controller.switchConversation(other.id);
    expect(switcher.view.current().conversation.conversation.id).toBe(other.id);

    await switcher.controller.submit("hello other", "followUp");
    await waitForView(switcher.view, (view) => transcript(view.conversation).at(-1)?.text === "from the other conversation");
    expect(bystander.view.current().conversation.conversation.id).toBe(rootId);
    expect(transcript(bystander.view.current().conversation)).toEqual([]);
  });

  it("reports a switch to an unknown conversation and keeps the current one", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const rootId = client.view.current().conversation.conversation.id;

    await client.controller.switchConversation(999 as ConversationId);

    expect(client.view.current().conversation.conversation.id).toBe(rootId);
    expect(client.view.current().notices.at(-1)).toMatchObject({ level: "error", message: expect.stringMatching(/999/) });
  });
});
