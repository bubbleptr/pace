import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatToolStep, summarizeTools } from "@/shared/ui/chat/chat-tool-step";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import type { CotStep } from "@/entities/session/cot-view";

type ToolsStep = Extract<CotStep, { kind: "tools" }>;

function tool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
  return { state: "output-available", ...overrides };
}

function step(tools: ChatToolItem[], overrides: Partial<ToolsStep> = {}): ToolsStep {
  return { kind: "tools", id: "s1", live: false, tools, ...overrides };
}

describe("summarizeTools", () => {
  it("names what a single call acted on", () => {
    expect(
      summarizeTools([
        tool({
          toolName: "read",
          argsText: JSON.stringify({ path: "packages/backend/src/workspace/fork.ts" }),
        }),
      ]),
    ).toBe("Read packages/backend/src/workspace/fork.ts");
  });

  it("falls back to the verb when a call carries no target", () => {
    expect(summarizeTools([tool({ toolName: "read" })])).toBe("Read 1 file");
    expect(summarizeTools([tool({ toolName: "sleep" })])).toBe("Used sleep");
    expect(summarizeTools([tool()])).toBe("Used a tool");
    expect(summarizeTools([tool({ toolName: "web_search" })])).toBe("Searched 1 web page");
  });

  // Pi's runtime emits read_file / write_file; the kind icon already maps
  // those aliases, so the summary must use the same verbs as read / write.
  it("uses the same verbs for Pi's file aliases as for the short names", () => {
    expect(summarizeTools([tool({ toolName: "read_file" })])).toBe("Read 1 file");
    expect(summarizeTools([tool({ toolName: "Read-File" })])).toBe("Read 1 file");
    expect(summarizeTools([tool({ toolName: "write_file" })])).toBe("Wrote 1 file");
    expect(
      summarizeTools([
        tool({
          toolName: "read_file",
          argsText: JSON.stringify({ path: "apps/desktop/src/app/main.tsx" }),
        }),
      ]),
    ).toBe("Read apps/desktop/src/app/main.tsx");
    expect(
      summarizeTools([tool({ toolName: "read" }), tool({ toolName: "read_file" })]),
    ).toBe("Read 2 files");
  });

  // A path's news is its file name; a command's is the program it runs.
  it("keeps the tail of a long path and the head of a long command", () => {
    const path = `packages/backend/src/${"nested/".repeat(12)}fork.ts`;
    const command = `bun vitest run ${"apps/desktop/src/shared/ui/chat ".repeat(4)}`;

    const summarizedPath = summarizeTools([
      tool({ toolName: "read", argsText: JSON.stringify({ path }) }),
    ]);
    const summarizedCommand = summarizeTools([
      tool({ toolName: "bash", argsText: JSON.stringify({ command }) }),
    ]);

    expect(summarizedPath).toContain("Read …");
    expect(summarizedPath.endsWith("fork.ts")).toBe(true);
    expect(summarizedPath).not.toContain("packages/backend");
    expect(summarizedCommand).toContain("Ran bun vitest run");
    expect(summarizedCommand.endsWith("…")).toBe(true);
  });

  it("counts a burst by what its calls did, not by how many they were", () => {
    expect(
      summarizeTools([
        tool({ toolName: "bash" }),
        tool({ toolName: "edit" }),
        tool({ toolName: "bash" }),
        tool({ toolName: "edit" }),
        tool({ toolName: "edit" }),
      ]),
    ).toBe("Ran 2 commands, edited 3 files");
  });
});

