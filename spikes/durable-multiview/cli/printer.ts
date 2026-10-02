import type { ConversationView } from "@earendil-works/pi-durable";
import { streamingText, transcript, type TranscriptLine } from "../protocol/transcript.ts";

/** What is already on the terminal: finished lines, and a partial left open on the last line. */
export interface PrinterState {
  readonly printed: readonly TranscriptLine[];
  readonly streamed: string | undefined;
}

export const initialPrinter: PrinterState = { printed: [], streamed: undefined };

const sameLine = (a: TranscriptLine, b: TranscriptLine): boolean => JSON.stringify(a) === JSON.stringify(b);

const suffixOf = (line: TranscriptLine): string =>
  line.role === "assistant" && line.stopReason !== "stop" ? ` [${line.stopReason}]` : "";

const format = (line: TranscriptLine): string => `${line.role}: ${line.text}${suffixOf(line)}`;

/** Append-only terminal output for the next view; a view that rewrites printed history is printed afresh. */
export function printIncrement(state: PrinterState, view: ConversationView): { state: PrinterState; output: string } {
  const lines = transcript(view);
  let { printed, streamed } = state;
  let output = "";

  if (printed.length > lines.length || printed.some((line, i) => !sameLine(line, lines[i]!))) {
    output += `${streamed === undefined ? "" : "\n"}--- view replaced ---\n`;
    printed = [];
    streamed = undefined;
  }

  for (const line of lines.slice(printed.length)) {
    if (streamed === undefined) output += `${format(line)}\n`;
    else if (line.role === "assistant" && line.text.startsWith(streamed)) output += `${line.text.slice(streamed.length)}${suffixOf(line)}\n`;
    else output += `\n${format(line)}\n`;
    streamed = undefined;
  }
  printed = lines;

  const partial = streamingText(view);
  if (partial !== undefined && partial !== "") {
    if (streamed === undefined) output += `assistant: ${partial}`;
    else if (partial.startsWith(streamed)) output += partial.slice(streamed.length);
    else output += `\nassistant: ${partial}`;
    streamed = partial;
  }
  return { state: { printed, streamed }, output };
}
