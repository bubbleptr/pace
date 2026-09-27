import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  ChatTool,
  ChatToolGroup,
  formatToolDuration,
  toolTargetFromArgs,
} from "@/shared/ui/chat/chat-tool";

describe("toolTargetFromArgs", () => {
  it("extracts the most specific common key from JSON args", () => {
    expect(toolTargetFromArgs('{"path":"src/index.ts"}')).toBe("src/index.ts");
    expect(toolTargetFromArgs('{"file_path":"a.ts","limit":5}')).toBe("a.ts");
    expect(toolTargetFromArgs('{"command":"git diff --stat"}')).toBe("git diff --stat");
    expect(toolTargetFromArgs('{"query":"astryx tokens"}')).toBe("astryx tokens");
  });

  it("returns undefined for malformed, empty, or keyless args", () => {
    expect(toolTargetFromArgs(undefined)).toBeUndefined();
    expect(toolTargetFromArgs("not json")).toBeUndefined();
    expect(toolTargetFromArgs('{"foo":1}')).toBeUndefined();
    expect(toolTargetFromArgs('{"path":42}')).toBeUndefined();
  });

  it("truncates very long targets", () => {
    const target = toolTargetFromArgs(JSON.stringify({ command: "x".repeat(300) }));
    expect(target).toHaveLength(121);
    expect(target?.endsWith("…")).toBe(true);
  });
});

describe("formatToolDuration", () => {
  it("formats sub-second as ms and seconds with one decimal", () => {
    expect(formatToolDuration(45)).toBe("45ms");
    expect(formatToolDuration(999)).toBe("999ms");
    expect(formatToolDuration(3200)).toBe("3.2s");
    expect(formatToolDuration(60_000)).toBe("60.0s");
  });

  it("returns undefined for missing or invalid input", () => {
    expect(formatToolDuration(undefined)).toBeUndefined();
    expect(formatToolDuration(-5)).toBeUndefined();
    expect(formatToolDuration(Number.NaN)).toBeUndefined();
  });
});

describe("ChatToolGroup", () => {
  const tools = [
    {
      toolCallId: "call-1",
      toolName: "read",
      state: "output-available" as const,
      argsText: '{"path":"AGENTS.md"}',
      output: "loaded",
      durationMs: 45,
    },
    {
      toolCallId: "call-2",
      toolName: "bash",
      state: "output-error" as const,
      argsText: '{"command":"yarn test"}',
      output: "exit 1",
      durationMs: 3200,
    },
  ];

  it("renders multiple calls in one group with targets and durations", () => {
    const { container } = render(<ChatToolGroup tools={tools} />);

    const group = container.querySelector('[data-slot="chat-tool-group"]');

    expect(group).toBeInTheDocument();
    expect(group).toHaveTextContent("read");
    expect(group).toHaveTextContent("AGENTS.md");
    expect(group).toHaveTextContent("45ms");
    expect(group).toHaveTextContent("bash");
    expect(group).toHaveTextContent("yarn test");
    // A multi-call group exposes a summary toggle from Astryx.
    expect(screen.getByRole("button", { name: /2/ })).toBeInTheDocument();
  });

  it("renders per-call diff stats through the Astryx additions/deletions slots", () => {
    const { container } = render(
      <ChatToolGroup
        tools={[
          {
            toolCallId: "call-edit",
            toolName: "edit",
            state: "output-available",
            argsText: '{"path":"src/main.ts"}',
            diffStat: { additions: 12, deletions: 3 },
          },
        ]}
      />,
    );

    const group = container.querySelector('[data-slot="chat-tool-group"]');

    expect(group).toHaveTextContent("+12");
    expect(group).toHaveTextContent("-3");
  });

  it("renders a single tool identically to ChatTool's single-call mode", () => {
    const { container } = render(<ChatToolGroup tools={[tools[0]]} />);

    expect(container.querySelector('[data-slot="chat-tool-group"]')).toHaveTextContent(
      "read",
    );
    // No group summary for a single call.
    expect(screen.queryByRole("button", { name: /1 / })).not.toBeInTheDocument();
  });
});

describe("ChatTool", () => {
  it("renders an Astryx tool-call row, keeping details unmounted while collapsed", () => {
    const { container } = render(
      <ChatTool
        argsText='{"path":"AGENTS.md"}'
        output="Agent instructions loaded."
        state="output-available"
        toolCallId="tool-call-1"
        toolName="read"
      />,
    );

    const tool = container.querySelector('[data-slot="chat-tool"]');

    expect(tool).toBeInTheDocument();
    expect(tool).toHaveAttribute("data-state", "output-available");
    expect(tool).toHaveAttribute("data-tool-call-id", "tool-call-1");
    expect(tool).toHaveTextContent("read");
    expect(tool).not.toHaveTextContent('{"path":"AGENTS.md"}');
    expect(tool).not.toHaveTextContent("Agent instructions loaded.");
  });

  it("reveals args and output when the row is expanded", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatTool
        argsText='{"path":"AGENTS.md"}'
        output="Agent instructions loaded."
        state="output-available"
        toolName="read"
      />,
    );

    const row = screen.getByRole("button", { name: /read/ });
    expect(row).toHaveAttribute("aria-expanded", "false");

    await user.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector('[data-slot="chat-tool-args"]')).toHaveTextContent(
      '{"path":"AGENTS.md"}',
    );
    expect(container.querySelector('[data-slot="chat-tool-result"]')).toHaveTextContent(
      "Agent instructions loaded.",
    );
  });

  it("keeps a row without args or output non-expandable", () => {
    render(<ChatTool state="input-streaming" toolName="search" />);

    expect(screen.queryByRole("button", { name: /search/ })).not.toBeInTheDocument();
  });

  it("surfaces the output as the accessible error message when the tool failed", () => {
    const { container } = render(
      <ChatTool
        argsText="{}"
        output="ENOENT: file not found"
        state="output-error"
        toolName="read"
      />,
    );

    const tool = container.querySelector('[data-slot="chat-tool"]');

    expect(tool).toHaveAttribute("data-state", "output-error");
    // Astryx renders errorMessage as visually hidden row text for a11y.
    expect(screen.getAllByText(/ENOENT: file not found/).length).toBeGreaterThan(0);
  });
});
