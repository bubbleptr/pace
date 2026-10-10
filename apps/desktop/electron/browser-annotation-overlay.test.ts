import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationElement,
  BrowserAnnotationPalette,
  BrowserAnnotationViewport,
} from "@/shared/browser-protocol";
import {
  annotationOverlayHostTag,
  createAnnotationOverlay,
  type BrowserAnnotationOverlay,
} from "./browser-annotation-overlay";

/**
 * The overlay lives in a closed shadow root, which is exactly what makes it
 * unreachable from the page — and from a test. Capturing the roots as they are
 * attached is the only way to drive the editor the way a user does; everything
 * else is asserted through the callbacks the preload subscribes to.
 */
const shadowRoots: ShadowRoot[] = [];
let overlay: BrowserAnnotationOverlay | null = null;

function harness() {
  const annotationChanges: BrowserAnnotationElement[][] = [];
  const viewports: BrowserAnnotationViewport[] = [];
  const designModeChanges: boolean[] = [];
  const captures: {
    annotations: BrowserAnnotationElement[];
    viewport: BrowserAnnotationViewport;
  }[] = [];

  overlay = createAnnotationOverlay({
    document,
    onAnnotationsChange: (annotations, viewport) => {
      annotationChanges.push(annotations);
      viewports.push(viewport);
    },
    onDesignModeChange: (enabled) => designModeChanges.push(enabled),
    onCaptureReady: (annotations, viewport) => captures.push({ annotations, viewport }),
  });

  return {
    overlay,
    annotationChanges,
    viewports,
    designModeChanges,
    captures,
    latest: () => annotationChanges[annotationChanges.length - 1] ?? [],
    shadow: () => shadowRoots[shadowRoots.length - 1]!,
  };
}

function clickPageElement(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );
}

function hoverPageElement(element: Element) {
  element.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    }),
  );
}

function rectAt(x: number, y: number, width = 40, height = 20) {
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom measures nothing, and target resolution skips elements under 8px —
 * every click target needs a rect or the climb lands on `<body>`.
 */
function place(element: Element, x = 40, y = 40) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectAt(x, y));
  return element;
}

