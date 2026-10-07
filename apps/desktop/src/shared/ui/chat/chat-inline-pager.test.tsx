import { Profiler } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInlinePager } from "@/shared/ui/chat/chat-inline-pager";

function useReducedMotion() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

describe("ChatInlinePager", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  // The block-level .chain-of-thought__live carries an 8px top margin, which
  // drops the label 4px below the chevron's centre line when it sits inside a
  // trigger. This container exists to be inline; the tag is that contract.
  it("renders as an inline span so it can sit inside a trigger", () => {
    const { container } = render(<ChatInlinePager pageKey="a">Running bash…</ChatInlinePager>);

    const pager = container.querySelector('[data-slot="chat-inline-pager"]');

    expect(pager?.tagName).toBe("SPAN");
    expect(pager).not.toHaveClass("chain-of-thought__live");
  });

  it("flips once to the latest page when keys change inside the dwell window", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(<ChatInlinePager pageKey="a">A</ChatInlinePager>);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<ChatInlinePager pageKey="b">B</ChatInlinePager>);
    rerender(<ChatInlinePager pageKey="c">C</ChatInlinePager>);

    // Still inside the minimum dwell: the first page holds, nothing animates.
    expect(container.querySelector("[data-motion]")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(container.querySelector('[data-motion="out"]')).toHaveTextContent("A");
    expect(container.querySelector('[data-motion="in"]')).toHaveTextContent("C");
    expect(screen.queryByText("B")).not.toBeInTheDocument();
  });

  it("clamps the dwell to the flip duration so a page is never cut off mid-flip", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(
      <ChatInlinePager dwellMs={0} pageKey="a">
        A
      </ChatInlinePager>,
    );

    rerender(
      <ChatInlinePager dwellMs={0} pageKey="b">
        B
      </ChatInlinePager>,
    );

    expect(container.querySelector("[data-motion]")).not.toBeInTheDocument();

    // Enter is 300ms; exit is 220ms. Dwell follows the longer enter.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(container.querySelector('[data-motion="in"]')).toHaveTextContent("B");
  });

  it("updates the page in place when the key is unchanged", () => {
    const { container, rerender } = render(
      <ChatInlinePager pageKey="running:1">Running bash…</ChatInlinePager>,
    );

    rerender(<ChatInlinePager pageKey="running:1">Running bash script…</ChatInlinePager>);

    expect(container.querySelector("[data-motion]")).not.toBeInTheDocument();
    expect(screen.getByText("Running bash script…")).toBeInTheDocument();
  });

  // A parent re-render with the same page key used to cost a second commit
  // from the pager's passive effect — under dense Session events that extra
  // commit per event is what let React's nested-update counter overflow (React error #185).
  it("lands same-page content without an extra commit", () => {
    let commits = 0;
    const { rerender } = render(
      <Profiler id="pager" onRender={() => { commits += 1; }}>
        <ChatInlinePager pageKey="running:1">Running bash…</ChatInlinePager>
      </Profiler>,
    );

    commits = 0;
    for (const label of ["Running bash script…", "Running bash -lc…", "Running test…"]) {
      rerender(
        <Profiler id="pager" onRender={() => { commits += 1; }}>
          <ChatInlinePager pageKey="running:1">{label}</ChatInlinePager>
        </Profiler>,
      );
    }

    expect(commits).toBe(3);
    expect(screen.getByText("Running test…")).toBeInTheDocument();
  });

  it("swaps pages without motion when reduced motion is preferred", () => {
    vi.useFakeTimers();
    useReducedMotion();

    const { container, rerender } = render(<ChatInlinePager pageKey="a">A</ChatInlinePager>);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    rerender(<ChatInlinePager pageKey="b">B</ChatInlinePager>);

    expect(container.querySelector("[data-motion]")).not.toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });
});
