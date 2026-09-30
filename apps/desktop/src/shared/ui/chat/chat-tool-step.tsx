import { Collapsible } from "@base-ui-components/react/collapsible";
import type { ComponentProps } from "react";
import { ChatInlinePager } from "@/shared/ui/chat/chat-inline-pager";
import {
  ChatToolDetail,
  ChatToolGroup,
  formatToolDuration,
  hasToolDetail,
  toolDisplayName,
  toolTargetFromArgs,
  type ChatToolItem,
} from "@/shared/ui/chat/chat-tool";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import {
  ChatToolKindIcon,
  normalizeToolName,
  toolKindFromName,
  toolKindFromTools,
} from "@/shared/ui/chat/chat-tool-kind";
import { ChevronRight } from "@/shared/ui/icons";
import type { CotStep } from "@/entities/session/cot-view";

/**
 * A burst of Tool Calls as one step row (ADR-0030 §3). Live it names the call
 * currently streaming or executing and turns the page as Pi moves on; settled
 * it is one past-tense verb summary. A single call is just the one-element
 * burst — no second shape for the row — but its panel skips the per-call row:
 * the step row already names the call, so expanding goes straight to the
 * args and output instead of asking for a second click on a duplicate header.
 */

export type ChatToolStepItem = Extract<CotStep, { kind: "tools" }>;

type Verb = { past: string; noun: [string, string] };

const ran: Verb = { past: "Ran", noun: ["command", "commands"] };
const read: Verb = { past: "Read", noun: ["file", "files"] };
const edited: Verb = { past: "Edited", noun: ["file", "files"] };
const wrote: Verb = { past: "Wrote", noun: ["file", "files"] };
const searchedPattern: Verb = { past: "Searched", noun: ["pattern", "patterns"] };
const searchedPath: Verb = { past: "Searched", noun: ["path", "paths"] };
const listed: Verb = { past: "Listed", noun: ["directory", "directories"] };
const searchedWeb: Verb = { past: "Searched", noun: ["web page", "web pages"] };
const fetched: Verb = { past: "Fetched", noun: ["page", "pages"] };

// Keys are normalizeToolName() results. Aliases share the short-name verb
// so read_file buckets with read (file glyph + "Read"), write_file with write
// ("Wrote", not "Edited" — kind collapses write into edit, the summary does not).
const VERBS: Record<string, Verb> = {
  bash: ran,
  shell: ran,
  sh: ran,
  terminal: ran,
  cmd: ran,
  read,
  read_file: read,
  cat: read,
  edit: edited,
  str_replace: edited,
  write: wrote,
  write_file: wrote,
  grep: searchedPattern,
  find: searchedPath,
  glob: searchedPath,
  ls: listed,
  search: searchedPattern,
  web_search: searchedWeb,
  websearch: searchedWeb,
  webfetch: fetched,
  web_fetch: fetched,
  web: fetched,
  browser: fetched,
};

const FALLBACK: Verb = { past: "Used", noun: ["tool", "tools"] };

function verbFor(name: string | undefined): Verb {
  return VERBS[normalizeToolName(name)] ?? FALLBACK;
}

const TARGET_MAX = 72;

/** Paths keep their tail (the file name is the news); commands keep their head. */
function shortenTarget(target: string) {
  if (target.length <= TARGET_MAX) {
    return target;
  }

  if (target.includes("/") && !target.includes(" ")) {
    return `…${target.slice(-(TARGET_MAX - 1))}`;
  }

  return `${target.slice(0, TARGET_MAX - 1)}…`;
}

function pluralize(count: number, [one, many]: [string, string]) {
  if (count !== 1) {
    return `${count} ${many}`;
  }

  // "a tool" reads better than "1 tool" when we could not name the tool.
  return `${one === "tool" ? "a" : "1"} ${one}`;
}

/**
 * One call: verb plus what it acted on. Several: verbs in first-seen order
 * with counts, because "the last tool name and a number" reads a burst as one
 * call and says nothing about what the burst did.
 */
export function summarizeTools(tools: ChatToolItem[]) {
  if (tools.length === 1) {
    const [tool] = tools;
    const verb = verbFor(tool.toolName);
    const target = toolTargetFromArgs(tool.argsText);

    if (target) {
      return `${verb.past} ${shortenTarget(target)}`;
    }

    return verb === FALLBACK
      ? `Used ${toolDisplayName(tool.toolName) ?? "a tool"}`
      : `${verb.past} ${pluralize(1, verb.noun)}`;
  }

  const buckets = new Map<string, { verb: Verb; count: number }>();

  for (const tool of tools) {
    const verb = verbFor(tool.toolName);
    const key = `${verb.past}:${verb.noun[1]}`;
    const bucket = buckets.get(key) ?? { verb, count: 0 };

    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map(({ verb, count }, index) => {
      const clause = `${verb.past} ${pluralize(count, verb.noun)}`;

      return index === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1);
    })
    .join(", ");
}

