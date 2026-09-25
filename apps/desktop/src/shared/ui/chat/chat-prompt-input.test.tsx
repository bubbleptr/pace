import { type ReactNode, useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ChatPromptInput,
  type ChatPromptInputHandle,
} from "@/shared/ui/chat/chat-prompt-input";
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import {
  getPromptInput,
  promptValue,
  typeIntoPrompt,
} from "@/test/prompt-input";

/**
 * leadingTokenFor over a fixed catalog, mirroring leadingCommandMatch's
 * word-boundary rule (end, space, or NBSP — so "/review" matches inside
 * "/review-pr" only at a boundary, and a bare "/review" at end counts).
 */
function makeLeadingMatch(...invocations: string[]) {
  return (value: string) => {
    for (const invocation of invocations) {
      const head = `/${invocation}`;
      if (!value.startsWith(head)) {
        continue;
      }
      const next = value.charAt(head.length);
      if (next === "") {
        return { length: head.length, token: { value: head, label: head } };
      }
      if (next === " " || next === "\u00A0") {
        return { length: head.length + 1, token: { value: head, label: head } };
      }
    }
    return null;
  };
}

function renderPromptInput({
  value = "",
  status,
  placeholder = "Type here",
  allowSubmitWhileRunning,
  lockInputOnRun,
  hasAttachments,
  drawer,
  accent,
  triggers,
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
  triggers?: ChatComposerTrigger[];
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
      triggers={triggers}
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

  it("keeps a stable combobox role and patches aria-placeholder onto the editable in sync", () => {
    const { rerender } = renderPromptInput({ placeholder: "First hint" });

    const input = getPromptInput();
    // A placeholder trigger keeps the role combobox even when no caller
    // trigger is active, so it never flips between textbox and combobox.
    expect(input).toHaveAttribute("role", "combobox");
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

  it("keeps the combobox role when the caller's trigger list is empty", () => {
    renderPromptInput({ triggers: [] });

    expect(getPromptInput()).toHaveAttribute("role", "combobox");
  });

  it("insertLeadingToken inserts a token before existing text and emits the value", () => {
    const onValueChange = vi.fn();
    const inputRef = { current: null as ChatPromptInputHandle | null };
    function Harness() {
      const [value, setValue] = useState("原文本");
      return (
        <ChatPromptInput
          inputRef={inputRef}
          value={value}
          onSubmit={() => {}}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    const input = getPromptInput();

    act(() => {
      inputRef.current!.insertLeadingToken({ value: "/x", label: "/x" });
    });

    expect(onValueChange).toHaveBeenCalledWith("/x\u00A0原文本");
    expect(promptValue(input)).toBe("/x\u00A0原文本");
    expect(input.firstElementChild).toHaveAttribute("data-astryx-token-value", "/x");
    expect(input).toHaveFocus();
  });

  it("insertLeadingToken replaces the previous leading token and keeps the suffix", () => {
    const inputRef = { current: null as ChatPromptInputHandle | null };
    function Harness() {
      const [value, setValue] = useState("keep this");
      return (
        <ChatPromptInput
          inputRef={inputRef}
          value={value}
          onSubmit={() => {}}
          onValueChange={setValue}
        />
      );
    }
    render(<Harness />);
    const input = getPromptInput();

    act(() => {
      inputRef.current!.insertLeadingToken({ value: "/a", label: "/a" });
    });
    act(() => {
      inputRef.current!.insertLeadingToken({ value: "/b", label: "/b" });
    });

    expect(promptValue(input)).toBe("/b\u00A0keep this");
    expect(input.querySelectorAll("[data-astryx-token]")).toHaveLength(1);
  });

  it("leadingTokenFor rehydrates a leading command string into a token once", () => {
    const onValueChange = vi.fn();
    const leadingTokenFor = (value: string) =>
      value.startsWith("/skill:a ")
        ? { length: "/skill:a ".length, token: { value: "/skill:a", label: "a" } }
        : null;
    function Harness() {
      const [value, setValue] = useState("/skill:a hi");
      return (
        <ChatPromptInput
          leadingTokenFor={leadingTokenFor}
          value={value}
          onSubmit={() => {}}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    const input = getPromptInput();

    expect(input.firstElementChild).toHaveAttribute(
      "data-astryx-token-value",
      "/skill:a",
    );
    expect(promptValue(input)).toBe("/skill:a\u00A0hi");
    // The rehydration emits exactly one change; once the leading token
    // exists the effect leaves the DOM alone.
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("/skill:a\u00A0hi");
  });

  it("does not tokenize a command while the user is still typing it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ChatPromptInput
          leadingTokenFor={makeLeadingMatch("review", "review-pr")}
          value={value}
          onSubmit={() => {}}
          onValueChange={setValue}
        />
      );
    }
    render(<Harness />);
    const input = getPromptInput();

    act(() => input.focus());
    // "/review" is a complete command once the "w" lands, but the user is
    // on their way to "/review-pr" — typed text must stay text.
    await user.keyboard("/review-pr hi");

    expect(promptValue(input)).toBe("/review-pr hi");
    expect(input.querySelector("[data-astryx-token]")).toBeNull();
  });

  it("still rehydrates when the catalog resolves after the draft landed", () => {
    // Both relevant props flip in one commit — the trigger list swapping in
    // fires the re-dispatch effect first, and its emit must not make the
    // rehydrate effect mistake the restored draft for user typing.
    const slash = (names: string[]): ChatComposerTrigger => ({
      character: "/",
      searchSource: createStaticSource(
        names.map((name) => ({ id: name, label: `/${name}` })),
      ),
      onSelect: () => "",
    });
    function Harness({ loaded }: { loaded: boolean }) {
      const [value, setValue] = useState("/skill:x hi");
      return (
        <ChatPromptInput
          leadingTokenFor={loaded ? makeLeadingMatch("skill:x") : undefined}
          triggers={loaded ? [slash(["skill:x"])] : []}
          value={value}
          onSubmit={() => {}}
          onValueChange={setValue}
        />
      );
    }
    const { rerender } = render(<Harness loaded={false} />);
    const input = getPromptInput();
    expect(promptValue(input)).toBe("/skill:x hi");

    rerender(<Harness loaded />);

    expect(input.firstElementChild).toHaveAttribute(
      "data-astryx-token-value",
      "/skill:x",
    );
    expect(promptValue(input)).toBe("/skill:x\u00A0hi");
  });

  it("rehydrates a leading token after an external write flattened it", () => {
    function Harness() {
      const [value, setValue] = useState("hi");
      return (
        <>
          <ChatPromptInput
            leadingTokenFor={makeLeadingMatch("skill:x")}
            value={value}
            onSubmit={() => {}}
            onValueChange={setValue}
          />
          <button onClick={() => setValue("/skill:x hi")}>inject</button>
        </>
      );
    }
    render(<Harness />);
    const input = getPromptInput();
    expect(promptValue(input)).toBe("hi");

    fireEvent.click(screen.getByRole("button", { name: "inject" }));

    expect(input.firstElementChild).toHaveAttribute(
      "data-astryx-token-value",
      "/skill:x",
    );
    expect(promptValue(input)).toBe("/skill:x\u00A0hi");
  });

  it("leaves command text alone after the user deletes the token and retypes it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState("/skill:x hi");
      return (
        <ChatPromptInput
          leadingTokenFor={makeLeadingMatch("skill:x")}
          value={value}
          onSubmit={() => {}}
          onValueChange={setValue}
        />
      );
    }
    render(<Harness />);
    const input = getPromptInput();
    expect(input.firstElementChild).toHaveAttribute(
      "data-astryx-token-value",
      "/skill:x",
    );

    // The user deletes the token (and the NBSP insertToken left behind),
    // then retypes the same command as plain text.
    input.querySelector("[data-astryx-token]")!.remove();
    input.textContent = "hi";
    fireEvent.input(input);
    const text = input.firstChild!;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => input.focus());
    await user.keyboard("/skill:x ");

    expect(promptValue(input)).toBe("/skill:x hi");
    expect(input.querySelector("[data-astryx-token]")).toBeNull();
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
