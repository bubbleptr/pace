import { Code } from "@astryxdesign/core/Code";
import { Markdown } from "@astryxdesign/core/Markdown";
import { createContext, useContext, type ComponentProps } from "react";
import {
  ChatFileLink,
  chatInsideLinkContext,
} from "@/shared/ui/chat/chat-file-link";

/**
 * Chat sits under the page h1 (Sessions / Trajectory / …). Markdown `#` must
 * not mint another top-level heading in the document outline.
 */
const chatHeadingLevelStart = 3;

/**
 * Inline-code spans confirmed to be real files in the Session checkout. A
 * context because the Astryx components map is a module constant — ChatInlineCode
 * cannot take the set as a prop without breaking that identity.
 */
const linkedInlineCodeContext = createContext<ReadonlySet<string> | undefined>(
  undefined,
);

/**
 * Astryx's default inline code sits at body size with zero vertical padding,
 * so its 18px chip fills a 20px line box and adjacent code-bearing lines
 * touch. Chat routes inline code through this override so chat.css can size
 * the chip against the chat prose leading; other Code usages stay default.
 */
function ChatInlineCode({ children }: { children: string }) {
  const linkedInlineCode = useContext(linkedInlineCodeContext);
  const insideLink = useContext(chatInsideLinkContext);
  const chip = (
    <Code className="chat-inline-code" data-slot="chat-inline-code">
      {children}
    </Code>
  );
  // CommonMark strips only one surrounding space from a code span, so the
  // text can still arrive padded; the confirmation set keys trimmed text.
  const text = typeof children === "string" ? children.trim() : children;
  // The span stays a real <a>: the host's click delegation resolves it like
  // any other chat link, and href keeps the :line suffix for that resolution.
  // A span already inside a link never gets a second nested anchor.
  if (!insideLink && typeof text === "string" && linkedInlineCode?.has(text)) {
    return (
      <a
        href={text}
        className="chat-inline-code-link"
        data-slot="chat-inline-code-link"
        title={text}
      >
        {chip}
      </a>
    );
  }
  return chip;
}

const chatMarkdownComponents = { inlineCode: ChatInlineCode };

// Module constants so the maps keep a stable identity across renders; the
// link override only joins in when the host opts into file links.
const chatMarkdownFileLinkComponents = {
  inlineCode: ChatInlineCode,
  link: ChatFileLink,
};

/**
 * Chat prose renders through Astryx Markdown (compact density, per the
 * official ai-chat template). Fenced code uses the Astryx built-in code
 * block; ChatCodeBlock stays only for non-markdown surfaces.
 */
type ChatMarkdownOwnProps = {
  children: string;
  /**
   * Render local file links as file-reference chips. Opt-in because the
   * chips only make sense where the page delegates their clicks to a file
   * surface — Live Chat does, other Markdown hosts have no such handling.
   */
  fileLinks?: boolean;
  /**
   * Inline-code spans confirmed to name real files (the host checks the
   * checkout and passes the surviving texts here); each renders as a link
   * around the code chip. Settled answers only — streaming never sets this.
   * Requires `fileLinks`: without our link renderer there is no inside-link
   * marker, so the set is ignored rather than risking nested anchors.
   */
  linkedInlineCode?: ReadonlySet<string>;
};

export type ChatMarkdownProps = Omit<ComponentProps<"div">, keyof ChatMarkdownOwnProps> &
  ChatMarkdownOwnProps;

export function ChatMarkdown({
  children,
  fileLinks = false,
  linkedInlineCode,
  className = "",
  ...rest
}: ChatMarkdownProps) {
  return (
    <div
      className={`chat-markdown ${className}`.trim()}
      data-slot="chat-markdown"
      data-testid="markdown-renderer"
      {...rest}
    >
      <linkedInlineCodeContext.Provider
        value={fileLinks ? linkedInlineCode : undefined}
      >
        <Markdown
          components={
            fileLinks ? chatMarkdownFileLinkComponents : chatMarkdownComponents
          }
          density="compact"
          headingLevelStart={chatHeadingLevelStart}
        >
          {children}
        </Markdown>
      </linkedInlineCodeContext.Provider>
    </div>
  );
}

/**
 * Streaming variant: Astryx isStreaming does incremental parsing with a
 * fade-in on new chunks — that animation is the in-progress affordance, so
 * there is no separate caret.
 */
type ChatStreamMarkdownOwnProps = {
  children: string;
  isStreaming?: boolean;
  /** See {@link ChatMarkdownProps}. */
  fileLinks?: boolean;
};

export type ChatStreamMarkdownProps = Omit<
  ComponentProps<"div">,
  keyof ChatStreamMarkdownOwnProps
> &
  ChatStreamMarkdownOwnProps;

export function ChatStreamMarkdown({
  children,
  isStreaming = false,
  fileLinks = false,
  className = "",
  ...rest
}: ChatStreamMarkdownProps) {
  return (
    <div
      className={`chat-markdown chat-markdown--stream ${className}`.trim()}
      data-is-streaming={String(Boolean(isStreaming))}
      data-slot="chat-stream-markdown"
      data-testid="stream-markdown-renderer"
      {...rest}
    >
      <Markdown
        components={
          fileLinks ? chatMarkdownFileLinkComponents : chatMarkdownComponents
        }
        density="compact"
        headingLevelStart={chatHeadingLevelStart}
        isStreaming={isStreaming}
      >
        {children}
      </Markdown>
    </div>
  );
}