function clip(element: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    rectAt(x, y, width, height),
  );
  Object.defineProperties(element, {
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  return element;
}

function editor(h: ReturnType<typeof harness>) {
  return h
    .shadow()
    .querySelector<HTMLElement>('[data-slot="annotation-editor"]')!;
}

function editorInput(h: ReturnType<typeof harness>) {
  return h
    .shadow()
    .querySelector<HTMLTextAreaElement>('[data-slot="annotation-editor-input"]')!;
}

function editorButton(h: ReturnType<typeof harness>, slot: string) {
  return h
    .shadow()
    .querySelector<HTMLButtonElement>(`[data-slot="annotation-editor-${slot}"]`)!;
}

function editorVisible(h: ReturnType<typeof harness>) {
  return editor(h).style.display !== "none";
}

function typeDraft(h: ReturnType<typeof harness>, text: string) {
  const input = editorInput(h);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Click, type, Enter — the full path from pointer to saved annotation. */
function annotate(h: ReturnType<typeof harness>, element: Element, text: string) {
  clickPageElement(element);
  typeDraft(h, text);
  pressKey(editorInput(h), "Enter");
}

function badges(h: ReturnType<typeof harness>) {
  return Array.from(
    h.shadow().querySelectorAll<HTMLElement>('[data-slot="annotation-badge"]'),
  );
}

/** jsdom runs rAF on a timer; two frames is enough for a scheduled sync. */
function nextFrames() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

const fullPalette: BrowserAnnotationPalette = {
  accent: "rgb(1, 2, 3)",
  accentForeground: "rgb(4, 5, 6)",
  surface: "rgb(7, 8, 9)",
  foreground: "rgb(10, 11, 12)",
  border: "rgb(13, 14, 15)",
  muted: "rgb(16, 17, 18)",
};

beforeEach(() => {
  const attachShadow = Element.prototype.attachShadow;

  shadowRoots.length = 0;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function attach(
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = attachShadow.call(this, init);

    shadowRoots.push(root);
    return root;
  });
  document.body.innerHTML =
    '<main><button id="cta">Go</button><p id="copy">c</p></main>';
});

afterEach(() => {
  overlay?.dispose();
  overlay = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("annotation overlay", () => {
  it("opens a focused editor on click and reports nothing until it is saved", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);
    const pageClicks = vi.fn();

    button.addEventListener("click", pageClicks);
    clickPageElement(button);

    expect(pageClicks).toHaveBeenCalledTimes(1);
    expect(h.annotationChanges).toHaveLength(0);

    h.overlay.setDesignMode(true);
    clickPageElement(button);

    // The page must not act on a click the user meant as "mark this".
    expect(pageClicks).toHaveBeenCalledTimes(1);
    expect(editorVisible(h)).toBe(true);
    expect(h.shadow().activeElement).toBe(editorInput(h));

    // A draft is not an annotation yet: main hears nothing while it is typed.
    typeDraft(h, "Too small to hit");
    expect(h.annotationChanges).toHaveLength(0);
    // Main clamps comments at the same ceiling when it rebuilds them.
    expect(editorInput(h).maxLength).toBe(500);
  });

  it("cannot save an empty comment — Save is disabled and Enter does nothing", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));

    const save = editorButton(h, "save");

    expect(save.disabled).toBe(true);

    pressKey(editorInput(h), "Enter");
    typeDraft(h, "   ");
    pressKey(editorInput(h), "Enter");

    expect(editorVisible(h)).toBe(true);
    expect(h.annotationChanges).toHaveLength(0);
  });

  it("saves on Enter and stays in annotation mode", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    annotate(h, place(document.getElementById("cta")!), "Too small to hit");

    expect(h.latest()).toHaveLength(1);
    expect(h.latest()[0]).toMatchObject({
      index: 1,
      selector: "#cta",
      tag: "button",
      comment: "Too small to hit",
    });
    expect(typeof h.latest()[0]!.id).toBe("string");
    expect(h.designModeChanges).toEqual([]);
    expect(editorVisible(h)).toBe(false);
    expect(badges(h)[0]?.textContent).toBe("1");
  });

  it("keeps Shift+Enter as a newline instead of saving", () => {
    const h = harness();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    typeDraft(h, "line one");
    editorInput(h).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(editorVisible(h)).toBe(true);
    expect(h.annotationChanges).toHaveLength(0);
  });

  it("cancels the editor on first Escape and leaves the mode on the second", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    typeDraft(h, "half-typed");
    pressKey(editorInput(h), "Escape");

    expect(editorVisible(h)).toBe(false);
    expect(h.designModeChanges).toEqual([]);
    expect(h.annotationChanges).toHaveLength(0);

    pressKey(window, "Escape");

    expect(h.designModeChanges).toEqual([false]);
  });

  it("reverts an existing annotation's text when its edit is cancelled", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    annotate(h, button, "saved text");
    clickPageElement(button);

    expect(editorInput(h).value).toBe("saved text");

    typeDraft(h, "changed mind");
    editorButton(h, "cancel").click();

    expect(editorVisible(h)).toBe(false);
    expect(h.latest()[0]!.comment).toBe("saved text");
    expect(h.latest()).toHaveLength(1);
  });

  it("opens the annotation's own editor when its element or badge is re-clicked", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    annotate(h, button, "first note");
    clickPageElement(button);

    // Editing, not duplicating: the Delete button only exists for a saved mark.
    expect(editorInput(h).value).toBe("first note");
    expect(editorButton(h, "delete").style.display).not.toBe("none");
    expect(h.latest()).toHaveLength(1);

    pressKey(editorInput(h), "Escape");
    badges(h)[0]!.click();

    expect(editorInput(h).value).toBe("first note");
    expect(h.latest()).toHaveLength(1);
  });

  it("deletes a mark and renumbers the rest contiguously", () => {
    const h = harness();
    const cta = place(document.getElementById("cta")!, 40, 40);
    const copy = place(document.getElementById("copy")!, 40, 300);

    h.overlay.setDesignMode(true);
    annotate(h, cta, "first");
    annotate(h, copy, "second");
    clickPageElement(cta);
    editorButton(h, "delete").click();

    expect(h.latest()).toHaveLength(1);
    expect(h.latest()[0]).toMatchObject({ index: 1, selector: "#copy", comment: "second" });
    expect(badges(h).map((badge) => badge.textContent)).toEqual(["1"]);
  });

  it("keeps a dirty draft when another element is clicked, shaking instead of switching", () => {
    const h = harness();
    const cta = place(document.getElementById("cta")!, 40, 40);
    const copy = place(document.getElementById("copy")!, 40, 300);

    h.overlay.setDesignMode(true);
    clickPageElement(cta);
    typeDraft(h, "not finished");
    clickPageElement(copy);

    // The draft the user was typing survives — a click is not a discard.
    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("not finished");
    expect(h.annotationChanges).toHaveLength(0);
  });

  it("discards an untouched draft when another element is clicked", () => {
    const h = harness();
    const cta = place(document.getElementById("cta")!, 40, 40);
    const copy = place(document.getElementById("copy")!, 40, 300);

    h.overlay.setDesignMode(true);
    clickPageElement(cta);
    clickPageElement(copy);

    // The new target owns the editor: it hangs below the second element.
    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("");
    expect(editor(h).style.top).toBe(`${300 + 20 + 8}px`);
  });

  it("flips the editor above an element near the viewport's bottom edge", () => {
    const h = harness();

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 200 });
    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!, 40, 170));

    // jsdom's editor measures 0px tall, so above sits at top − 8.
    expect(editor(h).style.top).toBe(`${170 - 8}px`);
  });

  it("lets ↑ climb to the parent and ↓ return, and annotates the adjusted target", () => {
    const h = harness();
    const wrap = place(document.querySelector("main")!, 8, 8);
    const button = place(document.getElementById("cta")!, 40, 40);

    h.overlay.setDesignMode(true);
    hoverPageElement(button);
    pressKey(window, "ArrowUp");
    pressKey(window, "ArrowDown");
    pressKey(window, "ArrowUp");
    clickPageElement(button);
    typeDraft(h, "the whole row");
    pressKey(editorInput(h), "Enter");

    expect(h.latest()[0]).toMatchObject({ index: 1, tag: "main" });
    expect(button.parentElement).toBe(wrap);
  });

  it("ignores Enter and Escape while an IME composition is active", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    typeDraft(h, "half-typed");

    // Enter inside a composition confirms a candidate — saving half a phrase
    // is the bug this guard exists for. keyCode 229 is Chromium's composition
    // marker on platforms that do not set isComposing.
    pressKey(editorInput(h), "Enter", { isComposing: true });
    expect(editorVisible(h)).toBe(true);
    expect(h.annotationChanges).toHaveLength(0);

    pressKey(editorInput(h), "Enter", { keyCode: 229 });
    expect(editorVisible(h)).toBe(true);
    expect(h.annotationChanges).toHaveLength(0);

    pressKey(editorInput(h), "Escape", { isComposing: true });
    expect(editorVisible(h)).toBe(true);
    expect(h.designModeChanges).toEqual([]);

    // Once the composition commits, the same keys work again.
    pressKey(editorInput(h), "Enter");
    expect(h.latest()[0]!.comment).toBe("half-typed");
  });

  it("toggles annotation mode on Cmd/Ctrl+Shift+A and reports it", () => {
    const h = harness();

    pressKey(window, "a", { code: "KeyA", shiftKey: true, metaKey: true });

    expect(h.designModeChanges).toEqual([true]);

    pressKey(window, "a", { code: "KeyA", shiftKey: true, ctrlKey: true });

    expect(h.designModeChanges).toEqual([true, false]);
    // A bare Cmd+A is the page's own shortcut and must not toggle.
    pressKey(window, "a", { code: "KeyA", metaKey: true });
    expect(h.designModeChanges).toEqual([true, false]);
  });

  it("falls back per colour when the page cannot parse a palette value", () => {
    const h = harness();

    // jsdom's CSS has no `supports`, which the overlay treats as "unsupported"
    // — stub the whole global, keeping `escape` for the selector builder.
    vi.stubGlobal("CSS", {
      escape: CSS.escape,
      supports: (_property: string, value: string) => value === "rgb(4, 5, 6)",
    });

    h.overlay.setDesignMode(true, fullPalette);
    annotate(h, place(document.getElementById("cta")!), "hi");

    const badge = badges(h)[0]!;

    // The bad accent falls back alone; a good accentForeground still lands.
    // jsdom normalises colours to rgb(), so the default reads back expanded.
    expect(badge.style.backgroundColor).toBe("rgb(109, 40, 217)");
    expect(badge.style.color).toBe("rgb(4, 5, 6)");
  });

  it("updates the palette without enabling annotation mode", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    vi.stubGlobal("CSS", {
      escape: CSS.escape,
      supports: (_property: string, value: string) => value.startsWith("rgb("),
    });
    h.overlay.setDesignMode(true);
    annotate(h, button, "palette");
    h.overlay.setDesignMode(false);

    h.overlay.setAnnotationPalette(fullPalette);

    expect(badges(h)[0]!.style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(
      h.shadow().querySelector<HTMLElement>('[data-slot="annotation-frame"]')!
        .style.display,
    ).toBe("none");
    expect(
      h.shadow().querySelector<HTMLElement>('[data-slot="annotation-markers"]')!
        .style.pointerEvents,
    ).toBe("none");
    expect(h.designModeChanges).toEqual([]);
  });

  it("shows the mode frame and pill only while annotating", () => {
    const h = harness();
    const frame = () =>
      h.shadow().querySelector<HTMLElement>('[data-slot="annotation-frame"]')!;
    const pill = () =>
      h.shadow().querySelector<HTMLElement>('[data-slot="annotation-pill"]')!;

    h.overlay.setDesignMode(true);

    expect(frame().style.display).toBe("block");
    expect(pill().textContent).toContain("Esc to exit");

    h.overlay.setDesignMode(false);

    expect(frame().style.display).toBe("none");
    expect(pill().style.display).toBe("none");
  });

  it("labels the hover box with the tag, first class, size and source", () => {
    const h = harness();
    const button = document.getElementById("cta")!;

    button.classList.add("primary-cta", "ignored");
    button.setAttribute("data-source", "src/cta.tsx:9");
    place(button, 40, 40);

    h.overlay.setDesignMode(true);
    hoverPageElement(button);

    const label = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-highlight-label"]')!;

    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe("button.primary-cta · 40×20 · src/cta.tsx:9");
  });

  it("saves a non-empty draft on prepareCapture and hides all chrome but the marks", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });

    h.overlay.setDesignMode(true);
    hoverPageElement(button);
    clickPageElement(button);
    typeDraft(h, "typed as the shot was asked for");

    h.overlay.prepareCapture();

    // The draft the user was still typing has to reach the payload — a Send
    // driven from the toolbar never blurs the textarea.
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toEqual({
      annotations: [
        expect.objectContaining({ index: 1, comment: "typed as the shot was asked for" }),
      ],
      viewport: { width: 900, height: window.innerHeight, dpr: window.devicePixelRatio },
    });

    const shadow = h.shadow();

    for (const slot of [
      "annotation-editor",
      "annotation-highlight",
      "annotation-highlight-label",
      "annotation-frame",
      "annotation-pill",
    ]) {
      const element = shadow.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
      expect(element.hidden === true || element.style.display === "none").toBe(true);
    }

    // Marks stay in the shot: the numbered rows in the prompt point at them.
    expect(badges(h)[0]!.style.display).not.toBe("none");
    expect(
      shadow.querySelector<HTMLElement>('[data-slot="annotation-outline"]')!.style
        .display,
    ).not.toBe("none");

    // The shot is done: the mode chrome comes back, still annotating.
    h.overlay.finishCapture();
    expect(
      shadow.querySelector<HTMLElement>('[data-slot="annotation-frame"]')!.style.display,
    ).toBe("block");
  });

  it("discards an empty draft on prepareCapture instead of inventing a mark", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    h.overlay.prepareCapture();

    expect(h.captures[0]?.annotations).toEqual([]);
    expect(h.annotationChanges).toHaveLength(0);
  });

  it("hides fully offscreen marks and refreshes their positions synchronously for capture", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!, -60, -60);

    h.overlay.setDesignMode(true);
    annotate(h, button, "offscreen");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.display).toBe("none");
    expect(badge.style.display).toBe("none");

    vi.mocked(button.getBoundingClientRect).mockReturnValue(rectAt(80, 90));
    h.overlay.prepareCapture();

    expect(outline.style.display).toBe("block");
    expect(outline.style.left).toBe("80px");
    expect(outline.style.top).toBe("90px");
    expect(badge.style.display).toBe("flex");
    expect(h.captures[0]?.annotations).toHaveLength(1);
  });

  it("keeps the badge usable when its target is smaller than the badge", () => {
    const h = harness();
    const button = document.getElementById("cta")!;

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rectAt(40, 40, 16, 16),
    );
    h.overlay.setDesignMode(true);
    annotate(h, button, "small target");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.width).toBe("16px");
    expect(outline.style.height).toBe("16px");
    expect(badge.style.display).toBe("flex");
    expect(badge.style.left).toBe("46px");
    expect(badge.style.top).toBe("30px");
  });

  it("keeps the badge visible when only a sliver of its target intersects the viewport", () => {
    const h = harness();
    const button = document.getElementById("cta")!;

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rectAt(-18, 40, 20, 20),
    );
    h.overlay.setDesignMode(true);
    annotate(h, button, "partially visible");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.left).toBe("0px");
    expect(outline.style.width).toBe("2px");
    expect(badge.style.display).toBe("flex");
    expect(badge.style.left).toBe("8px");
  });

  it("clips marks and badge placement to nested scrolling ancestors", () => {
    const h = harness();
    const outer = document.createElement("section");
    const inner = document.createElement("section");
    const button = document.createElement("button");

    outer.style.overflowX = "auto";
    outer.style.overflowY = "auto";
    inner.style.overflowX = "hidden";
    inner.style.overflowY = "hidden";
    outer.append(inner);
    inner.append(button);
    document.querySelector("main")!.append(outer);
    clip(outer, 40, 40, 120, 120);
    clip(inner, 60, 60, 60, 60);
    clip(button, 20, 20, 120, 120);

    h.overlay.setDesignMode(true);
    annotate(h, button, "nested");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.left).toBe("60px");
    expect(outline.style.top).toBe("60px");
    expect(outline.style.width).toBe("60px");
    expect(outline.style.height).toBe("60px");
    expect(Number.parseFloat(badge.style.left)).toBeGreaterThanOrEqual(60);
    expect(Number.parseFloat(badge.style.left) + 20).toBeLessThanOrEqual(120);
    expect(Number.parseFloat(badge.style.top)).toBeGreaterThanOrEqual(60);
    expect(Number.parseFloat(badge.style.top) + 20).toBeLessThanOrEqual(120);
    expect(badge.style.left).toBe("100px");
    expect(badge.style.top).toBe("60px");

    vi.mocked(button.getBoundingClientRect).mockReturnValue(
      rectAt(130, 130, 20, 20),
    );
    h.overlay.prepareCapture();

    expect(outline.style.display).toBe("none");
    expect(badge.style.display).toBe("none");
  });

  it("rebinds a uniquely selected DOM replacement and keeps its stable annotation id", () => {
    const h = harness();
    const original = place(document.getElementById("cta")!, 40, 40);
    h.overlay.setDesignMode(true);
    annotate(h, original, "Original comment");
    const originalId = h.latest()[0]!.id;
    clickPageElement(original);
    expect(editorVisible(h)).toBe(true);

    original.remove();
    const replacement = document.createElement("button");
    replacement.id = "cta";
    replacement.textContent = "Replacement";
    place(replacement, 120, 130);
    document.querySelector("main")!.append(replacement);

    clickPageElement(replacement);

    expect(editorInput(h).value).toBe("Original comment");
    expect(editor(h).style.left).toBe("120px");
    typeDraft(h, "Updated comment");
    pressKey(editorInput(h), "Enter");

    expect(h.latest()).toHaveLength(1);
    expect(h.latest()[0]).toMatchObject({
      id: originalId,
      index: 1,
      selector: "#cta",
      rect: { x: 120, y: 130 },
      comment: "Updated comment",
    });
  });

  it("does not rebind a disconnected annotation to an ambiguous selector", () => {
    const h = harness();
    const original = place(document.getElementById("cta")!);
    h.overlay.setDesignMode(true);
    annotate(h, original, "Original comment");
    original.remove();

    const first = document.createElement("button");
    const second = document.createElement("button");
    first.id = "cta";
    second.id = "cta";
    place(first, 80, 80);
    place(second, 120, 120);
    document.querySelector("main")!.append(first, second);

    clickPageElement(first);

    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("");
    expect(editorButton(h, "delete").style.display).toBe("none");
    expect(h.latest()).toHaveLength(1);
    expect(h.latest()[0]?.comment).toBe("Original comment");
  });

  it("reclaims the shared badge corner immediately after deleting an earlier mark", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!, 40, 40);
    const paragraph = place(document.getElementById("copy")!, 40, 40);

    h.overlay.setDesignMode(true);
    annotate(h, button, "first");
    annotate(h, paragraph, "second");
    const survivingBadge = badges(h)[1]!;
    expect(survivingBadge.style.left).toBe("46px");

    clickPageElement(button);
    editorButton(h, "delete").click();

    expect(survivingBadge.textContent).toBe("1");
    expect(survivingBadge.style.left).toBe("70px");
    expect(h.latest()).toHaveLength(1);
  });

  it("drops the hover highlight when the pointer leaves the page", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);
    const leave = (target: Element, relatedTarget: Element | null) =>
      target.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          cancelable: true,
          composed: true,
          relatedTarget,
        }),
      );

    h.overlay.setDesignMode(true);
    hoverPageElement(button);

    const highlight = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-highlight"]')!;

    expect(highlight.hidden).toBe(false);

    // Moving between two elements is not leaving: the highlight has to follow
    // the pointer, and the next pointermove is what moves it.
    leave(button, document.getElementById("copy"));
    expect(highlight.hidden).toBe(false);

    // Reaching the toolbar takes the pointer out of the page entirely, and a
    // highlight that follows the pointer must not go on framing an element the
    // pointer has left.
    leave(button, null);
    expect(highlight.hidden).toBe(true);
  });

  it("ignores clicks that land on its own overlay", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(document.querySelector(annotationOverlayHostTag)!);

    expect(shadowRoots[0]!.querySelector('[data-slot="annotation-editor"]')).toBeNull();
    expect(h.annotationChanges).toHaveLength(0);
  });

  it("marks the element inside the page's own shadow root, not its host", () => {
    const h = harness();
    const widget = document.createElement("div");

    widget.id = "widget";
    document.body.append(widget);

    const inner = document.createElement("a");

    inner.textContent = "Inner link";
    inner.href = "https://example.com";
    widget.attachShadow({ mode: "open" }).append(inner);
    place(inner, 60, 60);

    h.overlay.setDesignMode(true);
    clickPageElement(inner);
    typeDraft(h, "shadow");
    pressKey(editorInput(h), "Enter");

    // `event.target` is retargeted to the host at the window; the composed
    // path still names what the user actually pointed at.
    expect(h.latest()[0]).toMatchObject({ tag: "a", text: "Inner link" });
  });

  it("keeps a mark on its element as the page scrolls", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;
    const measure = vi.spyOn(button, "getBoundingClientRect");

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    measure.mockReturnValue(rectAt(12, 200));
    h.overlay.setDesignMode(true);
    annotate(h, button, "scroll test");

    const outline = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-outline"]')!;

    expect(outline.style.top).toBe("200px");

    measure.mockReturnValue(rectAt(12, 40));
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    // A mark pinned to where the element was would sit over the wrong thing
    // in the page and on the screenshot.
    expect(outline.style.top).toBe("40px");

    // An element a re-render took away has no position to sit at; the mark
    // must not fall back to the top-left corner of the viewport.
    button.remove();
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(outline.style.display).toBe("none");
    expect(badges(h)[0]!.style.display).toBe("none");
  });

  it("moves the open editor with its element on scroll", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;
    const measure = vi.spyOn(button, "getBoundingClientRect");

    measure.mockReturnValue(rectAt(40, 40));
    // Tests that reshape the viewport leak it (defineProperty survives
    // restoreAllMocks), so this one states its own height.
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600,
    });
    h.overlay.setDesignMode(true);
    clickPageElement(button);

    expect(editor(h).style.top).toBe(`${40 + 20 + 8}px`);

    measure.mockReturnValue(rectAt(40, 200));
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    // Scrolling is not blocked while a comment is being typed, so an editor
    // that stayed behind would be writing about the wrong element.
    expect(editor(h).style.top).toBe(`${200 + 20 + 8}px`);
  });

  it("moves the hover highlight and its label with the element on scroll", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;
    const measure = vi.spyOn(button, "getBoundingClientRect");

    measure.mockReturnValue(rectAt(40, 40));
    h.overlay.setDesignMode(true);
    hoverPageElement(button);

    const highlight = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-highlight"]')!;

    expect(highlight.style.top).toBe("40px");

    measure.mockReturnValue(rectAt(40, 120));
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(highlight.style.top).toBe("120px");
  });

  it("arms its marks when the overlay is built after design mode was on", () => {
    const h = harness();
    const root = document.documentElement;
    const button = place(document.getElementById("cta")!);

    // A preload runs before the document has a root element to hang the
    // overlay on, and main re-applies design mode the moment it reports in.
    root.remove();
    h.overlay.setDesignMode(true);
    document.append(root);

    clickPageElement(button);

    expect(
      h.shadow().querySelector<HTMLElement>('[data-slot="annotation-markers"]')!.style
        .pointerEvents,
    ).toBe("auto");
  });

  it("clears every mark on demand", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    annotate(h, place(document.getElementById("cta")!), "gone");
    h.overlay.clearAnnotations();

    expect(h.latest()).toEqual([]);
    expect(badges(h)).toHaveLength(0);
  });

  it("takes its overlay and its listeners with it when disposed", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    h.overlay.dispose();

    expect(document.querySelector(annotationOverlayHostTag)).toBeNull();

    clickPageElement(document.getElementById("cta")!);
    expect(h.annotationChanges).toHaveLength(0);
  });
});
