import {
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerToken,
  type ChatComposerTrigger,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import { createStaticSource } from "@astryxdesign/core/Typeahead";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type ChatPromptInputHandle = {
  focus(): void;
  /** Focus and put the caret after the last character. */
  focusAtEnd(): void;
  /**
   * Insert a token at the very start of the input, replacing the current
   * leading token (if any) and keeping the rest of the text.
   */
  insertLeadingToken(token: ChatComposerToken): void;
};

export type LeadingTokenMatch = {
  /** Characters of leading plain text the token replaces. */
  length: number;
  token: ChatComposerToken;
};

function editableOf(root: HTMLDivElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[aria-multiline="true"]') ?? null;
}

/** First child that isn't an empty text node (deletions leave those behind). */
function firstMeaningfulChild(editable: HTMLElement): ChildNode | null {
  let node = editable.firstChild;
  while (node && node.nodeType === Node.TEXT_NODE && node.textContent === "") {
    node = node.nextSibling;
  }
  return node;
}

function isTokenSpan(node: ChildNode | null): node is HTMLElement {
  return node instanceof HTMLElement && node.hasAttribute("data-astryx-token");
}

function placeCaretAtStart(editable: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.setStart(editable, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A trigger that can never fire — its character is the invisible separator
 * (U+2063), which keyboards cannot type. Astryx derives the editable's role
 * from the trigger list (textbox when empty, combobox otherwise), so callers
 * toggling their own triggers would make the role flicker mid-typing; this
 * placeholder pins it to combobox.
 */
const PLACEHOLDER_TRIGGER: ChatComposerTrigger = {
  character: "\u2063",
  searchSource: createStaticSource([]),
  onSelect: () => "",
};

/**
 * Astryx contentEditable composer input. Submit is intercepted in onKeyDown
 * (the built-in Enter path force-clears the value before the caller can
 * keep a failed draft), and the missing placeholder/disabled attributes are
 * patched locally — no swizzle. The role stays Astryx-owned: useTriggerMenu
 * spreads a React-managed `role` (textbox, or combobox when triggers exist)
 * onto the editable, so setting one from an effect would fight React.
 */
function PromptComposerInput({
  disabled = false,
  placeholder,
  inputRef,
  leadingTokenFor,
  triggers,
  onFiles,
  onSubmitRequest,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  /**
   * Turn the leading characters of a serialized value back into a token —
   * restores command tokens after draft loads or external writes, where
   * Astryx's textContent sync flattened them to text.
   */
  leadingTokenFor?: (value: string) => LeadingTokenMatch | null;
  triggers?: ChatComposerTrigger[];
  onFiles?: (files: File[]) => void;
  onSubmitRequest: () => void;
  value: string;
  onValueChange?: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ChatComposerInputHandle | null>(null);
  // The last value emitted by a real user input event. The rehydrate effect
  // below uses it to tell typed text from an external write: an emitted
  // value echoing back through the `value` prop is typing in progress, and
  // must never be turned into a token mid-word.
  const lastUserValueRef = useRef<string | undefined>(undefined);
  // Synthetic input events we dispatch ourselves (the trigger-refresh
  // re-dispatch, insertLeadingToken, the rehydrate effect) replay the
  // caller's value — flagging them keeps them out of lastUserValueRef.
  const syntheticInputRef = useRef(false);
  const dispatchSyntheticInput = (editable: HTMLElement) => {
    syntheticInputRef.current = true;
    try {
      // dispatchEvent delivers listeners synchronously, so the flag covers
      // the composer's emitChange.
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      syntheticInputRef.current = false;
    }
  };
  const effectiveTriggers = useMemo(
    () => (triggers?.length ? triggers : [PLACEHOLDER_TRIGGER]),
    [triggers],
  );

  // Astryx only searches a trigger's source on input events, so a catalog
  // that resolves while the menu is already open ("/" typed before
  // list_prompt_commands returned) would stay empty forever. Re-dispatching
  // input on trigger-list change re-runs detection against the fresh
  // trigger; upstream the emit is a no-op because the serialized value is
  // unchanged. Skipped on mount — the input event there would be a spurious
  // onValueChange for a value the caller just rendered.
  //
  // Ordering matters: this effect is declared before the rehydrate effect
  // below, so when a catalog arrives alongside a restored draft the
  // re-dispatch runs first. Because the synthetic emit stays out of
  // lastUserValueRef, rehydrate in the same commit still sees the draft as
  // an external value and restores its leading token.
  const mountedTriggers = useRef(effectiveTriggers);
  useEffect(() => {
    if (mountedTriggers.current === effectiveTriggers) {
      return;
    }
    mountedTriggers.current = effectiveTriggers;
    const editable = editableOf(rootRef.current);
    if (editable) {
      dispatchSyntheticInput(editable);
    }
  }, [effectiveTriggers]);

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
      insertLeadingToken: (token) => {
        const editable = editableOf(rootRef.current);
        if (!editable) {
          return;
        }
        // Drop the existing leading token and the NBSP insertToken added
        // after it — a command slot holds exactly one token.
        const first = firstMeaningfulChild(editable);
        if (isTokenSpan(first)) {
          const next = first.nextSibling;
          if (next?.nodeType === Node.TEXT_NODE && next.textContent === "\u00A0") {
            next.remove();
          }
          first.remove();
        }
        placeCaretAtStart(editable);
        composerRef.current?.insertToken(token);
        // insertToken only mutates the DOM; the input event makes the
        // composer serialize and emit the new value.
        dispatchSyntheticInput(editable);
        editable.focus();
      },
    };
    return () => {
      inputRef.current = null;
    };
  }, [inputRef]);

  useEffect(() => {
    if (!leadingTokenFor) {
      return;
    }
    // A value identical to the last user-driven emit is typing echoing back
    // through the controlled prop, not an external write — rehydrating it
    // would trap "/review" into a token while the user is still typing
    // "/review-pr".
    if (value === lastUserValueRef.current) {
      return;
    }
    const editable = editableOf(rootRef.current);
    if (!editable || isTokenSpan(firstMeaningfulChild(editable))) {
      return;
    }
    const match = leadingTokenFor(value);
    if (!match) {
      return;
    }
    // External writes land as a single text node (textContent = value). If
    // the leading text isn't one such node — e.g. it spans a <br> — leave it
    // as text rather than corrupting the DOM.
    const head = firstMeaningfulChild(editable);
    if (
      !head ||
      head.nodeType !== Node.TEXT_NODE ||
      (head.textContent?.length ?? 0) < match.length
    ) {
      return;
    }
    const range = document.createRange();
    range.setStart(head, 0);
    range.setEnd(head, match.length);
    range.deleteContents();
    const selection = window.getSelection();
    if (selection) {
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    composerRef.current?.insertToken(match.token);
    dispatchSyntheticInput(editable);
  }, [value, leadingTokenFor]);

  useEffect(() => {
    // Astryx 0.3.0 sets aria-multiline/aria-label (and the role, via
    // useTriggerMenu's ariaProps) on the editable, but the placeholder lives
    // on a separate aria-hidden div and disabled state only flips
    // contentEditable. E2E and assistive tech look for aria-placeholder and
    // aria-disabled on the editable, so patch those here instead of
    // swizzling the component.
    const editable = editableOf(rootRef.current);
    if (!editable) {
      return;
    }
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
      triggers={effectiveTriggers}
      value={value}
      onChange={(next) => {
        if (!syntheticInputRef.current) {
          lastUserValueRef.current = next;
        }
        onValueChange?.(next);
      }}
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
  /**
   * Trigger menus (e.g. "/" commands) passed through to ChatComposerInput.
   * May be empty — a placeholder trigger keeps the editable's role pinned
   * to combobox so it never flips mid-typing.
   */
  triggers?: ChatComposerTrigger[];
  /**
   * Rehydrate a leading command string into a token after external writes
   * (draft restore, injection) — see PromptComposerInput.
   */
  leadingTokenFor?: (value: string) => LeadingTokenMatch | null;
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
  triggers,
  leadingTokenFor,
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
            leadingTokenFor={leadingTokenFor}
            placeholder={placeholder}
            triggers={triggers}
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
