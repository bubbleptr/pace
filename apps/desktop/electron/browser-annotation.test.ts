import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptBrowserAnnotationMessage,
  buildElementSelector,
  describeAnnotatedArea,
  describeAnnotatedElement,
  readAnnotationPalette,
  resolveAnnotationTarget,
} from "./browser-annotation";

function mount(html: string) {
  document.body.innerHTML = html;
}

/** The one property every selector must have, whatever strategy produced it. */
function resolvesUniquelyTo(selector: string, element: Element) {
  const matches = document.querySelectorAll(selector);

  return matches.length === 1 && matches[0] === element;
}

describe("buildElementSelector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prefers the element's own id", () => {
    mount('<main><button id="cta">Go</button></main>');

    const element = document.getElementById("cta")!;

    expect(buildElementSelector(element)).toBe("#cta");
    expect(resolvesUniquelyTo(buildElementSelector(element), element)).toBe(true);
  });

  it("escapes an id that is not a bare CSS identifier", () => {
    mount('<main><button id="2:col.x">Go</button></main>');

    const element = document.querySelector("button")!;

    expect(resolvesUniquelyTo(buildElementSelector(element), element)).toBe(true);
  });

  it("skips a duplicated id, which cannot identify anything", () => {
    mount('<p id="dup">first</p><p id="dup" data-testid="second">second</p>');

    const element = document.querySelectorAll("p")[1]!;
    const selector = buildElementSelector(element);

    expect(selector).not.toContain("#dup");
    expect(resolvesUniquelyTo(selector, element)).toBe(true);
  });

  it("uses data-testid when there is no usable id", () => {
    mount('<form><input data-testid="email" /></form>');

    const element = document.querySelector("input")!;

    expect(buildElementSelector(element)).toBe('[data-testid="email"]');
    expect(resolvesUniquelyTo(buildElementSelector(element), element)).toBe(true);
  });

  it("escapes a data-testid, which the page can put anything into", () => {
    mount('<form><input data-testid="two\nlines" /></form>');

    const element = document.querySelector("input")!;
    const selector = buildElementSelector(element);

    // A raw newline is a parse error inside a CSS string: unescaped, this
    // selector is not merely ugly, it is unusable — Chromium throws on it and
    // jsdom quietly matches nothing — so the testid stops anchoring anything.
    expect(selector).toContain("data-testid");
    expect(selector).not.toContain("\n");
    expect(resolvesUniquelyTo(selector, element)).toBe(true);
  });

  it("falls back to an nth-of-type chain anchored at the nearest identified ancestor", () => {
    mount('<section id="list"><ul><li>a</li><li>b</li><li>c</li></ul></section>');

    const element = document.querySelectorAll("li")[1]!;
    const selector = buildElementSelector(element);

    expect(selector.startsWith("#list")).toBe(true);
    expect(resolvesUniquelyTo(selector, element)).toBe(true);
  });

  it("reaches an element with no identified ancestor at all", () => {
    mount("<div><span>a</span><span>b</span></div>");

    const element = document.querySelectorAll("span")[1]!;

    expect(resolvesUniquelyTo(buildElementSelector(element), element)).toBe(true);
  });

  it("counts siblings by type, so a mixed parent still resolves", () => {
    mount("<div><p>a</p><span>b</span><p>c</p></div>");

    const element = document.querySelectorAll("p")[1]!;

    expect(resolvesUniquelyTo(buildElementSelector(element), element)).toBe(true);
  });
});

