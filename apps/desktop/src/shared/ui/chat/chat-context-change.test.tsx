import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatContextChange } from "./chat-context-change";

describe("ChatContextChange", () => {
  it("names added and removed tools", () => {
    render(
      <ChatContextChange toolsAdded={["write", "edit"]} toolsRemoved={["bash"]} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Tools changed: +write, +edit, −bash",
    );
  });

  it("names prompt section updates", () => {
    render(<ChatContextChange sectionsChanged={["skills", "cwd"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Prompt updated: skills, cwd");
  });

  it("names removed prompt sections", () => {
    render(<ChatContextChange sectionsRemoved={["skills"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Prompt section removed: skills");
  });

  it("joins tool and prompt fragments", () => {
    render(
      <ChatContextChange
        toolsAdded={["write"]}
        sectionsChanged={["skills"]}
        sectionsRemoved={["cwd"]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Tools changed: +write · Prompt updated: skills · Prompt section removed: cwd",
    );
  });

  it("collapses a side with more than four tool names to a count", () => {
    render(
      <ChatContextChange
        toolsAdded={["a", "b", "c", "d", "e"]}
        toolsRemoved={["bash"]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Tools changed: +5 tools, −bash",
    );
  });

  it("renders nothing when the patch is empty", () => {
    const { container } = render(<ChatContextChange />);
    expect(container).toBeEmptyDOMElement();
  });
});