type ChatToolStepOwnProps = {
  dwellMs?: number;
  step: ChatToolStepItem;
};

export type ChatToolStepProps = Omit<ComponentProps<"div">, keyof ChatToolStepOwnProps | "children"> &
  ChatToolStepOwnProps;

export function ChatToolStep({
  className = "",
  dwellMs,
  step,
  ...rest
}: ChatToolStepProps) {
  const { tools } = step;
  const failed = tools.filter((tool) => tool.state === "output-error").length;
  const nestedCount = tools.reduce((sum, tool) => sum + (tool.children?.length ?? 0), 0);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  // Line stats page in with the settled summary only; mid-burst a finished
  // call already has its result but the row is still paging call names.
  const diffStat = tools.reduce<{ additions: number; deletions: number } | undefined>(
    (sum, tool) =>
      tool.diffStat
        ? {
            additions: (sum?.additions ?? 0) + tool.diffStat.additions,
            deletions: (sum?.deletions ?? 0) + tool.diffStat.deletions,
          }
        : sum,
    undefined,
  );
  const active =
    tools.find((tool) => tool.toolCallId === step.activeToolCallId) ?? tools[tools.length - 1];
  // While a Nested Tool Execution runs, the label names it after its parent.
  const runningChildren = active?.children?.filter(
    (child) => child.state === "input-available",
  );
  const runningChild = runningChildren?.[runningChildren.length - 1];
  const kind = step.live ? toolKindFromName(active?.toolName) : toolKindFromTools(tools);
  // One pager for the row's whole life: call to call, and then to the summary,
  // all turn at the same pace, so finishing the burst is a page turn too.
  const pageKey = step.live ? `running:${active?.toolCallId ?? "none"}` : "settled";

  return (
    <Collapsible.Root
      className={`chat-step chat-tool-step ${className}`.trim()}
      data-slot="chat-tool-step"
      {...rest}
    >
      <Collapsible.Trigger className="chat-step__trigger">
        <ChatInlinePager dwellMs={dwellMs} pageKey={pageKey}>
          {step.live ? (
            <span className="chat-tool-step__page">
              <ChatToolKindIcon kind={kind} />
              <TextShimmer className="chat-step__label">
                {active?.toolName
                  ? runningChild?.toolName
                    ? `Running ${toolDisplayName(active.toolName)} › ${toolDisplayName(runningChild.toolName)}…`
                    : `Running ${toolDisplayName(active.toolName)}…`
                  : "Running…"}
              </TextShimmer>
            </span>
          ) : (
            <span className="chat-tool-step__page">
              <ChatToolKindIcon kind={kind} />
              <span className="chat-step__label">{summarizeTools(tools)}</span>
              {nestedCount > 0 ? (
                <span className="chat-step__meta" data-slot="chat-tool-nested-count">
                  {nestedCount === 1 ? "1 nested call" : `${nestedCount} nested calls`}
                </span>
              ) : null}
              {diffStat ? (
                <span className="chat-step__meta" data-slot="chat-tool-diff-stat">
                  <span className="text-success">+{diffStat.additions}</span>{" "}
                  <span className="text-danger">-{diffStat.deletions}</span>
                </span>
              ) : null}
              {failed > 0 ? (
                <span className="chat-step__meta chat-step__meta--error">
                  {failed === 1 ? "1 failed" : `${failed} failed`}
                </span>
              ) : null}
              {totalMs > 0 ? (
                <span className="chat-step__meta">{formatToolDuration(totalMs)}</span>
              ) : null}
            </span>
          )}
        </ChatInlinePager>
        <ChevronRight aria-hidden="true" className="chat-step__chevron" />
      </Collapsible.Trigger>
      <Collapsible.Panel keepMounted className="chat-step__panel">
        {tools.length === 1 ? (
          hasToolDetail(tools[0]) ? (
            <div className="chat-tool-step__detail" data-slot="chat-tool-step-detail">
              <ChatToolDetail tool={tools[0]} />
            </div>
          ) : null
        ) : (
          <ol className="chat-tool-step__list">
            {tools.map((tool, index) => (
              <li key={tool.toolCallId ?? index} className="chat-tool-step__item">
                <ChatToolKindIcon kind={toolKindFromName(tool.toolName)} />
                <ChatToolGroup tools={[tool]} />
              </li>
            ))}
          </ol>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
