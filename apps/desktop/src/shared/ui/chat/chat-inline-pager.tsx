import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

/**
 * Inline one-line viewport with paced flips: the outgoing page rises out, the
 * incoming one enters from below. Used for step labels that change while the
 * step is live — the running tool's name, "Thinking…" turning into
 * "Thought 2s" (ADR-0030 §3).
 *
 * Inline on purpose: the block-level `.chain-of-thought__live` carries a top
 * margin that drops the label below the chevron's centre line once it sits
 * inside a trigger.
 */

/** Mirrors --cot-flip-duration in chat.css (ADR-0030 §8). Exit is
 *  --cot-flip-exit-duration (220ms); dwell follows the longer enter so the
 *  next flip cannot start while the incoming page is still moving. */
const FLIP_DURATION_MS = 300;
const DEFAULT_DWELL_MS = 700;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Page = { key: string; node: ReactNode };

type ChatInlinePagerOwnProps = {
  children: ReactNode;
  /** Minimum time a page is shown before the next one may replace it. */
  dwellMs?: number;
  pageKey?: string;
};

export type ChatInlinePagerProps = Omit<ComponentProps<"span">, keyof ChatInlinePagerOwnProps> &
  ChatInlinePagerOwnProps;

export function ChatInlinePager({
  children,
  className = "",
  dwellMs = DEFAULT_DWELL_MS,
  pageKey = "",
  ...rest
}: ChatInlinePagerProps) {
  // A dwell shorter than the enter would cut the incoming page off half-way.
  const dwell = Math.max(dwellMs, FLIP_DURATION_MS);
  const [shown, setShown] = useState<Page>({ key: pageKey, node: children });
  const [outgoing, setOutgoing] = useState<ReactNode>(null);
  const shownRef = useRef<Page>({ key: pageKey, node: children });
  const latestRef = useRef<Page>({ key: pageKey, node: children });
  const shownAtRef = useRef(Date.now());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = { key: pageKey, node: children };

    // Same page, new content (streaming args, a ticking duration): land it in
    // place rather than turning the page on itself. Rendered straight from
    // children below, so a parent re-render costs no extra commit.
    if (pageKey === shownRef.current.key) {
      shownRef.current = latestRef.current;
      return;
    }

    const flip = () => {
      const previous = shownRef.current;
      shownRef.current = latestRef.current;
      shownAtRef.current = Date.now();
      setShown(latestRef.current);
      // animation: none under reduced motion, so onAnimationEnd never fires.
      setOutgoing(prefersReducedMotion() ? null : previous.node);
    };

    // A flip is already scheduled; it will pick up whatever is latest then, so
    // pages that arrive during the wait are dropped instead of queued.
    if (timerRef.current !== null) {
      return;
    }

    const remaining = dwell - (Date.now() - shownAtRef.current);

    if (remaining <= 0) {
      flip();
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (latestRef.current.key !== shownRef.current.key) {
        flip();
      }
    }, remaining);
  }, [children, dwell, pageKey]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <span
      className={`chat-inline-pager ${className}`.trim()}
      data-slot="chat-inline-pager"
      {...rest}
    >
      <span className="chat-inline-pager__flip">
        {outgoing ? (
          <span className="chat-inline-pager__page" data-motion="out">
            {outgoing}
          </span>
        ) : null}
        <span
          className="chat-inline-pager__page"
          data-motion={outgoing ? "in" : undefined}
          onAnimationEnd={(event) => {
            // Exit is shorter than enter; clear outgoing when the incoming
            // page finishes so removing data-motion="in" cannot cut it off.
            if (event.target === event.currentTarget) {
              setOutgoing(null);
            }
          }}
        >
          {pageKey === shown.key ? children : shown.node}
        </span>
      </span>
    </span>
  );
}
