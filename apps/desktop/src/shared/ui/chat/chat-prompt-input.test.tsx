import { type ReactNode, useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ChatPromptInput,
  type ChatPromptInputHandle,
} from "@/shared/ui/chat/chat-prompt-input";
import {
  getPromptInput,
  promptValue,
  typeIntoPrompt,
} from "@/test/prompt-input";

function renderPromptInput({
  value = "",
  status,
  placeholder = "Type here",
  allowSubmitWhileRunning,
  lockInputOnRun,
  hasAttachments,
  drawer,
  accent,
  onSubmit = () => {},
  onStop,
  onValueChange = () => {},
  onFiles,
  error,
}: {
  value?: string;
  status?: "ready" | "submitted" | "streaming" | "error";
  placeholder?: string;
  allowSubmitWhileRunning?: boolean;
  lockInputOnRun?: boolean;
  hasAttachments?: boolean;
  drawer?: ReactNode;
  accent?: "brand";
  onSubmit?: () => void;
  onStop?: () => void;
  onValueChange?: (value: string) => void;
  onFiles?: (files: File[]) => void;
  error?: string;
} = {}) {
  return render(
    <ChatPromptInput
      accent={accent}
      allowSubmitWhileRunning={allowSubmitWhileRunning}
      drawer={drawer}
      error={error}
      footer="footer text"
      hasAttachments={hasAttachments}
      lockInputOnRun={lockInputOnRun}
      placeholder={placeholder}
      startActions={<span>start</span>}
      status={status}
      value={value}
      onFiles={onFiles}
      onStop={onStop}
      onSubmit={onSubmit}
      onValueChange={onValueChange}
    />,
  );
}

