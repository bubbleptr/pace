import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { initialPrinter, printIncrement } from "../cli/printer.ts";

let nextEntry = 1;
const user = (text: string) =>
  ({ id: nextEntry++, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: text }] }) as unknown as EntryRecord;
const assistant = (text: string, stopReason = "stop") =>
  ({
    id: nextEntry++,
    conversationId: 0,
    kind: "pi.assistant",
    model: [{ role: "assistant", content: [{ type: "text", text }], stopReason }],
  }) as unknown as EntryRecord;
const view = (entries: EntryRecord[], partial?: string): ConversationView =>
  ({
    conversation: { id: 0 },
    entries,
    docs: partial === undefined ? {} : { "pi.live": { generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: partial }] } } } },
  }) as unknown as ConversationView;

function run(views: ConversationView[]): string {
  let state = initialPrinter;
  let out = "";
  for (const next of views) {
    const step = printIncrement(state, next);
    state = step.state;
    out += step.output;
  }
  return out;
}

describe("printIncrement", () => {
  it("streams a partial inline, then ends the line when the answer lands", () => {
    const u = user("hi");
    const a = assistant("hello there");
    expect(run([view([u]), view([u], "hel"), view([u], "hello th"), view([u, a])])).toBe("user: hi\nassistant: hello there\n");
  });

  it("marks an interrupted partial and prints the resent answer in full", () => {
    const u = user("hi");
    const out = run([view([u], "hel"), view([u, assistant("hel", "aborted")], "hello"), view([u, assistant("hel", "aborted"), assistant("hello")])]);
    expect(out).toBe("user: hi\nassistant: hel [aborted]\nassistant: hello\n");
  });

  it("reprints everything when the transcript is not an extension of what was printed", () => {
    const before = [user("one"), assistant("first")];
    const after = [user("two")];
    expect(run([view(before), view(after)])).toBe("user: one\nassistant: first\n--- view replaced ---\nuser: two\n");
  });
});
