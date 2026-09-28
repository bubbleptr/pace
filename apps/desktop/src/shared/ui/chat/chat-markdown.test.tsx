import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, ChatStreamMarkdown } from "@/shared/ui/chat/chat-markdown";

describe("ChatMarkdown", () => {
  it("renders markdown children as rich text through Astryx Markdown", () => {
    render(<ChatMarkdown>{"Some **bold** text"}</ChatMarkdown>);

    const root = screen.getByTestId("markdown-renderer");

    expect(root).toHaveAttribute("data-slot", "chat-markdown");
    expect(root.querySelector(".astryx-markdown")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("supports GFM tables", () => {
    render(<ChatMarkdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</ChatMarkdown>);

    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders fenced code with the Astryx built-in code block, not ChatCodeBlock", () => {
    const { container } = render(
      <ChatMarkdown>{"```ts\nconst x = 1;\n```"}</ChatMarkdown>,
    );

    expect(screen.queryByTestId("chat-code-block")).not.toBeInTheDocument();
    expect(container.querySelector(".astryx-markdown-codeblock")).toBeInTheDocument();
  });

  it("demotes markdown headings so they sit under the page title", () => {
    render(
      <ChatMarkdown>
        {["# Section one", "", "## Section two", "", "### Section three"].join("\n")}
      </ChatMarkdown>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Section one" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Section two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 5, name: "Section three" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("keeps chat headings on a conversation type scale", () => {
    const styles = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    expect(styles).toContain(".chat-markdown .astryx-markdown-heading[data-level=\"3\"]");
    expect(styles).toContain(".chat-markdown .astryx-markdown-heading[data-level=\"4\"]");
    expect(styles).toContain(".chat-markdown .astryx-markdown-heading[data-level=\"5\"]");
    expect(styles).toContain("font-size: var(--font-size-lg);");
    expect(styles).toContain("font-size: var(--font-size-base);");
    expect(styles).toContain("font-weight: var(--font-weight-semibold);");
    expect(styles).toContain("font-weight: var(--font-weight-medium);");
  });
});

describe("ChatStreamMarkdown", () => {
  it("marks the streaming state without a hand-drawn caret", async () => {
    const { container } = render(
      <ChatStreamMarkdown isStreaming>Streaming now</ChatStreamMarkdown>,
    );

    const root = screen.getByTestId("stream-markdown-renderer");

    expect(root).toHaveAttribute("data-is-streaming", "true");
    // Astryx incremental parsing reveals streamed chunks asynchronously.
    await waitFor(() => expect(root).toHaveTextContent("Streaming now"));
    expect(container.querySelector(".chat-markdown__caret")).not.toBeInTheDocument();
  });

  it("clears the streaming flag when the stream has settled", () => {
    render(<ChatStreamMarkdown>Settled</ChatStreamMarkdown>);

    expect(screen.getByTestId("stream-markdown-renderer")).toHaveAttribute(
      "data-is-streaming",
      "false",
    );
  });
});

describe("chat inline code", () => {
  it("routes inline code through the chat override on the static path", () => {
    render(<ChatMarkdown>{"Run `bun test` now"}</ChatMarkdown>);

    const code = screen.getByText("bun test");

    expect(code.tagName).toBe("CODE");
    expect(code).toHaveAttribute("data-slot", "chat-inline-code");
  });

  it("routes inline code through the chat override on the streaming path", async () => {
    render(<ChatStreamMarkdown isStreaming>{"Run `bun test` now"}</ChatStreamMarkdown>);

    await waitFor(() =>
      expect(screen.getByText("bun test")).toHaveAttribute("data-slot", "chat-inline-code"),
    );
  });
});

describe("chat inline code file references", () => {
  it("wraps a confirmed inline code span in a link around the code chip", () => {
    render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts:12"])}>
        {"See `src/a.ts:12` for details."}
      </ChatMarkdown>,
    );

    const link = screen.getByRole("link", { name: "src/a.ts:12" });

    expect(link).toHaveAttribute("data-slot", "chat-inline-code-link");
    expect(link).toHaveAttribute("href", "src/a.ts:12");
    expect(link).toHaveAttribute("title", "src/a.ts:12");
    expect(link.querySelector('[data-slot="chat-inline-code"]')).toBeInTheDocument();
  });

  it("leaves unconfirmed spans and inline code without the prop plain", () => {
    const { unmount } = render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts"])}>
        {"See `src/a.ts` and `src/other.ts`."}
      </ChatMarkdown>,
    );

    expect(screen.getByRole("link", { name: "src/a.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "src/other.ts" })).not.toBeInTheDocument();
    expect(screen.getByText("src/other.ts")).toHaveAttribute(
      "data-slot",
      "chat-inline-code",
    );

    unmount();
    render(<ChatMarkdown>{"See `src/a.ts`."}</ChatMarkdown>);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toHaveAttribute(
      "data-slot",
      "chat-inline-code",
    );
  });

  it("ignores linkedInlineCode when fileLinks is off", () => {
    render(
      <ChatMarkdown linkedInlineCode={new Set(["src/a.ts"])}>
        {"See `src/a.ts`."}
      </ChatMarkdown>,
    );

    // Without the link override there is no inside-link marker, so the set
    // is never applied.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toHaveAttribute(
      "data-slot",
      "chat-inline-code",
    );
  });

  it("does not nest an inline-code link inside another link", () => {
    render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts"])}>
        {"[`src/a.ts`](README.md) and `src/a.ts`"}
      </ChatMarkdown>,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    const outer = links.find((link) => link.getAttribute("href") === "README.md")!;
    // The code chip keeps rendering, only the nested <a> is suppressed.
    expect(outer.querySelector('[data-slot="chat-inline-code"]')).toBeInTheDocument();
    expect(outer.querySelector('[data-slot="chat-inline-code-link"]')).toBeNull();
    const inner = links.find(
      (link) => link.getAttribute("data-slot") === "chat-inline-code-link",
    )!;
    expect(inner).toHaveAttribute("href", "src/a.ts");
  });

  it("does not nest an inline-code link inside an external link", () => {
    render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts"])}>
        {"[`src/a.ts`](https://example.com)"}
      </ChatMarkdown>,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com");
    expect(links[0].querySelector('[data-slot="chat-inline-code-link"]')).toBeNull();
  });

  it("links a padded code span using its trimmed text", () => {
    render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts"])}>
        {"See `  src/a.ts  `."}
      </ChatMarkdown>,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("data-slot", "chat-inline-code-link");
    expect(link).toHaveAttribute("href", "src/a.ts");
    expect(link).toHaveAttribute("title", "src/a.ts");
  });

  it("never links fenced code with the same text", () => {
    render(
      <ChatMarkdown fileLinks linkedInlineCode={new Set(["src/a.ts"])}>
        {"```\nsrc/a.ts\n```"}
      </ChatMarkdown>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
