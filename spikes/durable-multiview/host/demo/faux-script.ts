// A scripted stand-in for a real model that walks the on-call playbook. Requests of the main
// conversation and its parallel subagents arrive interleaved, so every answer is decided from
// the request itself: the tools it offers and the messages since the newest user input.
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AREAS } from "./oncall.ts";

const INVESTIGATION: readonly string[] = Object.values(AREAS).map((area) => area.tool);

function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** The tools a request offers, from its system messages' additions and removals. */
function offeredTools(messages: readonly Message[]): string[] {
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}

function summarizeResults(messages: readonly Message[]): string {
  const input = textOf(messages.findLast((message) => message.role === "user"));
  const history = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(input)?.[1] ?? "";
  // Keep the serialized result markers so another compaction can retain these same facts.
  const results = history.match(/(?:^|\n)\[Tool result\]: [\s\S]*?(?=\n\n\[(?:User|Assistant(?: thinking| tool calls)?|Tool result)\]:|\n<\/summary>|$)/g) ?? [];
  const excerpts = [...new Set(results.map((result) => result.trim()))];
  return excerpts.length === 0
    ? "No tool results were recorded in the summarized history."
    : `Recorded tool results:\n\n${excerpts.join("\n\n")}`;
}

const PLAN = ["Search the deploy logs", "Compare error metrics", "Review the commits in v2.3"];
/** Inputs that start something of their own; anything else arriving mid-run is a steer. */
const COMMANDS = [/^Reminder:/, /postmortem/i, /roll ?back/i, /check the (logs|metrics|commits) again/i, /check again in \d+ seconds?/i];

export function oncallScript({ reminderSeconds = 60 }: { reminderSeconds?: number } = {}): FauxResponseFactory {
  return (context, _options, state) => {
    const { messages } = context;
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1], index = 0) =>
      fauxToolCall(name, args, { id: `call-${state.callCount}-${index}` });
    const calls = (...blocks: ReturnType<typeof call>[]) => fauxAssistantMessage(blocks, { stopReason: "toolUse" });
    const tools = offeredTools(messages);
    // A summarization request offers no tools; its input quotes the selected history prefix.
    if (tools.length === 0) return fauxAssistantMessage(summarizeResults(messages));
    const userAt = messages.findLastIndex((message) => message.role === "user");
    const input = textOf(messages[userAt]);
    // A changed section, such as the plan after update_plan, lands as a system message after the results.
    const spoken = (message: Message) => message.role !== "system";
    let last = messages.slice(userAt + 1).findLast(spoken);

    // A subagent: one investigation tool, called once, then reported on.
    const own = tools.length === 1 && INVESTIGATION.includes(tools[0]!) ? tools[0]! : undefined;
    if (own !== undefined) {
      if (last?.role !== "toolResult") return calls(call(own, { query: input }));
      const first = textOf(last).split("\n").find((line) => /ERROR|->|pg driver/.test(line)) ?? textOf(last).split("\n")[0];
      return fauxAssistantMessage(`Found in ${own}: ${first}`);
    }

    const command = COMMANDS.some((pattern) => pattern.test(input));
    // A steer is placed after the tool round it interrupted: keep following that round.
    const before = messages.slice(0, userAt).findLast(spoken);
    if (last === undefined && !command && before?.role === "toolResult") last = before;

    if (last?.role === "toolResult") {
      if (last.isError) return fauxAssistantMessage(`${last.toolName} did not run: ${textOf(last)} Standing by.`);
      switch (last.toolName) {
        case "update_plan":
          if (messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
            return fauxAssistantMessage([
              fauxThinking("Logs show pool exhaustion in eu-west, metrics show saturated connections, and a1b2c3d changed the pool default. Same cause."),
              fauxText(
                "The pg driver bump in a1b2c3d cut the pool from 100 to 20; eu-west exhausted it at 09:14 and errors went to 14.8%. I recommend rolling back to v2.2.",
              ),
            ]);
          }
          return calls(
            call("subagent", { area: "logs", task: "find the errors around the v2.3 deploy in the logs" }, 0),
            call("subagent", { area: "metrics", task: "compare error metrics before and after v2.3" }, 1),
            call("subagent", { area: "commits", task: "review the commits in v2.3 for risky changes" }, 2),
          );
        case "subagent":
          return calls(call("update_plan", { items: PLAN.map((text) => ({ text, status: "done" })) }));
        case "rollback":
          return calls(call("schedule_check", { seconds: reminderSeconds, note: "verify the error rate after the rollback" }));
        case "schedule_check":
          return fauxAssistantMessage("Check scheduled; I will re-check when the reminder arrives.");
        default:
          return fauxAssistantMessage("Done.");
      }
    }

    if (input.startsWith("Reminder:")) return fauxAssistantMessage("Re-checked: the error rate is back to baseline (0.2%) in every region.");
    if (/postmortem/i.test(input)) {
      return fauxAssistantMessage([fauxText("Postmortem: v2.3 shipped a pg driver bump that shrank the connection pool; eu-west saturated first.")]);
    }
    if (/roll ?back/i.test(input)) return calls(call("rollback", { version: "v2.2", reason: "pg driver pool regression in v2.3" }));
    const again = /check the (logs|metrics|commits) again/i.exec(input);
    if (again !== null) return calls(call("subagent", { area: again[1]!.toLowerCase(), task: `check the ${again[1]} again` }));
    const delay = /check again in (\d+) seconds?/i.exec(input);
    if (delay !== null) return calls(call("schedule_check", { seconds: Number(delay[1]), note: "re-check the error rate" }));
    if (tools.includes("update_plan") && !messages.some((message) => message.role === "toolResult" && message.toolName === "update_plan")) {
      return calls(call("update_plan", { items: PLAN.map((text) => ({ text, status: "todo" })) }));
    }
    return fauxAssistantMessage(`Noted: ${input}`);
  };
}
