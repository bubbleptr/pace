import type { ConversationId, ConversationView, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { approvalText, chatItems, planItems, queueItems, statusText, taskRows, usageRows } from "../presentation/chat.ts";

let nextId = 1;
const entry = (kind: string, message: unknown): EntryRecord =>
  ({ id: nextId++, conversationId: 0, kind, model: [message] }) as unknown as EntryRecord;
const user = (text: string) => entry("pi.user", { role: "user", content: text });
const assistant = (content: unknown[], stopReason = "stop") => entry("pi.assistant", { role: "assistant", content, stopReason });
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const result = (callId: string, name: string, output: string, isError = false) =>
  entry("pi.tool-result", { role: "toolResult", toolCallId: callId, toolName: name, content: [text(output)], isError });
const view = (entries: EntryRecord[], live: object = {}, inbox: object[] = []): ConversationView =>
  ({ conversation: { id: 0 }, entries, docs: { "pi.live": live, "pi.inbox": { items: inbox } } }) as unknown as ConversationView;

describe("chatItems", () => {
  it("maps user and assistant entries, marking an interrupted partial", () => {
    const items = chatItems(view([user("hi"), assistant([text("hel")], "aborted"), assistant([text("hello")])]));
    expect(items.map((item) => [item.kind, "text" in item ? item.text : undefined, "stopReason" in item ? item.stopReason : undefined])).toEqual([
      ["user", "hi", undefined],
      ["assistant", "hel", "aborted"],
      ["assistant", "hello", "stop"],
    ]);
  });

  it("appends the in-flight partial as a streaming assistant item", () => {
    const items = chatItems(view([user("hi")], { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [text("he")] } } }));
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: "he", streaming: true });
  });

  it("attaches tool results and live tool progress to the calls of their answer", () => {
    const items = chatItems(
      view(
        [user("go"), assistant([call("c1", "logs", { service: "api" }), call("c2", "metrics", {})], "toolUse"), result("c1", "logs", "3 errors")],
        { run: {}, tools: [{ callId: "c2", name: "metrics", status: "running", output: "fetching", details: { conversationId: 7 } }] },
      ),
    );
    const answer = items.at(-1);
    expect(answer).toMatchObject({
      kind: "assistant",
      tools: [
        { callId: "c1", name: "logs", status: "complete", output: "3 errors" },
        { callId: "c2", name: "metrics", status: "running", output: "fetching", conversationId: 7 },
      ],
    });
  });

  it("marks the calls of an interrupted answer as not run", () => {
    const items = chatItems(view([user("go"), assistant([call("c1", "logs", {})], "aborted")]));
    expect(items.at(-1)).toMatchObject({ tools: [{ callId: "c1", status: "error", output: "Not run: the answer was interrupted." }] });
  });

  it("shows compaction summaries and context resets", () => {
    const compaction = entry("pi.compaction", { role: "user", content: "summary of earlier work" });
    const reset = { id: nextId++, conversationId: 0, kind: "pi.reset" } as unknown as EntryRecord;
    expect(chatItems(view([compaction, reset])).map((item) => item.kind)).toEqual(["compaction", "reset"]);
  });
});

describe("statusText", () => {
  it("names what the conversation is doing, most specific first", () => {
    expect(statusText(view([]))).toBe("");
    expect(statusText(view([], { run: {} }))).toBe("Working...");
    expect(statusText(view([], { run: {}, tools: [{ callId: "c", name: "logs", status: "running" }] }))).toBe("Running logs...");
    expect(statusText(view([], { run: {}, generation: { attempt: 1, retry: { at: 0, error: "overloaded" } } }))).toBe(
      "Retrying (attempt 2): overloaded",
    );
    expect(statusText(view([], { compactions: [{ reason: "manual", attempt: 1 }] }))).toBe("Compacting (manual)...");
  });
});

describe("queueItems", () => {
  it("lists queued inputs with their mode", () => {
    expect(queueItems(view([], {}, [{ id: 1, mode: "steer", content: "focus" }, { id: 2, mode: "followUp", content: [text("then this")] }]))).toEqual([
      { id: 1, mode: "steer", text: "focus" },
      { id: 2, mode: "followUp", text: "then this" },
    ]);
  });
});

describe("taskRows", () => {
  it("nests owned tasks and conversation-owned tasks under their owner", () => {
    const graph = {
      tasks: {
        "1": { id: 1, kind: "pi.generation", conversationId: 0, background: false, abortRequested: false, state: { status: "waiting", phase: "tools", on: [2], policy: "all" }, conversations: [] },
        "2": { id: 2, kind: "pi.tool", conversationId: 0, owner: 1, background: false, abortRequested: false, state: { status: "running", phase: "run" }, conversations: [5] },
        "3": { id: 3, kind: "pi.generation", conversationId: 5, background: false, abortRequested: true, state: { status: "running", phase: "request" }, conversations: [] },
      },
    } as unknown as TaskGraph;
    expect(taskRows(graph)).toEqual([
      { id: 1, depth: 0, label: "pi.generation #1: waiting on 2" },
      { id: 2, depth: 1, label: "pi.tool #2: running run owns conversation 5" },
      { id: 3, depth: 2, label: "pi.generation #3: running request [aborting]" },
    ]);
  });
});

describe("demo presentation", () => {
  it("keeps an answer's thinking apart from its text, also while streaming", () => {
    const thinking = (value: string) => ({ type: "thinking", thinking: value });
    expect(chatItems(view([assistant([thinking("pool sizes?"), text("rollback")])])).at(-1)).toMatchObject({ text: "rollback", thinking: "pool sizes?" });
    expect(chatItems(view([assistant([text("plain")])])).at(-1)).not.toHaveProperty("thinking");
    const live = { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [thinking("che")] } } };
    expect(chatItems(view([], live)).at(-1)).toMatchObject({ text: "", thinking: "che", streaming: true });
  });

  it("reads the plan, empty until the agent writes one", () => {
    expect(planItems({})).toEqual([]);
    expect(planItems({ "demo.plan": null })).toEqual([]);
    expect(planItems({ "demo.plan": { items: [{ text: "Search the deploy logs", status: "done" }] } })).toEqual([
      { text: "Search the deploy logs", status: "done" },
    ]);
  });

  it("sums usage per model and tool", () => {
    const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } });
    const conversation = { ...view([]), docs: { "pi.usage": { models: { "faux/faux-1": usage(120, 30, 0.002) }, tools: { search_logs: usage(0, 0, 0) } } } };
    expect(usageRows(conversation as unknown as ConversationView)).toEqual([
      { key: "faux/faux-1", input: 120, output: 30, cost: 0.002 },
      { key: "search_logs", input: 0, output: 0, cost: 0 },
    ]);
    expect(usageRows(view([]))).toEqual([]);
  });

  it("says where an approval is waiting", () => {
    const approval = { id: "76", conversationId: 4 as ConversationId, tool: "rollback", summary: "Roll back to v2.2: pool regression", requestedAt: 0 };
    expect(approvalText(approval, [{ id: 4 as ConversationId, label: "fork 4" }])).toBe("fork 4: Roll back to v2.2: pool regression");
    expect(approvalText(approval, [])).toBe("conversation 4: Roll back to v2.2: pool regression");
  });
});