describe("ChatToolStep", () => {
  it("names the call that is running while the burst is live", () => {
    const { container } = render(
      <ChatToolStep
        step={step(
          [
            tool({ toolCallId: "c1", toolName: "bash", state: "output-available" }),
            tool({ toolCallId: "c2", toolName: "read", state: "input-available" }),
          ],
          { live: true, activeToolCallId: "c2" },
        )}
      />,
    );

    expect(container.querySelector('[data-slot="text-shimmer"]')).toHaveTextContent("Running read…");
  });

  // The part stream carries no tool name until tool(start); the row still has
  // to say something truthful while the arguments stream in.
  it("says only 'Running…' before the call's name arrives", () => {
    const { container } = render(
      <ChatToolStep
        step={step([tool({ toolCallId: "c1", state: "input-streaming" })], {
          live: true,
          activeToolCallId: "c1",
        })}
      />,
    );

    expect(container.querySelector('[data-slot="text-shimmer"]')).toHaveTextContent("Running…");
  });

  it("settles into a verb summary with the failures and the total time", () => {
    render(
      <ChatToolStep
        step={step([
          tool({ toolCallId: "c1", toolName: "bash", durationMs: 500 }),
          tool({
            toolCallId: "c2",
            toolName: "bash",
            state: "output-error",
            durationMs: 250,
          }),
        ])}
      />,
    );

    expect(screen.getByText("Ran 2 commands")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("750ms")).toBeInTheDocument();
  });

  it("sums per-tool diff stats into one settled meta", () => {
    const { container } = render(
      <ChatToolStep
        step={step([
          tool({
            toolCallId: "c1",
            toolName: "edit",
            diffStat: { additions: 3, deletions: 1 },
          }),
          tool({
            toolCallId: "c2",
            toolName: "edit",
            diffStat: { additions: 2, deletions: 0 },
          }),
          tool({ toolCallId: "c3", toolName: "read" }),
        ])}
      />,
    );

    const stat = container.querySelector('[data-slot="chat-tool-diff-stat"]');

    expect(stat).toBeInTheDocument();
    expect(stat).toHaveTextContent("+5");
    expect(stat).toHaveTextContent("-1");
  });

  it("shows no diff-stat meta when no tool carried one", () => {
    const { container } = render(
      <ChatToolStep
        step={step([
          tool({ toolCallId: "c1", toolName: "read" }),
          tool({ toolCallId: "c2", toolName: "bash" }),
        ])}
      />,
    );

    expect(container.querySelector('[data-slot="chat-tool-diff-stat"]')).not.toBeInTheDocument();
  });

  // A finished call inside a still-running burst already holds its result;
  // the number stays hidden until the row settles so it cannot page in early.
  it("withholds diff stats while the step is live", () => {
    const { container } = render(
      <ChatToolStep
        step={step(
          [
            tool({
              toolCallId: "c1",
              toolName: "edit",
              state: "output-available",
              diffStat: { additions: 3, deletions: 1 },
            }),
            tool({ toolCallId: "c2", toolName: "read", state: "input-available" }),
          ],
          { live: true, activeToolCallId: "c2" },
        )}
      />,
    );

    expect(container.querySelector('[data-slot="chat-tool-diff-stat"]')).not.toBeInTheDocument();
  });

  it("marks the summary with the shared kind, and each expanded row with its own", () => {
    const { container } = render(
      <ChatToolStep
        step={step([
          tool({ toolCallId: "c1", toolName: "bash" }),
          tool({ toolCallId: "c2", toolName: "web_search" }),
        ])}
      />,
    );

    const header = container.querySelector(
      '[data-slot="chat-tool-step"] > button [data-slot="chat-tool-kind"]',
    );
    const rows = container.querySelectorAll(
      '[data-slot="chat-tool-step"] li [data-slot="chat-tool-kind"]',
    );

    expect(header).toHaveAttribute("data-kind", "tool");
    expect([...rows].map((row) => row.getAttribute("data-kind"))).toEqual(["shell", "web"]);
  });

  it("uses the running call's kind while the burst is live", () => {
    const { container } = render(
      <ChatToolStep
        step={step(
          [
            tool({ toolCallId: "c1", toolName: "read", state: "output-available" }),
            tool({ toolCallId: "c2", toolName: "bash", state: "input-available" }),
          ],
          { live: true, activeToolCallId: "c2" },
        )}
      />,
    );

    const header = container.querySelector(
      '[data-slot="chat-tool-step"] > button [data-slot="chat-tool-kind"]',
    );

    expect(header).toHaveAttribute("data-kind", "shell");
  });

  it("expands to one production row per call", () => {
    const { container } = render(
      <ChatToolStep
        step={step([
          tool({ toolCallId: "c1", toolName: "bash" }),
          tool({ toolCallId: "c2", toolName: "read" }),
        ])}
      />,
    );

    const rows = container.querySelectorAll('[data-slot="chat-tool-group"]');

    expect(rows).toHaveLength(2);
    expect([...rows].every((row) => row.getAttribute("data-tool-count") === "1")).toBe(true);
  });

  // One call is the one-element burst, but the step row already says what
  // the call did: a second header inside the panel only costs a second click.
  it("opens a single call's args and output with one click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatToolStep
        step={step([
          tool({
            toolCallId: "c1",
            toolName: "read",
            argsText: '{"path":"AGENTS.md"}',
            output: "Agent instructions loaded.",
          }),
        ])}
      />,
    );

    expect(container.querySelector('[data-slot="chat-tool-args"]')).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: /Read AGENTS.md/ }));

    expect(container.querySelector('[data-slot="chat-tool-args"]')).toHaveTextContent(
      '{"path":"AGENTS.md"}',
    );
    expect(container.querySelector('[data-slot="chat-tool-args"]')).toBeVisible();
    expect(container.querySelector('[data-slot="chat-tool-result"]')).toHaveTextContent(
      "Agent instructions loaded.",
    );
    expect(container.querySelector('[data-slot="chat-tool-group"]')).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
