import { Collapsible } from "@base-ui-components/react/collapsible";
import type { ComponentProps } from "react";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import {
  formatToolDuration,
  toolDisplayName,
  toolTargetFromArgs,
  type ChatToolItem,
} from "@/shared/ui/chat/chat-tool";

/**
 * Timeline-style chain of thought: think→tool loops render as labeled
 * rounds on a vertical rail, thinking and tool calls as distinct node
 * kinds, every node carrying its duration. Alternative skin to
 * ChatChainOfThought over the same part sequence — selectable via the
 * future Appearance setting (.scratch/cot-variants/issues/01).
 */
export type ChainOfThoughtRailPart =
  | { kind: "thinking"; id: string; text: string; durationMs?: number }
  | { kind: "tool"; id: string; tool: ChatToolItem };

type RailRound = {
  id: string;
  thinking?: Extract<ChainOfThoughtRailPart, { kind: "thinking" }>;
  tools: Extract<ChainOfThoughtRailPart, { kind: "tool" }>[];
};

/** A thinking part opens a new round; tools attach to the current one. */
function groupRounds(parts: ChainOfThoughtRailPart[]): RailRound[] {
  const rounds: RailRound[] = [];
  for (const part of parts) {
    const last = rounds[rounds.length - 1];
    if (part.kind === "thinking") {
      rounds.push({ id: part.id, thinking: part, tools: [] });
    } else if (last) {
      last.tools.push(part);
    } else {
      rounds.push({ id: part.id, tools: [part] });
    }
  }
  return rounds;
}

function Chevron() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RailToolNode({ tool }: { tool: ChatToolItem }) {
  const target = toolTargetFromArgs(tool.argsText);
  const running = tool.state === "input-streaming" || tool.state === "input-available";
  const hasDetail = tool.argsText != null || tool.output != null;

  const row = (
    <>
      <span className="chain-of-thought-rail__tool-name">{toolDisplayName(tool.toolName) ?? "tool"}</span>
      {target ? (
        <span className="chain-of-thought-rail__tool-target">{target}</span>
      ) : null}
      <span className="chain-of-thought-rail__node-meta">
        {tool.state === "output-error" ? (
          <span className="chain-of-thought-rail__badge" data-tone="error">
            failed
          </span>
        ) : running ? (
          <span className="chain-of-thought-rail__badge" data-tone="running">
            running
          </span>
        ) : null}
        {tool.durationMs !== undefined ? (
          <span className="chain-of-thought-rail__duration">
            {formatToolDuration(tool.durationMs)}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <li
      className="chain-of-thought-rail__node"
      data-slot="chain-of-thought-rail-node"
      data-kind="tool"
      data-state={tool.state}
    >
      <span
        className="chain-of-thought-rail__marker"
        data-kind="tool"
        data-state={tool.state}
        aria-hidden="true"
      />
      {hasDetail ? (
        <details className="chain-of-thought-rail__tool">
          <summary className="chain-of-thought-rail__tool-row">
            <span className="chain-of-thought-rail__disclosure" aria-hidden="true">
              <Chevron />
            </span>
            {row}
          </summary>
          <div className="chain-of-thought-rail__tool-detail">
            {tool.argsText != null ? (
              <pre className="chain-of-thought-rail__pre" data-label="args">
                {tool.argsText}
              </pre>
            ) : null}
            {tool.output != null ? (
              <pre
                className="chain-of-thought-rail__pre"
                data-label={tool.state === "output-error" ? "stderr" : "output"}
                data-tone={tool.state === "output-error" ? "error" : undefined}
              >
                {tool.output}
              </pre>
            ) : null}
          </div>
        </details>
      ) : (
        <div className="chain-of-thought-rail__tool-row" data-static="true">
          <span
            className="chain-of-thought-rail__disclosure"
            data-hidden="true"
            aria-hidden="true"
          >
            <Chevron />
          </span>
          {row}
        </div>
      )}
    </li>
  );
}

type ChatChainOfThoughtRailOwnProps = {
  parts: ChainOfThoughtRailPart[];
  /** Settled trigger label, e.g. "Thought for 38s · 6 tool calls". */
  summary: string;
  defaultOpen?: boolean;
  isStreaming?: boolean;
};

export type ChatChainOfThoughtRailProps = Omit<
  ComponentProps<"div">,
  keyof ChatChainOfThoughtRailOwnProps | "children"
> &
  ChatChainOfThoughtRailOwnProps;

export function ChatChainOfThoughtRail({
  parts,
  summary,
  className = "",
  defaultOpen = false,
  isStreaming = false,
  ...rest
}: ChatChainOfThoughtRailProps) {
  const rounds = groupRounds(parts);

  return (
    <Collapsible.Root
      className={`chain-of-thought-rail ${className}`.trim()}
      data-slot="chain-of-thought-rail"
      data-streaming={String(isStreaming)}
      defaultOpen={isStreaming || defaultOpen}
      {...rest}
    >
      <Collapsible.Trigger className="chain-of-thought-rail__trigger">
        <span className="chain-of-thought-rail__trigger-chevron" aria-hidden="true">
          <Chevron />
        </span>
        {isStreaming ? <TextShimmer>Thinking…</TextShimmer> : summary}
      </Collapsible.Trigger>
      <Collapsible.Panel className="chain-of-thought-rail__panel">
        <div className="chain-of-thought-rail__track">
          {rounds.map((round, index) => {
            const roundDuration =
              (round.thinking?.durationMs ?? 0) +
              round.tools.reduce((sum, part) => sum + (part.tool.durationMs ?? 0), 0);
            return (
              <section key={round.id} className="chain-of-thought-rail__round">
                <header className="chain-of-thought-rail__round-header">
                  <span className="chain-of-thought-rail__round-label">
                    Round {index + 1}
                  </span>
                  <span className="chain-of-thought-rail__duration">
                    {formatToolDuration(roundDuration)}
                  </span>
                </header>
                <ol className="chain-of-thought-rail__nodes">
                  {round.thinking ? (
                    <li
                      className="chain-of-thought-rail__node"
                      data-slot="chain-of-thought-rail-node"
                      data-kind="thinking"
                    >
                      <span
                        className="chain-of-thought-rail__marker"
                        data-kind="thinking"
                        aria-hidden="true"
                      />
                      <div className="chain-of-thought-rail__thinking">
                        <div className="chain-of-thought-rail__node-head">
                          <span className="chain-of-thought-rail__thinking-label">
                            Thinking
                          </span>
                          <span className="chain-of-thought-rail__node-meta">
                            {round.thinking.durationMs !== undefined ? (
                              <span className="chain-of-thought-rail__duration">
                                {formatToolDuration(round.thinking.durationMs)}
                              </span>
                            ) : null}
                          </span>
                        </div>
                        <p className="chain-of-thought-rail__thinking-text">
                          {round.thinking.text}
                        </p>
                      </div>
                    </li>
                  ) : null}
                  {round.tools.map((part) => (
                    <RailToolNode key={part.id} tool={part.tool} />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
