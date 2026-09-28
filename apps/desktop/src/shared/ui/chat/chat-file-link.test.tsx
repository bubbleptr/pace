import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ChatFileLink,
  parseChatFileHref,
} from "@/shared/ui/chat/chat-file-link";
import { ChatMarkdown } from "@/shared/ui/chat/chat-markdown";

describe("parseChatFileHref", () => {
  it("parses relative paths and name", () => {
    expect(parseChatFileHref("src/a/b.ts")).toEqual({
      path: "src/a/b.ts",
      name: "b.ts",
    });
    expect(parseChatFileHref("b.ts")).toEqual({ path: "b.ts", name: "b.ts" });
  });

  it("parses the same line forms as session change links", () => {
    for (const href of [
      "src/a/b.ts:12",
      "src/a/b.ts:12:3",
      "src/a/b.ts#L12",
      "src/a/b.ts#L12-L20",
    ]) {
      expect(parseChatFileHref(href)).toEqual({
        path: "src/a/b.ts",
        name: "b.ts",
        line: 12,
      });
    }
  });

  it("rejects directory links — a trailing slash is not a file", () => {
    expect(parseChatFileHref("src/utils/")).toBeNull();
    expect(parseChatFileHref("docs/")).toBeNull();
  });

  it("treats a dotted filename with a numeric suffix as a file, not a scheme", () => {
    expect(parseChatFileHref("file.ts:12")).toEqual({
      path: "file.ts",
      name: "file.ts",
      line: 12,
    });
  });

  it.each([
    "#L12",
    "#section",
    "?q=1",
    "//example.com/src/a.ts",
    "C:\\work\\a.ts",
    "src\\a.ts",
    "https://example.com/a.ts",
    "file:///work/repo/a.ts",
    "mailto:test@example.com",
    "tel:+15551234567",
    "data:text/plain,hi",
    "javascript:alert(1)",
  ])("rejects %s", (href) => {
    expect(parseChatFileHref(href)).toBeNull();
  });
});

describe("ChatMarkdown file links", () => {
  it("renders a compact chip when the label repeats the target", () => {
    render(
      <ChatMarkdown fileLinks>
        {"See [src/a/b.ts:12](src/a/b.ts:12) for details."}
      </ChatMarkdown>,
    );

    const link = screen.getByRole("link", { name: "b.ts:12" });
    expect(link).toHaveAttribute("data-slot", "chat-file-link");
    expect(link).toHaveAttribute("href", "src/a/b.ts:12");
    expect(link).toHaveAttribute("title", "src/a/b.ts:12");
    expect(link.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps the #L line form in name:line labels", () => {
    render(
      <ChatMarkdown fileLinks>{"[README.md#L3](README.md#L3)"}</ChatMarkdown>,
    );

    const link = screen.getByRole("link", { name: "README.md:3" });
    expect(link).toHaveAttribute("title", "README.md:3");
  });

  it("renders a directory link as a plain link, not a chip", () => {
    render(<ChatMarkdown fileLinks>{"[docs/](docs/)"}</ChatMarkdown>);

    const link = screen.getByRole("link", { name: "docs/" });
    expect(link).not.toHaveAttribute("data-slot", "chat-file-link");
    expect(link).not.toHaveAttribute("target");
  });

  it("keeps custom link text and still marks it as a file link", () => {
    render(<ChatMarkdown fileLinks>{"[see here](src/a.ts)"}</ChatMarkdown>);

    const link = screen.getByRole("link", { name: "see here" });
    expect(link).toHaveAttribute("data-slot", "chat-file-link");
    expect(link.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps web links on the external path", () => {
    render(
      <ChatMarkdown fileLinks>{"[x](https://example.com)"}</ChatMarkdown>,
    );

    const link = screen.getByRole("link", { name: "x" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).not.toHaveAttribute("data-slot", "chat-file-link");
  });

  it("renders local links as plain links without the fileLinks opt-in", () => {
    render(<ChatMarkdown>{"[src/a.ts](src/a.ts)"}</ChatMarkdown>);

    const link = screen.getByRole("link");
    expect(link).not.toHaveAttribute("data-slot", "chat-file-link");
  });
});

describe("ChatFileLink", () => {
  it("renders non-file links without the chip slot", () => {
    render(<ChatFileLink href="mailto:test@example.com">mail</ChatFileLink>);

    const link = screen.getByRole("link", { name: "mail" });
    expect(link).not.toHaveAttribute("data-slot", "chat-file-link");
    expect(link).toHaveAttribute("href", "mailto:test@example.com");
  });
});
