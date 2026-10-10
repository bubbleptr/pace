import { describe, expect, it } from "vitest";
import {
  formatBrowserComments,
  resolveCommentCropRect,
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

  it("prints an area comment with its bounds instead of an element rect", () => {
    expect(
      formatBrowserComments([
        comment({
          index: 1,
          hasImage: true,
          selector: "#panel",
          tag: "section",
          area: { x: 24, y: 12, width: 60, height: 30 },
          rect: { x: 36, y: 352, width: 60, height: 30 },
          comment: "move this down",
          source: { file: "src/hero.tsx", line: 4 },
        }),
        comment({
          id: "e2",
          index: 2,
          selector: "#panel",
          tag: "section",
          area: { x: 0, y: 0, width: 10, height: 10 },
          rect: { x: 40, y: 40, width: 10, height: 10 },
          comment: "no shot",
        }),
      ]),
    ).toBe(
      [
        "Browser comments from the embedded preview. A comment marked [screenshot] has a cropped screenshot of its element attached; those screenshots are the last images in this message, in comment order.",
        "",
        "Page: Alpha — http://localhost:5173/a",
        "Viewport: 684×820 @2x",
        "",
        "#1 [screenshot] area in `#panel` (section)",
        "  move this down",
        "  - source: `src/hero.tsx:4`",
        // The crop has margins and no drawn box, so the bounds are printed
        // in the screenshot's own coordinates as well as the viewport's —
        // the crop here was shifted by the left edge to (0, 267, 320, 200).
        "  - area: 60×30 at (36, 85) in its screenshot; (36, 352) in the viewport",
        "",
        "#2 area in `#panel` (section)",
        "  no shot",
        "  - area: 10×10 at (40, 40)",
      ].join("\n"),
    );
  });

  it("subtracts a crop the viewport edge shifted, not the margin it asked for", () => {
    expect(
      formatBrowserComments([
        comment({
          index: 1,
          hasImage: true,
          viewport: { width: 400, height: 600, dpr: 1 },
          area: { x: 4, y: 300, width: 40, height: 30 },
          rect: { x: 10, y: 400, width: 40, height: 30 },
          comment: "edge",
        }),
      ]),
    ).toBe(
      [
        "Browser comments from the embedded preview. A comment marked [screenshot] has a cropped screenshot of its element attached; those screenshots are the last images in this message, in comment order.",
        "",
        "Page: Alpha — http://localhost:5173/a",
        "Viewport: 400×600 @1x",
        "",
        "#1 [screenshot] area in `#cta` (button)",
        "  edge",
        // The crop wanted (-130, 315) but the edge pushed it to (0, 315):
        // in-screenshot is the rect minus what was actually captured.
        "  - area: 40×30 at (10, 85) in its screenshot; (10, 400) in the viewport",
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

describe("resolveCommentCropRect", () => {
  it("expands the element by 48px and grows to the minimum size", () => {
    expect(
      resolveCommentCropRect(
        { x: 400, y: 300, width: 40, height: 20 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 260, y: 210, width: 320, height: 200 });
  });

  it("keeps a large element's expanded bounds", () => {
    expect(
      resolveCommentCropRect(
        { x: 400, y: 300, width: 500, height: 400 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 352, y: 252, width: 596, height: 496 });
  });

  it("shifts an off-edge crop inside before shrinking it", () => {
    expect(
      resolveCommentCropRect(
        { x: 1380, y: 10, width: 40, height: 20 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 1120, y: 0, width: 320, height: 200 });
  });

  it("clips a crop bigger than the viewport to it", () => {
    expect(
      resolveCommentCropRect(
        { x: 100, y: 100, width: 900, height: 800 },
        { width: 400, height: 300 },
      ),
    ).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});
