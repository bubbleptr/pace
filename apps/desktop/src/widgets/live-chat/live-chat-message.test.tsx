import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PromptCommand } from "@pace/core";
import { LiveChatMessage } from "./live-chat-message";

const commands: PromptCommand[] = [
  { kind: "skill", name: "review-pr", invocation: "skill:review-pr" },
  { kind: "prompt", name: "fix", invocation: "fix" },
];

describe("LiveChatMessage prompt tokens", () => {
  it("shows command and file tokens while copying and forking the original prompt", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const onForkMessage = vi.fn();
    const message = {
      id: "request",
      role: "user" as const,
      body: '/skill:review-pr 请看 @src/a.ts 和 @"docs/my notes.md"',
      piEntryId: "pi-entry",
    };
    render(
      <LiveChatMessage
        message={message}
        promptCommands={commands}
        onForkMessage={onForkMessage}
      />,
    );

    expect(screen.getByText("review-pr")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("my notes.md")).toBeInTheDocument();
    expect(screen.getByText(/请看/)).toBeInTheDocument();

    await user.hover(screen.getByText("a.ts"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("@src/a.ts");
    await user.unhover(screen.getByText("a.ts"));

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith(message.body);
    await user.click(screen.getByRole("button", { name: "Fork from message" }));
    expect(onForkMessage).toHaveBeenCalledWith(message);
  });

  it("folds a complete Pi skill block without needing the skill in today's catalog", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const body = '<skill name="old-review" location="/repo/.pi/skills/review/SKILL.md">\nReferences are relative to /repo/.pi/skills/review.\n\nSECRET SKILL BODY\n</skill>\n\n检查 @src/a.ts';
    render(<LiveChatMessage message={{ id: "history", role: "user", body }} />);

    expect(screen.getByText("old-review")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText(/检查/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET SKILL BODY/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith(body);
  });

  it("preserves literal route filenames, quoted CJK paths, and directory references", () => {
    render(
      <LiveChatMessage message={{
        id: "paths",
        role: "user",
        body: '查看 @src/routes/[id]+(view).tsx 和 @"docs/notes，draft.md"，目录 @src/components/',
      }} />,
    );

    expect(screen.getByText("[id]+(view).tsx")).toBeInTheDocument();
    expect(screen.getByText("notes，draft.md")).toBeInTheDocument();
    expect(screen.getByText("components/")).toBeInTheDocument();
  });

  it("keeps command prefixes and emails as prose and ends file references at Pi separators", () => {
    const { container } = render(
      <LiveChatMessage
        promptCommands={commands}
        message={{
          id: "boundaries",
          role: "user",
          body: "/fixer foo@src/a.ts /fix @src/a.ts，后续 @src/a.tsx",
        }}
      />,
    );

    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("a.tsx")).toBeInTheDocument();
    expect(screen.getByText(/\/fixer foo@src\/a.ts \/fix/)).toBeInTheDocument();
    expect(container.querySelectorAll(".astryx-badge")).toHaveLength(2);
  });

  it.each([
    '<skill name="review" location="/repo/SKILL.md">\nIncomplete skill instructions',
    'Explain <skill name="review" location="/repo/SKILL.md">\nExample content\n</skill>',
  ])("preserves skill-like prose instead of hiding it: %s", (body) => {
    const { container } = render(
      <LiveChatMessage message={{ id: "prose", role: "user", body }} />,
    );

    expect(container.querySelector('[data-slot="chat-message-content"]')?.textContent).toBe(body);
    expect(container.querySelector(".astryx-badge")).not.toBeInTheDocument();
  });
});