describe("describeAnnotatedElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reports the tag, the index it was given and a resolving selector", () => {
    mount('<main><button id="cta">Go</button></main>');

    const element = document.getElementById("cta")!;
    const annotation = describeAnnotatedElement(element, 3, "d1");

    expect(annotation.index).toBe(3);
    expect(annotation.tag).toBe("button");
    expect(annotation.selector).toBe("#cta");
    expect(annotation.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("collapses whitespace and truncates long text", () => {
    mount(`<p id="copy">${"word ".repeat(60)}</p>`);

    const annotation = describeAnnotatedElement(document.getElementById("copy")!, 1, "d1");

    expect(annotation.text!.length).toBeLessThanOrEqual(120);
    expect(annotation.text!.endsWith("…")).toBe(true);
    expect(annotation.text!.startsWith("word word")).toBe(true);
  });

  it("keeps short text verbatim and omits it when there is none", () => {
    mount('<p id="copy">  Hello\n  world  </p><img id="pic" alt="" />');

    expect(describeAnnotatedElement(document.getElementById("copy")!, 1, "d1").text).toBe(
      "Hello world",
    );
    expect(describeAnnotatedElement(document.getElementById("pic")!, 2, "d2")).not.toHaveProperty(
      "text",
    );
  });

  it("reads a source location from data-source", () => {
    mount('<b id="tagged" data-source="src/pages/app.tsx:12:5">x</b>');

    expect(describeAnnotatedElement(document.getElementById("tagged")!, 1, "d1").source).toEqual({
      file: "src/pages/app.tsx",
      line: 12,
      column: 5,
    });
  });

  it("reads a source location from the inspector attributes", () => {
    mount(
      '<b id="tagged" data-inspector-relative-path="src/app.tsx" data-inspector-line="7">x</b>',
    );

    expect(describeAnnotatedElement(document.getElementById("tagged")!, 1, "d1").source).toEqual({
      file: "src/app.tsx",
      line: 7,
    });
  });

  it("omits the source when no data attribute carries one", () => {
    mount('<b id="plain" data-source="not-a-location">x</b>');

    expect(describeAnnotatedElement(document.getElementById("plain")!, 1, "d1")).not.toHaveProperty(
      "source",
    );
  });

  it("never reports a React name, which an isolated world cannot read", () => {
    mount('<b id="plain">x</b>');

    expect(
      Object.keys(describeAnnotatedElement(document.getElementById("plain")!, 1, "d1")),
    ).not.toContain("reactName");
  });
});

describe("describeAnnotatedArea", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("describes the anchor and carries the rect's offset from it", () => {
    mount(
      '<main><section id="panel" data-source="src/panel.tsx:9"><p>inside</p></section></main>',
    );
    const anchor = document.getElementById("panel")!;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 40,
      left: 40,
      top: 40,
      width: 200,
      height: 200,
      right: 240,
      bottom: 240,
      toJSON: () => ({}),
    } as DOMRect);

    const annotation = describeAnnotatedArea(
      anchor,
      { left: 60.4, top: 90.6, width: 50.2, height: 30.8 },
      2,
      "a1",
    );

    // `rect` is the area's own viewport box; `area` is its offset from the
    // anchor, so a rebind re-derives the rect wherever the anchor lands.
    expect(annotation).toEqual({
      id: "a1",
      index: 2,
      selector: "#panel",
      tag: "section",
      rect: { x: 60, y: 91, width: 50, height: 31 },
      area: { x: 20, y: 51, width: 50, height: 31 },
      source: { file: "src/panel.tsx", line: 9 },
    });
    // The anchor's text would describe the element, not the marked region.
    expect(annotation).not.toHaveProperty("text");
  });

  it("counts the anchor's own scroll in the offset — the mark tracks content, not the box", () => {
    mount(
      '<div id="scrollbox" style="overflow:auto"><p>inside</p></div>',
    );
    const anchor = document.getElementById("scrollbox")!;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 40,
      left: 40,
      top: 40,
      width: 200,
      height: 200,
      right: 240,
      bottom: 240,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(anchor, "scrollTop", "get").mockReturnValue(120);
    vi.spyOn(anchor, "scrollLeft", "get").mockReturnValue(10);

    // A scrolled anchor's border box does not move — without the scroll
    // term the offset would point at different content after every scroll.
    const annotation = describeAnnotatedArea(
      anchor,
      { left: 60, top: 90, width: 50, height: 30 },
      1,
      "a1",
    );

    expect(annotation.area).toEqual({ x: 30, y: 170, width: 50, height: 30 });
  });

  it("skips the scroll term when the anchor is the document's scrolling element", () => {
    // The scrolling element's rect already moves with the page scroll, so
    // adding scrollTop would count it twice. jsdom leaves
    // document.scrollingElement unimplemented — it is mocked directly.
    const anchor = document.documentElement;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -100,
      left: 0,
      top: -100,
      width: 800,
      height: 800,
      right: 800,
      bottom: 700,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(anchor, "scrollTop", "get").mockReturnValue(100);
    const own = Object.getOwnPropertyDescriptor(document, "scrollingElement");
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: anchor,
    });

    try {
      const annotation = describeAnnotatedArea(
        anchor,
        { left: 10, top: 20, width: 50, height: 30 },
        1,
        "a1",
      );

      expect(annotation.area).toEqual({ x: 10, y: 120, width: 50, height: 30 });
    } finally {
      if (own) {
        Object.defineProperty(document, "scrollingElement", own);
      } else {
        Reflect.deleteProperty(document, "scrollingElement");
      }
    }
  });
});

