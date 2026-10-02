import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

export type TranscriptLine =
  | { readonly role: "user"; readonly text: string }
  /** `aborted` marks a partial an interrupted attempt left behind; it stays in the transcript but out of model context. */
  | { readonly role: "assistant"; readonly text: string; readonly stopReason: string };

type ContentBlock = { readonly type: string; readonly text?: string };
type MessageLike = { readonly role: string; readonly content: string | readonly ContentBlock[]; readonly stopReason?: string };

function textOf(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

function lineOf(entry: EntryRecord): TranscriptLine | undefined {
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return undefined;
  const message = entry.model?.[0] as MessageLike | undefined;
  if (message === undefined) return undefined;
  if (entry.kind === "pi.user") return { role: "user", text: textOf(message) };
  return { role: "assistant", text: textOf(message), stopReason: message.stopReason ?? "stop" };
}

/** The user and assistant text of the active transcript, oldest first. */
export function transcript(view: ConversationView): TranscriptLine[] {
  return view.entries.flatMap((entry) => {
    const line = lineOf(entry);
    return line === undefined ? [] : [line];
  });
}

/** Text of the in-flight response, from the committed `pi.live` partial; absent when nothing streams. */
export function streamingText(view: ConversationView): string | undefined {
  const live = view.docs["pi.live"] as { generation?: { message?: MessageLike } } | undefined;
  const message = live?.generation?.message;
  return message === undefined ? undefined : textOf(message);
}

/** Whether the conversation has a run in flight. */
export function isBusy(view: ConversationView): boolean {
  const live = view.docs["pi.live"] as { run?: unknown } | undefined;
  return live?.run !== undefined;
}
