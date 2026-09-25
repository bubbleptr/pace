import {
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  ChatSendButton,
} from "@astryxdesign/core/Chat";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type ChatPromptInputHandle = {
  focus(): void;
  /** Focus and put the caret after the last character. */
  focusAtEnd(): void;
};

function editableOf(root: HTMLDivElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[aria-multiline="true"]') ?? null;
}

/**
 * Astryx contentEditable composer input. Submit is intercepted in onKeyDown
 * (the built-in Enter path force-clears the value before the caller can
 * keep a failed draft), and the component's a11y gaps are patched locally —
 * no swizzle.
 */
function PromptComposerInput({
  disabled = false,
  placeholder,
  inputRef,
  onFiles,
  onSubmitRequest,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  onFiles?: (files: File[]) => void;
  onSubmitRequest: () => void;
  value: string;
  onValueChange?: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ChatComposerInputHandle | null>(null);

  useEffect(() => {
    if (!inputRef) {
      return;
    }

    inputRef.current = {
      focus: () => composerRef.current?.focus(),
      focusAtEnd: () => {
        const editable = editableOf(rootRef.current);
        if (!editable) {
          return;
        }
        editable.focus();
        const selection = window.getSelection();
        if (!selection) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      },
    };
    return () => {
      inputRef.current = null;
    };
  }, [inputRef]);

  useEffect(() => {
    // Astryx 0.3.0 puts only aria-multiline/aria-label on the editable and
    // no role at all, while E2E and screen readers locate the composer by
    // the textbox role. Patch the missing attributes here instead of
    // swizzling the component.
    const editable = editableOf(rootRef.current);
    if (!editable) {
      return;
    }
    editable.setAttribute("role", "textbox");
    if (placeholder) {
      editable.setAttribute("aria-placeholder", placeholder);
    } else {
      editable.removeAttribute("aria-placeholder");
    }
    if (disabled) {
      editable.setAttribute("aria-disabled", "true");
    } else {
      editable.removeAttribute("aria-disabled");
    }
  }, [placeholder, disabled]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME confirmation belongs to text entry; 229 covers composition ending before keydown.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    // Shift+Enter inserts a newline; Enter and Cmd/Ctrl+Enter submit.
    if (event.shiftKey) {
      return;
    }

    event.preventDefault();
    // Submit through our own path: the composer's built-in Enter handler
    // clears the editable itself, but the caller owns clearing (a failed
    // submit must keep the draft). defaultPrevented keeps the built-in
    // path from running.
    onSubmitRequest();
  };

  return (
    <ChatComposerInput
      ref={rootRef}
      className="prompt-input__input"
      handleRef={composerRef}
      hasHistory={false}
      isDisabled={disabled}
      label="Prompt"
      pasteAsToken={false}
      placeholder={placeholder}
      value={value}
      onChange={onValueChange}
      onFiles={onFiles}
      onKeyDown={handleKeyDown}
    />
  );
}

/**
 * Prompt composer over Astryx ChatComposer. The shell, slot layout, send/stop
 * button, and error status are Astryx; so is the rich input, which keeps the
 * caller-owned submit/clear contract through the onKeyDown seam. The neutral
 * footer hint is ours (Astryx status only carries error/warning).
 */
type ChatPromptInputOwnProps = {
  value: string;
  status?: PromptInputStatus;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  allowSubmitWhileRunning?: boolean;
  lockInputOnRun?: boolean;
  startActions?: ReactNode;
  endActions?: ReactNode;
  drawer?: ReactNode;
  /**
   * One row of chrome under the composer — where the Session runs, its branch,
   * the context ring. It keeps its height whatever it holds, so a Session
   * Draft and a Live Session composer are the same size (docs/design/chat.md).
   */
  footer?: ReactNode;
  error?: string | null;
  hasAttachments?: boolean;
  /**
   * Opt-in Pi-mark border (docs/design/brand.md): a 1px coral/yellow/blue
   * gradient ring that appears on focus and animates while `status` is
   * submitted/streaming. Undeclared by default so every composer but the
   * session-draft empty state keeps its plain border.
   */
  accent?: "brand";
  /**
   * Show the static ring on focus as well. Reserved for the session-draft
   * empty state, where the composer is the page; inside a Session the ring
   * only marks a run in flight, so focus leaves it transparent.
   */
  accentFocusRing?: boolean;
  onSubmit?: () => void;
  onStop?: () => void;
  onValueChange?: (value: string) => void;
  onFiles?: (files: File[]) => void;
};

export type ChatPromptInputProps = Omit<
  ComponentProps<"div">,
  keyof ChatPromptInputOwnProps | "children"
> &
  ChatPromptInputOwnProps;

export function ChatPromptInput({
  value,
  status = "ready",
  className = "",
  placeholder,
  inputRef,
  allowSubmitWhileRunning = false,
  lockInputOnRun = false,
  startActions,
  endActions,
  drawer,
  footer,
  error,
  hasAttachments = false,
  accent,
  accentFocusRing = false,
  onSubmit,
  onStop,
  onValueChange,
  onFiles,
  ...rest
}: ChatPromptInputProps) {
  const isRunning = status === "streaming" || status === "submitted";
  const isStopShown = isRunning && !value.trim() && !hasAttachments && Boolean(onStop);
  const canSubmit =
    (Boolean(value.trim()) || hasAttachments) &&
    (!isRunning || allowSubmitWhileRunning);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit?.();
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current -= 1;

    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    onFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className={`prompt-input ${className}`.trim()}
      data-accent={accent}
      data-accent-focus={accent && accentFocusRing ? "" : undefined}
      data-drop={dragging ? "" : undefined}
      data-slot="prompt-input"
      data-status={status}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...rest}
    >
      <ChatComposer
        drawer={drawer}
        elevation="low"
        footerActions={startActions}
        input={
          <PromptComposerInput
            disabled={lockInputOnRun && isRunning}
            inputRef={inputRef}
            placeholder={placeholder}
            value={value}
            onValueChange={onValueChange}
            onFiles={onFiles}
            onSubmitRequest={handleSubmit}
          />
        }
        isStopShown={isStopShown}
        placeholder={placeholder}
        sendActions={endActions}
        sendButton={
          <ChatSendButton
            className="pigui-pressable"
            isDisabled={!isStopShown && !canSubmit}
            // Bypass the composer's submit path, which force-clears the value.
            onSend={handleSubmit}
          />
        }
        status={error ? { type: "error", message: error } : undefined}
        value={value}
        onChange={(next) => onValueChange?.(next)}
        onStop={onStop}
        onSubmit={handleSubmit}
      />
      {footer ? (
        <div className="prompt-input__footer" data-slot="prompt-input-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
