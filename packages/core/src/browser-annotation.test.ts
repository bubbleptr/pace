import { describe, expect, it } from "vitest";
import {
  formatBrowserComments,
  type BrowserComment,
} from "./browser-annotation";

/**
 * The template is the contract Pi reads, so these assertions are the whole
 * string rather than fragments of it.
 */
function comment(overrides: Partial<BrowserComment>): BrowserComment {
  return {
    id: "e1",
    index: 1,
    selector: "#cta",
    tag: "button",
    rect: { x: 12, y: 340, width: 120, height: 40 },
    tabId: "t1",
    url: "http://localhost:5173/a",
    title: "Alpha",
    viewport: { width: 684, height: 820, dpr: 2 },
    stale: false,
    hasImage: false,
    createdAt: "2026-10-10T09:00:00.000Z",
    ...overrides,
  };
}

describe("formatBrowserComments", () => {
  it("renders every run of page context, field lines in order, and multiline comments", () => {
    expect(
      formatBrowserComments([
        comment({
          index: 1,
          hasImage: true,
          comment: "The label is clipped\n\non narrow panels\n",
          text: "Get started",
          source: { file: "src/pricing.tsx", line: 42, column: 7 },
        }),
        comment({
          id: "e2",
          index: 2,
          selector: "#nav",
          tag: "nav",
          url: "http://localhost:5173/b",
          title: "Beta",
          viewport: { width: 684, height: 820, dpr: 2 },
          comment: "second page",
        }),
        comment({
          id: "e3",
          index: 3,
          selector: ".card",
          tag: "article",
          rect: { x: 20, y: 600, width: 200, height: 120 },
          stale: true,
          comment: "was here when I marked it",
        }),
      ]),
    ).toBe(
      [
        "Browser comments from the embedded preview. A comment marked [screenshot] has a cropped screenshot of its element attached; those screenshots are the last images in this message, in comment order.",
        "",
        "Page: Alpha — http://localhost:5173/a",
        "Viewport: 684×820 @2x",
        "",
        "#1 [screenshot] `#cta` (button)",
        "  The label is clipped",
        "  on narrow panels",
        '  - text: "Get started"',
        "  - source: `src/pricing.tsx:42:7`",
        "",
        "Page: Beta — http://localhost:5173/b",
        "Viewport: 684×820 @2x",
        "",
        "#2 `#nav` (nav)",
        "  second page",
        "  - rect: 120×40 at (12, 340)",
        "",
        "Page: Alpha — http://localhost:5173/a",
        "Viewport: 684×820 @2x",
        "",
        "#3 `.card` (article)",
        "  was here when I marked it",
        "  - rect: 200×120 at (20, 600)",
        "  - stale: not found on the page when last checked; described as it was when saved",
      ].join("\n"),
    );
  });

  it("drops the screenshot claim when no comment carries an image", () => {
    expect(
      formatBrowserComments([comment({ comment: "no shot" })]),
    ).toBe(
      [
        "Browser comments from the embedded preview.",
        "",
        "Page: Alpha — http://localhost:5173/a",
        "Viewport: 684×820 @2x",
        "",
        "#1 `#cta` (button)",
        "  no shot",
        "  - rect: 120×40 at (12, 340)",
      ].join("\n"),
    );
  });

  it("prints the page without a title and a comment without text", () => {
    expect(
      formatBrowserComments([
        comment({ title: "", comment: undefined }),
      ]),
    ).toBe(
      [
        "Browser comments from the embedded preview.",
        "",
        "Page: http://localhost:5173/a",
        "Viewport: 684×820 @2x",
        "",
        "#1 `#cta` (button)",
        "  (no comment)",
        "  - rect: 120×40 at (12, 340)",
      ].join("\n"),
    );
  });
});