describe("acceptBrowserAnnotationMessage", () => {
  const trustedSender = { id: "view" };
  const annotation = {
    id: "ann-1",
    index: 1,
    selector: "#cta",
    tag: "button",
    rect: { x: 1, y: 2, width: 3, height: 4 },
  };
  const viewport = { width: 684, height: 820, dpr: 2 };

  it("refuses a sender that is not the embedded view", () => {
    expect(
      acceptBrowserAnnotationMessage({
        sender: { id: "renderer" },
        trustedSender,
        message: {
          type: "annotation-saved",
          annotation,
          viewport,
          documentUrl: "https://app.test/page",
        },
      }),
    ).toBeNull();
  });

  it("refuses every sender while no view exists", () => {
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender: null,
        message: { type: "ready" },
      }),
    ).toBeNull();
  });

  it("refuses messages outside the whitelist", () => {
    for (const message of [
      null,
      "annotations",
      { type: "evaluate", code: "fetch('/')" },
      { type: "design-mode" },
      { type: "design-mode", enabled: "yes" },
      { type: "annotations" },
      { type: "annotations", annotations: [], viewport },
      { type: "annotation-saved" },
      { type: "annotation-saved", annotation },
      { type: "annotation-saved", annotation: {}, viewport },
      {
        type: "annotation-saved",
        annotation,
        viewport,
      },
      {
        type: "annotation-saved",
        annotation,
        viewport,
        documentUrl: 42,
      },
      {
        type: "annotation-saved",
        annotation,
        viewport,
        documentUrl: `https://app.test/${"x".repeat(2048)}`,
      },
      { type: "annotation-deleted" },
      { type: "annotation-deleted", id: "has spaces/in it" },
      { type: "annotation-presence", id: "ann-1" },
      { type: "annotation-presence", id: "ann-1", stale: "yes" },
    ]) {
      expect(
        acceptBrowserAnnotationMessage({ sender: trustedSender, trustedSender, message }),
      ).toBeNull();
    }
  });

  it("rejects a saved annotation whose required fields are not what they claim", () => {
    const accept = (candidate: unknown) =>
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: {
          type: "annotation-saved",
          annotation: candidate,
          viewport,
          documentUrl: "https://app.test/page",
        },
      });

    expect(accept(annotation)).toEqual({
      type: "annotation-saved",
      annotation,
      viewport,
      documentUrl: "https://app.test/page",
    });
    expect(accept({ ...annotation, selector: 42 })).toBeNull();
    expect(
      accept({ ...annotation, rect: { x: 0, y: 0, width: Number.NaN, height: 0 } }),
    ).toBeNull();
  });

  it("accepts a valid area and rejects one that is not a real rect", () => {
    const accept = (candidate: unknown) =>
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: {
          type: "annotation-saved",
          annotation: candidate,
          viewport,
          documentUrl: "https://app.test/page",
        },
      });
    const area = { x: 10, y: 12, width: 30, height: 20 };

    expect(accept({ ...annotation, area })).toMatchObject({
      annotation: { area },
    });

    // A malformed area cannot ride the wire half-parsed — the whole
    // annotation is refused rather than stored as an element comment.
    for (const bad of [
      { area: null },
      { area: "12x10" },
      { area: { x: 1, y: 2, width: 3 } },
      { area: { x: 1, y: 2, width: 0, height: 3 } },
      { area: { x: 1, y: 2, width: 3, height: -4 } },
      { area: { x: 1, y: 2, width: 3, height: Number.NaN } },
    ]) {
      expect(accept({ ...annotation, ...bad })).toBeNull();
    }
  });

  it("rejects a saved annotation whose id is not a minted short string", () => {
    const accept = (id: unknown) =>
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: {
          type: "annotation-saved",
          annotation: { ...annotation, id },
          viewport,
          documentUrl: "https://app.test/page",
        },
      });

    // The index field alone is not an identity a page can be trusted with.
    expect(accept(42)).toBeNull();
    expect(accept("has spaces/in it")).toBeNull();
    expect(accept("x".repeat(65))).toBeNull();
    expect(accept("")).toBeNull();
    expect(accept("ann-1")).not.toBeNull();
  });

  it("folds newlines out of every single-line field that reaches the prompt", () => {
    const accepted = acceptBrowserAnnotationMessage({
      sender: trustedSender,
      trustedSender,
      message: {
        type: "annotation-saved",
        viewport,
        documentUrl: "https://app.test/page",
        annotation: {
          ...annotation,
          selector: '[data-testid="two\nlines"]',
          text: "visible\ntext",
          source: { file: "src/two\nlines.tsx", line: 3 },
        },
      },
    });
    const first = (accepted as { annotation: Record<string, unknown> }).annotation;

    // These fields are one row each in what Pi reads — a newline in them is a
    // page writing rows of its own.
    expect(first.selector).toBe('[data-testid="two lines"]');
    expect(first.text).toBe("visible text");
    expect(first.source).toEqual({ file: "src/two lines.tsx", line: 3 });
  });

  it("keeps a comment's line breaks but normalises and caps them", () => {
    const accepted = acceptBrowserAnnotationMessage({
      sender: trustedSender,
      trustedSender,
      message: {
        type: "annotation-saved",
        viewport,
        documentUrl: "https://app.test/page",
        annotation: {
          ...annotation,
          comment: "first line\r\nsecond\rthird\n\n\n\nlast",
        },
      },
    });
    const first = (accepted as { annotation: Record<string, unknown> }).annotation;

    // Shift+Enter is how the user writes a multi-line comment; CRLF and runs
    // of blank space are normalised, the lines themselves are kept.
    expect(first.comment).toBe("first line\nsecond\nthird\n\nlast");
  });

  it("rebuilds each annotation, so page-supplied extras never travel on", () => {
    const accepted = acceptBrowserAnnotationMessage({
      sender: trustedSender,
      trustedSender,
      message: {
        type: "annotation-saved",
        viewport,
        documentUrl: "https://app.test/page",
        annotation: {
          ...annotation,
          text: "x".repeat(400),
          comment: "y".repeat(2_000),
          source: { file: "src/app.tsx", line: 3, column: 1 },
          html: "<script>alert(1)</script>",
        },
      },
    });
    const first = (accepted as { annotation: Record<string, unknown> }).annotation;

    expect(first).not.toHaveProperty("html");
    expect((first.text as string).length).toBeLessThanOrEqual(120);
    expect((first.comment as string).length).toBeLessThanOrEqual(500);
    expect(first.source).toEqual({ file: "src/app.tsx", line: 3, column: 1 });
  });

  it("accepts the page's send request verbatim", () => {
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: { type: "submit-requested" },
      }),
    ).toEqual({ type: "submit-requested" });
  });

  it("passes the whitelisted lifecycle messages through", () => {
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: { type: "ready" },
      }),
    ).toEqual({ type: "ready" });
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: { type: "design-mode", enabled: false },
      }),
    ).toEqual({ type: "design-mode", enabled: false });
  });

  it("passes the lifecycle reports that carry only an id", () => {
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: { type: "annotation-deleted", id: "ann-1" },
      }),
    ).toEqual({ type: "annotation-deleted", id: "ann-1" });
    expect(
      acceptBrowserAnnotationMessage({
        sender: trustedSender,
        trustedSender,
        message: { type: "annotation-presence", id: "ann-1", stale: true },
      }),
    ).toEqual({ type: "annotation-presence", id: "ann-1", stale: true });
  });
});