describe("ChatPromptInput", () => {
  it("renders the Astryx composer shell with the editable input and footer", () => {
    const { container } = renderPromptInput({ status: "streaming" });

    const root = container.querySelector('[data-slot="prompt-input"]');
    const input = getPromptInput();

    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("data-status", "streaming");
    expect(root?.querySelector(".astryx-chat-composer")).toBeInTheDocument();
    expect(input).toHaveAttribute("contenteditable", "true");
    expect(input).toHaveAttribute("aria-multiline", "true");
    expect(screen.getByText("footer text")).toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
  });

  it("keeps Astryx's textbox role and patches aria-placeholder onto the editable in sync", () => {
    const { rerender } = renderPromptInput({ placeholder: "First hint" });

    const input = getPromptInput();
    expect(input).toHaveAttribute("role", "textbox");
    expect(input).toHaveAttribute("aria-placeholder", "First hint");

    rerender(
      <ChatPromptInput
        placeholder="Second hint"
        value=""
        onSubmit={() => {}}
      />,
    );
    expect(input).toHaveAttribute("aria-placeholder", "Second hint");
  });

  it("has no accent attribute by default, opting into the brand accent explicitly", () => {
    const { container: withoutAccent } = renderPromptInput();
    expect(
      withoutAccent.querySelector('[data-slot="prompt-input"]'),
    ).not.toHaveAttribute("data-accent");

    const { container: withAccent } = renderPromptInput({ accent: "brand" });
    expect(withAccent.querySelector('[data-slot="prompt-input"]')).toHaveAttribute(
      "data-accent",
      "brand",
    );
  });

  it("surfaces errors through the Astryx composer status", () => {
    renderPromptInput({ error: "Runtime rejected the prompt" });

    expect(screen.getByText("Runtime rejected the prompt")).toBeInTheDocument();
  });

  it("submits on Enter but does not clear the value itself", () => {
    const onSubmit = vi.fn();
    renderPromptInput({ value: "hello", onSubmit });
    const input = getPromptInput();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The caller owns clearing: with the value prop unchanged, the built-in
    // submit must not wipe the editable.
    expect(promptValue(input)).toBe("hello");
  });

  it("does not submit on Shift+Enter", () => {
    const onSubmit = vi.fn();
    renderPromptInput({ value: "hello", onSubmit });

    fireEvent.keyDown(getPromptInput(), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("preserves the draft on IME Enter ($isComposing, $keyCode)", (ime) => {
    const onSubmit = vi.fn();
    const onValueChange = vi.fn();
    renderPromptInput({ value: "你好", onSubmit, onValueChange });
    const input = getPromptInput();

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...ime,
    });
    fireEvent(input, event);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(promptValue(input)).toBe("你好");
    expect(event.defaultPrevented).toBe(false);

    fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "submits on Cmd/Ctrl+Enter ($ctrlKey)",
    (modifier) => {
      const onSubmit = vi.fn();
      renderPromptInput({ value: "hello", onSubmit });

      fireEvent.keyDown(getPromptInput(), { key: "Enter", ...modifier });

      expect(onSubmit).toHaveBeenCalledTimes(1);
    },
  );

  it("does not submit an empty value", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderPromptInput({ value: "   ", onSubmit });

    fireEvent.keyDown(getPromptInput(), { key: "Enter" });
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("marks the input disabled while running when lockInputOnRun is set", () => {
    renderPromptInput({ status: "streaming", lockInputOnRun: true });

    const input = getPromptInput();
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(input).toHaveAttribute("contenteditable", "false");
  });

  it("keeps the input editable while running when submits are allowed", () => {
    renderPromptInput({
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
    });

    const input = getPromptInput();
    expect(input).not.toHaveAttribute("aria-disabled");
    expect(input).toHaveAttribute("contenteditable", "true");
  });

  it("calls onStop instead of onSubmit when running with an empty value", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "",
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Send while running when attachments are present", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "",
      status: "streaming",
      allowSubmitWhileRunning: true,
      hasAttachments: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("submits while running when a value is present and submits are allowed", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "queued follow-up",
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("uses the Astryx send/stop accessible names", () => {
    renderPromptInput({ value: "go" });

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("forwards text edits through onValueChange", () => {
    const onValueChange = vi.fn();
    renderPromptInput({ onValueChange });

    typeIntoPrompt(getPromptInput(), "a");

    expect(onValueChange).toHaveBeenCalledWith("a");
  });

  it("echoes an externally set value into the editable", () => {
    function Harness() {
      const [value, setValue] = useState("before");
      return (
        <>
          <ChatPromptInput
            value={value}
            onSubmit={() => {}}
            onValueChange={setValue}
          />
          <button onClick={() => setValue("injected\ntext")}>inject</button>
        </>
      );
    }
    render(<Harness />);
    const input = getPromptInput();
    expect(promptValue(input)).toBe("before");

    fireEvent.click(screen.getByRole("button", { name: "inject" }));

    expect(promptValue(input)).toBe("injected\ntext");
  });

  it("focusAtEnd focuses the editable with the caret after the last character", () => {
    function Harness() {
      const ref = useRef<ChatPromptInputHandle | null>(null);
      return (
        <>
          <ChatPromptInput inputRef={ref} value="end here" onSubmit={() => {}} />
          <button onClick={() => ref.current?.focusAtEnd()}>focus end</button>
        </>
      );
    }
    render(<Harness />);
    const input = getPromptInput();

    fireEvent.click(screen.getByRole("button", { name: "focus end" }));

    expect(input).toHaveFocus();
    const selection = window.getSelection();
    expect(selection?.isCollapsed).toBe(true);
    const range = selection?.getRangeAt(0);
    expect(input.contains(range?.startContainer ?? null)).toBe(true);
  });

  it("renders a drawer above the input", () => {
    renderPromptInput({ drawer: <div>2 attachments</div> });

    expect(screen.getByText("2 attachments")).toBeInTheDocument();
  });

  it("submits an empty value when attachments are present", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ hasAttachments: true, onSubmit });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("forwards pasted files to onFiles", () => {
    const onFiles = vi.fn();
    const image = new File(["png"], "shot.png", { type: "image/png" });

    renderPromptInput({ onFiles });

    fireEvent.paste(getPromptInput(), {
      clipboardData: { files: [image] },
    });

    expect(onFiles).toHaveBeenCalledWith([image]);
  });

  it("pastes plain text without HTML", () => {
    const onValueChange = vi.fn();
    renderPromptInput({ value: "", onValueChange });

    fireEvent.paste(getPromptInput(), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? "plain paste" : "<b>html</b>",
      },
    });

    expect(onValueChange).toHaveBeenCalledWith("plain paste");
  });

  it("recedes the empty-state placeholder below composer chrome", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );
    const trigger = readFileSync(
      join(
        process.cwd(),
        "apps/desktop/src/entities/model/model-selector/model-selector-control.tsx",
      ),
      "utf8",
    );

    // Model selector sits on --color-text-secondary via text-muted; the
    // placeholder must use the next weaker Astryx step so the hint recedes.
    expect(trigger).toMatch(
      /className="[^"]*text-muted[^"]*"[\s\S]*?data-testid="model-thinking-trigger"/,
    );
    expect(css).toMatch(
      /\.prompt-input__input\s*>\s*\[aria-hidden="true"\]\s*\{[^}]*color:\s*var\(--color-text-disabled\)/,
    );
  });

  it("separates the input from the model-selector row by one extra spacing step", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.astryx-chat-composer\s*>\s*div:has\(\.prompt-input__input\)\s*\{[^}]*gap:\s*var\(--spacing-3\)/,
    );
  });

  it("tightens ChatComposer body padding by one spacing step", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.prompt-input\s+\.astryx-chat-composer\s*\{[^}]*--_chat-composer-padding:\s*var\(--spacing-2\)/,
    );
  });

  it("keeps the composer radius concentric with the circular send button", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    // Astryx: inner button radius = outer − padding. The md send button is
    // --size-element-md (32px), so a circle is half that. Outer must be
    // padding + that half, or the corner gutter pinches.
    expect(css).toMatch(
      /\.prompt-input\s+\.astryx-chat-composer\s*\{[^}]*--_chat-composer-radius:\s*calc\(\s*var\(--_chat-composer-padding\)\s*\+\s*var\(--size-element-md\)\s*\/\s*2\s*\)/,
    );
  });
});