describe("resolveAnnotationTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** jsdom measures nothing; give an element a size so it is not decorative. */
  function size(element: Element, width = 40, height = 20) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect);
    return element;
  }

  it("climbs out of inline decorations to the element the user meant", () => {
    mount('<p id="copy">Some <span id="word">nested <b id="bold">text</b></span></p>');
    const copy = size(document.getElementById("copy")!);

    expect(resolveAnnotationTarget(size(document.getElementById("bold")!))).toBe(
      copy,
    );
    expect(resolveAnnotationTarget(size(document.getElementById("word")!))).toBe(
      copy,
    );
  });

  it("names the svg, not a path inside it", () => {
    mount(
      '<button id="icon"><svg viewBox="0 0 10 10"><path id="stroke" d="M0 0h10"/></svg></button>',
    );

    const path = document.getElementById("stroke")!;
    size(document.getElementById("icon")!);

    // The climb reaches the <svg>, and the interactive step then prefers the
    // button — marking an icon is marking the control it draws.
    expect(resolveAnnotationTarget(path)).toBe(document.getElementById("icon"));
  });

  it("climbs past elements too small to have been aimed at", () => {
    mount('<div id="row"><i id="hairline"></i></div>');
    const row = size(document.getElementById("row")!);

    expect(resolveAnnotationTarget(document.getElementById("hairline")!)).toBe(row);
  });

  it("prefers the nearest interactive ancestor even for a sizeable target", () => {
    mount('<button id="cta"><span id="label">Go</span></button>');

    const label = document.getElementById("label")!;
    size(document.getElementById("cta")!);

    // span is decorative regardless, but the assertion is on the outcome:
    // the click meant the button.
    expect(resolveAnnotationTarget(label)).toBe(document.getElementById("cta"));
  });

  it("honours ARIA roles as interactive targets", () => {
    mount('<div id="chip" role="button"><em id="inner">x</em></div>');
    const chip = size(document.getElementById("chip")!);

    expect(resolveAnnotationTarget(document.getElementById("inner")!)).toBe(chip);
  });

  it("stops at body rather than climbing to the document element", () => {
    mount('<span id="orphan">x</span>');

    expect(resolveAnnotationTarget(document.getElementById("orphan")!)).toBe(
      document.body,
    );
  });
});

describe("readAnnotationPalette", () => {
  const palette = {
    accent: "#0064E0",
    accentForeground: "#fff",
    surface: "#1f1f22",
    foreground: "rgb(1, 2, 3)",
    border: "rgba(0, 0, 0, 0.1)",
    muted: "oklch(0.7 0.1 200)",
  };

  it("accepts a full palette of short strings verbatim", () => {
    expect(readAnnotationPalette(palette)).toEqual(palette);
  });

  it("drops the whole palette when a field is missing, not a string, or too long", () => {
    for (const bad of [
      null,
      "dark",
      { ...palette, accent: 42 },
      { ...palette, muted: "x".repeat(65) },
      { accent: "#fff" },
    ]) {
      // A partial or malformed palette must not reach the page: the overlay
      // would then mix renderer colours with defaults unpredictably.
      expect(readAnnotationPalette(bad)).toBeUndefined();
    }
  });
});
