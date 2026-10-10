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
  const saved: {
    annotation: BrowserAnnotationElement;
    viewport: BrowserAnnotationViewport;
  }[] = [];
  const deleted: string[] = [];
  const presence: { id: string; stale: boolean }[] = [];
  const designModeChanges: boolean[] = [];
  const submitRequests: number[] = [];
  const order: string[] = [];

  overlay = createAnnotationOverlay({
    document,
    onAnnotationSaved: (annotation, viewport) => {
      order.push("saved");
      saved.push({ annotation, viewport });
    },
    onAnnotationDeleted: (id) => deleted.push(id),
    onAnnotationPresence: (id, stale) => presence.push({ id, stale }),
    onDesignModeChange: (enabled) => designModeChanges.push(enabled),
    onSubmitRequested: () => {
      order.push("submit");
      submitRequests.push(submitRequests.length);
    },
  });

  return {
    overlay,
    saved,
    deleted,
    presence,
    designModeChanges,
    submitRequests,
    order,
    shadow: () => shadowRoots[shadowRoots.length - 1]!,
    hostElement: () => document.querySelector<HTMLElement>(annotationOverlayHostTag)!,
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
function place(element: Element, x = 40, y = 40, width = 40, height = 20) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    rectAt(x, y, width, height),
  );
  return element;
}

function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {},
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
}

/** Press, drag and release on a page element — the click a real drag ends in. */
function drag(element: Element, fromX: number, fromY: number, toX: number, toY: number) {
  pointer(element, "pointerdown", fromX, fromY, { button: 0, buttons: 1 });
  pointer(element, "pointermove", toX, toY, { buttons: 1 });
  pointer(element, "pointerup", toX, toY, { button: 0, buttons: 0 });
  clickPageElement(element);
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

/** jsdom runs rAF on a timer; two frames is enough for a scheduled sync — and
 * exactly what a new save waits before reporting, so the crop lands clean. */
function nextFrames() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Click, type, Enter — then the two frames a new save waits before reporting. */
async function annotate(
  h: ReturnType<typeof harness>,
  element: Element,
  text: string,
) {
  clickPageElement(element);
  typeDraft(h, text);
  pressKey(editorInput(h), "Enter");
  await nextFrames();
}

function badges(h: ReturnType<typeof harness>) {
  const root = shadowRoots[shadowRoots.length - 1];

  // Nothing rendered yet means no shadow root exists at all.
  return root
    ? Array.from(
        root.querySelectorAll<HTMLElement>('[data-slot="annotation-badge"]'),
      )
    : [];
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
    expect(h.saved).toHaveLength(0);

    h.overlay.setDesignMode(true);
    clickPageElement(button);

    // The page must not act on a click the user meant as "mark this".
    expect(pageClicks).toHaveBeenCalledTimes(1);
    expect(editorVisible(h)).toBe(true);
    expect(h.shadow().activeElement).toBe(editorInput(h));

    // A draft is not an annotation yet: main hears nothing while it is typed.
    typeDraft(h, "Too small to hit");
    expect(h.saved).toHaveLength(0);
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
    expect(h.saved).toHaveLength(0);
  });

  it("saves on Enter, stays in mode, and hides until the crop answers", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    clickPageElement(button);
    typeDraft(h, "Too small to hit");
    pressKey(editorInput(h), "Enter");

    // The mark renders locally at once — provisional index until the sync —
    // but the report waits two frames behind the hide, so the crop the save
    // triggers contains no overlay.
    expect(editorVisible(h)).toBe(false);
    expect(h.designModeChanges).toEqual([]);
    expect(h.saved).toHaveLength(0);
    expect(h.hostElement().style.visibility).toBe("hidden");

    await nextFrames();

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.annotation).toMatchObject({
      index: 1,
      selector: "#cta",
      tag: "button",
      comment: "Too small to hit",
    });
    expect(typeof h.saved[0]!.annotation.id).toBe("string");
    expect(badges(h)[0]?.textContent).toBe("1");

    // The answer to the save's crop brings the overlay back.
    h.overlay.finishCapture();
    expect(h.hostElement().style.visibility).toBe("visible");
  });

  it("unhides after one second when the save's crop never answers", async () => {
    vi.useFakeTimers();

    const h = harness();

    try {
      h.overlay.setDesignMode(true);
      clickPageElement(place(document.getElementById("cta")!));
      typeDraft(h, "no answer");
      pressKey(editorInput(h), "Enter");

      expect(h.hostElement().style.visibility).toBe("hidden");

      await vi.advanceTimersByTimeAsync(1000);

      expect(h.hostElement().style.visibility).toBe("visible");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an edit immediately — no hide, no second crop", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);
    const annotation = {
      id: "srv-1",
      index: 1,
      selector: "#cta",
      tag: "button",
      rect: { x: 40, y: 40, width: 40, height: 20 },
      comment: "original",
    };

    h.overlay.setDesignMode(true);
    h.overlay.syncAnnotations([annotation]);
    clickPageElement(button);
    typeDraft(h, "edited");
    pressKey(editorInput(h), "Enter");

    // An edit reaches main at once: the element is already on file, nothing
    // is being photographed.
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.annotation).toMatchObject({ id: "srv-1", comment: "edited" });
    expect(h.hostElement().style.visibility).not.toBe("hidden");
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
    expect(h.saved).toHaveLength(0);
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
    expect(h.saved).toHaveLength(0);

    pressKey(editorInput(h), "Enter", { keyCode: 229 });
    expect(editorVisible(h)).toBe(true);
    expect(h.saved).toHaveLength(0);

    pressKey(editorInput(h), "Escape", { isComposing: true });
    expect(editorVisible(h)).toBe(true);
    expect(h.designModeChanges).toEqual([]);
  });

  it("cancels the editor on first Escape and leaves the mode on the second", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    typeDraft(h, "half-typed");
    pressKey(editorInput(h), "Escape");

    expect(editorVisible(h)).toBe(false);
    expect(h.designModeChanges).toEqual([]);
    expect(h.saved).toHaveLength(0);

    pressKey(window, "Escape");

    expect(h.designModeChanges).toEqual([false]);
  });

  it("reverts an existing annotation's text when its edit is cancelled", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "saved text");
    clickPageElement(button);

    expect(editorInput(h).value).toBe("saved text");

    typeDraft(h, "changed mind");
    editorButton(h, "cancel").click();

    expect(editorVisible(h)).toBe(false);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.annotation.comment).toBe("saved text");
  });

  it("opens the annotation's own editor when its element or badge is re-clicked", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "first note");
    clickPageElement(button);

    // Editing, not duplicating: the Delete button only exists for a saved mark.
    expect(editorInput(h).value).toBe("first note");
    expect(editorButton(h, "delete").style.display).not.toBe("none");
    expect(h.saved).toHaveLength(1);

    pressKey(editorInput(h), "Escape");
    badges(h)[0]!.click();

    expect(editorInput(h).value).toBe("first note");
    expect(h.saved).toHaveLength(1);
  });

  it("deletes a mark, reports the id, and renumbers the rest contiguously", async () => {
    const h = harness();
    const cta = place(document.getElementById("cta")!, 40, 40);
    const copy = place(document.getElementById("copy")!, 40, 300);

    h.overlay.setDesignMode(true);
    await annotate(h, cta, "first");
    await annotate(h, copy, "second");
    clickPageElement(cta);
    editorButton(h, "delete").click();

    expect(h.deleted).toEqual([h.saved[0]!.annotation.id]);
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
    expect(h.saved).toHaveLength(0);
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

  it("lets ↑ climb to the parent and ↓ return, and annotates the adjusted target", async () => {
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
    await nextFrames();

    expect(h.saved[0]!.annotation).toMatchObject({ index: 1, tag: "main" });
    expect(button.parentElement).toBe(wrap);
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

  it("falls back per colour when the page cannot parse a palette value", async () => {
    const h = harness();

    // jsdom's CSS has no `supports`, which the overlay treats as "unsupported"
    // — stub the whole global, keeping `escape` for the selector builder.
    vi.stubGlobal("CSS", {
      escape: CSS.escape,
      supports: (_property: string, value: string) => value === "rgb(4, 5, 6)",
    });

    h.overlay.setDesignMode(true, fullPalette);
    await annotate(h, place(document.getElementById("cta")!), "hi");

    const badge = badges(h)[0]!;

    // The bad accent falls back alone; a good accentForeground still lands.
    // jsdom normalises colours to rgb(), so the default reads back expanded.
    expect(badge.style.backgroundColor).toBe("rgb(109, 40, 217)");
    expect(badge.style.color).toBe("rgb(4, 5, 6)");
  });

  it("updates the palette without enabling annotation mode", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    vi.stubGlobal("CSS", {
      escape: CSS.escape,
      supports: (_property: string, value: string) => value.startsWith("rgb("),
    });
    h.overlay.setDesignMode(true);
    await annotate(h, button, "palette");
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
    expect(pill().textContent).toBe("Click or drag to annotate · Esc to exit");

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

  it("saves the draft then asks for a submit on Cmd/Ctrl+Enter, in that order", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    clickPageElement(button);
    typeDraft(h, "send me");

    pressKey(editorInput(h), "Enter", { metaKey: true });

    // A new save reports after two frames; the submit rides behind it.
    expect(h.order).toEqual([]);
    await nextFrames();
    // Ordering is the contract: main must hear the save before the send it
    // belongs to.
    expect(h.order).toEqual(["saved", "submit"]);
    expect(h.hostElement().style.visibility).toBe("hidden");
  });

  it("closes an empty editor on Cmd/Ctrl+Enter and only asks for the submit", async () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    pressKey(editorInput(h), "Enter", { ctrlKey: true });

    expect(editorVisible(h)).toBe(false);
    expect(h.saved).toHaveLength(0);
    expect(h.submitRequests).toHaveLength(1);
    await nextFrames();
    expect(h.saved).toHaveLength(0);
  });

  it("asks for a submit on Cmd/Ctrl+Enter with no editor open", async () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    pressKey(document.body, "Enter", { metaKey: true });

    expect(h.submitRequests).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    await nextFrames();
    expect(h.submitRequests).toHaveLength(1);
  });

  it("ignores Cmd/Ctrl+Enter while an IME composition is active", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    clickPageElement(place(document.getElementById("cta")!));
    typeDraft(h, "compose");
    pressKey(editorInput(h), "Enter", { metaKey: true, isComposing: true });

    expect(h.submitRequests).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(editorVisible(h)).toBe(true);
  });

  it("hides fully offscreen marks and refreshes their positions on the next sync", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!, -60, -60);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "offscreen");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.display).toBe("none");
    expect(badge.style.display).toBe("none");

    vi.mocked(button.getBoundingClientRect).mockReturnValue(rectAt(80, 90));
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(outline.style.display).toBe("block");
    expect(outline.style.left).toBe("80px");
    expect(outline.style.top).toBe("90px");
    expect(badge.style.display).toBe("flex");
  });

  it("keeps the badge usable when its target is smaller than the badge", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rectAt(40, 40, 16, 16),
    );
    h.overlay.setDesignMode(true);
    await annotate(h, button, "small target");

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

  it("keeps the badge visible when only a sliver of its target intersects the viewport", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rectAt(-18, 40, 20, 20),
    );
    h.overlay.setDesignMode(true);
    await annotate(h, button, "partially visible");

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    const badge = badges(h)[0]!;

    expect(outline.style.left).toBe("0px");
    expect(outline.style.width).toBe("2px");
    expect(badge.style.display).toBe("flex");
    expect(badge.style.left).toBe("8px");
  });

  it("clips marks and badge placement to nested scrolling ancestors", async () => {
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
    await annotate(h, button, "nested");

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
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(outline.style.display).toBe("none");
    expect(badge.style.display).toBe("none");
  });

  it("rebinds a uniquely selected DOM replacement and keeps its stable annotation id", async () => {
    const h = harness();
    const original = place(document.getElementById("cta")!, 40, 40);
    h.overlay.setDesignMode(true);
    await annotate(h, original, "Original comment");
    const originalId = h.saved[0]!.annotation.id;
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

    // The rebind kept the annotation's identity: the edit reports the same id
    // with the re-measured rect, not a new mark.
    expect(h.saved).toHaveLength(2);
    expect(h.saved[h.saved.length - 1]!.annotation).toMatchObject({
      id: originalId,
      index: 1,
      selector: "#cta",
      rect: { x: 120, y: 130 },
      comment: "Updated comment",
    });
  });

  it("does not rebind a disconnected annotation to an ambiguous selector", async () => {
    const h = harness();
    const original = place(document.getElementById("cta")!);
    h.overlay.setDesignMode(true);
    await annotate(h, original, "Original comment");
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
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.annotation.comment).toBe("Original comment");
  });

  it("reclaims the shared badge corner immediately after deleting an earlier mark", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!, 40, 40);
    const paragraph = place(document.getElementById("copy")!, 40, 40);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "first");
    await annotate(h, paragraph, "second");
    const survivingBadge = badges(h)[1]!;
    expect(survivingBadge.style.left).toBe("46px");

    clickPageElement(button);
    editorButton(h, "delete").click();

    expect(survivingBadge.textContent).toBe("1");
    expect(survivingBadge.style.left).toBe("70px");
    expect(badges(h)).toHaveLength(1);
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
    expect(h.saved).toHaveLength(0);
  });

  it("marks the element inside the page's own shadow root, not its host", async () => {
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
    await nextFrames();

    // `event.target` is retargeted to the host at the window; the composed
    // path still names what the user actually pointed at.
    expect(h.saved[0]!.annotation).toMatchObject({ tag: "a", text: "Inner link" });
  });

  it("keeps a mark on its element as the page scrolls", async () => {
    const h = harness();
    const button = document.getElementById("cta")!;
    const measure = vi.spyOn(button, "getBoundingClientRect");

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    measure.mockReturnValue(rectAt(12, 200));
    h.overlay.setDesignMode(true);
    await annotate(h, button, "scroll test");

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

  it("takes its overlay and its listeners with it when disposed", () => {
    const h = harness();

    h.overlay.setDesignMode(true);
    h.overlay.dispose();

    expect(document.querySelector(annotationOverlayHostTag)).toBeNull();

    clickPageElement(document.getElementById("cta")!);
    expect(h.saved).toHaveLength(0);
  });
});

describe("annotation overlay — store sync", () => {
  function serverAnnotation(
    id: string,
    index: number,
    selector = "#cta",
    comment = "from the store",
  ): BrowserAnnotationElement {
    return {
      id,
      index,
      selector,
      tag: "button",
      rect: { x: 40, y: 40, width: 40, height: 20 },
      comment,
    };
  }

  it("restores an unknown annotation by selector and reports it present", () => {
    const h = harness();

    place(document.getElementById("cta")!);
    h.overlay.syncAnnotations([serverAnnotation("srv-1", 3)]);

    // The mark renders with the Session's index, not a local one.
    expect(badges(h)[0]?.textContent).toBe("3");
    expect(h.presence).toEqual([{ id: "srv-1", stale: false }]);
  });

  it("restores a mark whose element arrives after the sync", async () => {
    const h = harness();

    h.overlay.syncAnnotations([serverAnnotation("srv-1", 1, "#late")]);
    expect(badges(h)).toHaveLength(0);
    expect(h.presence).toEqual([]);

    // An SPA filling its DOM in — the observer keeps watching rather than
    // declaring the element gone.
    const late = document.createElement("button");
    late.id = "late";
    document.body.append(late);
    await nextFrames();

    expect(badges(h)[0]?.textContent).toBe("1");
    expect(h.presence).toEqual([{ id: "srv-1", stale: false }]);
  });

  it("reports a restore stale when the element never arrives", async () => {
    vi.useFakeTimers();
    const h = harness();

    try {
      h.overlay.syncAnnotations([serverAnnotation("srv-1", 1, "#never")]);

      await vi.advanceTimersByTimeAsync(5000);

      expect(h.presence).toEqual([{ id: "srv-1", stale: true }]);
      expect(badges(h)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes marks the sync no longer knows and renumbers the survivors", async () => {
    const h = harness();
    const cta = place(document.getElementById("cta")!, 40, 40);
    const copy = place(document.getElementById("copy")!, 40, 300);

    h.overlay.setDesignMode(true);
    await annotate(h, cta, "first");
    await annotate(h, copy, "second");

    const [first, second] = h.saved.map((save) => save.annotation);

    // The store says: the first comment is gone, the second is now #1.
    h.overlay.syncAnnotations([{ ...second!, index: 1 }]);

    expect(badges(h).map((badge) => badge.textContent)).toEqual(["1"]);
    expect(first).toBeDefined();
    // Local removal is silent — the store ordered it, it is not a delete.
    expect(h.deleted).toEqual([]);
  });

  it("closes the editor when the annotation it edits is synced away", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "edited elsewhere");
    clickPageElement(button);
    expect(editorVisible(h)).toBe(true);

    h.overlay.syncAnnotations([]);

    // The comment this draft was writing to no longer exists.
    expect(editorVisible(h)).toBe(false);
  });

  it("rebinds a mark whose element a re-render replaced, on the next position pass", async () => {
    const h = harness();
    const original = place(document.getElementById("cta")!, 40, 40);

    h.overlay.setDesignMode(true);
    await annotate(h, original, "Original comment");

    original.remove();
    const replacement = document.createElement("button");
    replacement.id = "cta";
    place(replacement, 120, 130);
    document.querySelector("main")!.append(replacement);

    // The next layout sync — scroll, resize, a sibling render — reconciles
    // before hiding: the mark follows its selector to the replacement node.
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    expect(outline.style.display).toBe("block");
    expect(outline.style.left).toBe("120px");
    expect(outline.style.top).toBe("130px");
    expect(badges(h)).toHaveLength(1);
  });

  it("sends a disconnected mark back through the restore watch on a later sync", async () => {
    const h = harness();
    const original = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, original, "Original comment");
    const annotation = h.saved[0]!.annotation;

    original.remove();

    // Still wanted by the store: the dead entry is dropped and the restore
    // watch takes over — not stale until the wait itself runs out.
    h.overlay.syncAnnotations([annotation]);
    expect(badges(h)).toHaveLength(0);

    const replacement = document.createElement("button");
    replacement.id = "cta";
    place(replacement, 120, 130);
    document.querySelector("main")!.append(replacement);
    await nextFrames();

    expect(badges(h)).toHaveLength(1);
    expect(h.presence).toEqual([{ id: annotation.id, stale: false }]);
  });

  it("reports a disconnected mark stale when its replacement never arrives", async () => {
    const h = harness();
    const original = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, original, "Original comment");
    const annotation = h.saved[0]!.annotation;
    original.remove();

    vi.useFakeTimers();
    try {
      h.overlay.syncAnnotations([annotation]);
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }

    expect(h.presence).toEqual([{ id: annotation.id, stale: true }]);
    expect(badges(h)).toHaveLength(0);
  });

  it("renders the store's latest annotation when a delayed element finally appears", async () => {
    const h = harness();
    const delayed = serverAnnotation("srv-1", 2, "#late", "original");

    h.overlay.setDesignMode(true);
    h.overlay.syncAnnotations([delayed]);
    expect(badges(h)).toHaveLength(0);

    // Renumbered and re-edited while the element was still missing — what
    // arrives must draw the newest shape, not the snapshot that watched for it.
    h.overlay.syncAnnotations([
      { ...delayed, index: 1, comment: "edited elsewhere" },
    ]);

    const late = document.createElement("button");
    late.id = "late";
    place(late, 120, 130);
    document.body.append(late);
    await nextFrames();

    expect(badges(h)[0]?.textContent).toBe("1");
    clickPageElement(late);
    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("edited elsewhere");
  });
});

describe("annotation overlay — area selection", () => {
  function selectionBox(h: ReturnType<typeof harness>) {
    return h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-selection"]')!;
  }

  function editorAbsent(h: ReturnType<typeof harness>) {
    const box = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-editor"]');

    // Either never built or hidden — what matters is nothing opens.
    return box === null || box.style.display === "none";
  }

  function areaAnnotation(id: string, index: number, selector = "#cta") {
    return {
      id,
      index,
      selector,
      tag: "button",
      rect: { x: 50, y: 50, width: 20, height: 10 },
      area: { x: 10, y: 10, width: 20, height: 10 },
      comment: "area note",
    };
  }

  it("keeps a press that stays within 4px a click, saving an element annotation", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 52, 52, { buttons: 1 });
    pointer(button, "pointerup", 52, 52, { button: 0, buttons: 0 });
    clickPageElement(button);

    expect(editorVisible(h)).toBe(true);

    typeDraft(h, "still a click");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.annotation).toMatchObject({
      tag: "button",
      comment: "still a click",
    });
    expect(h.saved[0]!.annotation).not.toHaveProperty("area");
  });

  it("draws a selection box past 4px, opens the area editor on release and swallows the trailing click", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    hoverPageElement(button);

    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });

    const box = selectionBox(h);
    const highlight = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-highlight"]')!;
    const label = h
      .shadow()
      .querySelector<HTMLElement>('[data-slot="annotation-highlight-label"]')!;

    // The drag took over: the hover frame is gone, the box carries the size.
    expect(box.hidden).toBe(false);
    expect(box.style.left).toBe("50px");
    expect(box.style.top).toBe("50px");
    expect(box.style.width).toBe("150px");
    expect(box.style.height).toBe("100px");
    expect(highlight.hidden).toBe(true);
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe("150×100");

    pointer(button, "pointerup", 200, 150, { button: 0, buttons: 0 });

    expect(box.hidden).toBe(true);
    expect(editorVisible(h)).toBe(true);
    // The area editor anchors below the area's own rect, not an element's.
    expect(editor(h).style.top).toBe("158px");

    // The release's click belongs to the drag — re-targeting the editor to
    // the element under it would silently drop the area the user drew.
    clickPageElement(button);
    expect(editorVisible(h)).toBe(true);
    expect(editor(h).style.top).toBe("158px");

    typeDraft(h, "widen this region");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.annotation).toMatchObject({
      tag: "main",
      rect: { x: 50, y: 50, width: 150, height: 100 },
      // The anchor is <main> (0,0): the offsets equal the viewport coords.
      area: { x: 50, y: 50, width: 150, height: 100 },
      comment: "widen this region",
    });
    // The anchor's text would describe the element, not the marked region.
    expect(h.saved[0]!.annotation).not.toHaveProperty("text");
  });

  it("anchors an area to the smallest element that fully contains it", async () => {
    const h = harness();

    document.body.innerHTML =
      '<div id="outer"><div id="inner"><b id="start">x</b></div></div>';
    place(document.getElementById("outer")!, 0, 0, 400, 400);
    place(document.getElementById("inner")!, 100, 100, 200, 200);
    const start = place(document.getElementById("start")!, 110, 110, 10, 10);

    h.overlay.setDesignMode(true);
    drag(start, 110, 110, 250, 250);
    typeDraft(h, "inner region");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    // #inner (100..300) contains the 110..250 drag; #outer does too, later.
    expect(h.saved[0]!.annotation).toMatchObject({
      selector: "#inner",
      tag: "div",
      rect: { x: 110, y: 110, width: 140, height: 140 },
      area: { x: 10, y: 10, width: 140, height: 140 },
    });
  });

  it("anchors on body when nothing smaller contains the area", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 300, 300);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    drag(button, 50, 50, 400, 350);
    typeDraft(h, "whole page");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    // jsdom's body measures empty, so the climb reaches it by exhaustion.
    expect(h.saved[0]!.annotation.tag).toBe("body");
    expect(h.saved[0]!.annotation).toMatchObject({
      rect: { x: 50, y: 50, width: 350, height: 300 },
      area: { x: 50, y: 50, width: 350, height: 300 },
    });
  });

  it("skips SVG interiors while climbing for an anchor", async () => {
    const h = harness();

    document.body.innerHTML =
      '<div id="panel"><svg id="icon" viewBox="0 0 10 10"><path id="stroke" d="M0 0h10"/></svg></div>';
    place(document.getElementById("panel")!, 0, 0, 200, 200);
    place(document.getElementById("icon")!, 40, 40, 100, 100);
    const stroke = place(document.getElementById("stroke")!, 45, 45, 80, 80);

    h.overlay.setDesignMode(true);
    drag(stroke, 50, 50, 120, 120);
    typeDraft(h, "icon area");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    // The path's box contains the drag, but an SVG interior cannot anchor:
    // the <svg> is the first containing ancestor that counts.
    expect(h.saved[0]!.annotation).toMatchObject({
      selector: "#icon",
      tag: "svg",
      area: { x: 10, y: 10, width: 70, height: 70 },
    });
  });

  it("discards a drag released under 4px on either axis, swallowing the click", () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    // A wide but 3px-tall scratch: past the drag threshold, under the area one.
    drag(button, 50, 50, 300, 53);

    expect(editorAbsent(h)).toBe(true);
    expect(selectionBox(h).hidden).toBe(true);
    expect(h.saved).toHaveLength(0);
  });

  it("cancels an in-flight drag on Escape, swallowing the release and its click", () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });
    expect(selectionBox(h).hidden).toBe(false);

    pressKey(window, "Escape");

    // Escape killed the gesture, not the mode.
    expect(selectionBox(h).hidden).toBe(true);
    expect(h.designModeChanges).toEqual([]);

    pointer(button, "pointerup", 200, 150, { button: 0, buttons: 0 });
    clickPageElement(button);

    expect(editorAbsent(h)).toBe(true);
    expect(h.saved).toHaveLength(0);
  });

  it("cancels an open area editor on Escape without a report", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    drag(button, 50, 50, 200, 150);
    typeDraft(h, "half a note");
    pressKey(editorInput(h), "Escape");

    expect(editorVisible(h)).toBe(false);
    expect(h.designModeChanges).toEqual([]);

    await nextFrames();
    expect(h.saved).toHaveLength(0);
  });

  it("never cancels the page's wheel events mid-drag", () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });

    // Marking a region must not trap scrolling — the box stays viewport-fixed.
    const wheel = new MouseEvent("wheel", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    button.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(selectionBox(h).hidden).toBe(false);
  });

  it("aborts an armed drag when the pointer returns with no buttons pressed", () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    // Released outside the window: the next move reports buttons: 0 and the
    // gesture is dead whether or not a pointerup ever reaches the page.
    pointer(button, "pointermove", 200, 150, { buttons: 0 });

    expect(selectionBox(h).hidden).toBe(true);

    pointer(button, "pointerup", 200, 150, { button: 0, buttons: 0 });
    clickPageElement(button);

    expect(editorAbsent(h)).toBe(true);
    expect(h.saved).toHaveLength(0);
  });

  it("aborts an in-flight drag the same way", () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });
    expect(selectionBox(h).hidden).toBe(false);

    pointer(button, "pointermove", 300, 200, { buttons: 0 });

    expect(selectionBox(h).hidden).toBe(true);

    pointer(button, "pointerup", 300, 200, { button: 0, buttons: 0 });
    clickPageElement(button);

    expect(editorAbsent(h)).toBe(true);
  });

  it("opens a fresh element draft when an area's anchor element is clicked", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    drag(button, 50, 50, 200, 150);
    typeDraft(h, "the region");
    pressKey(editorInput(h), "Enter");
    await nextFrames();
    expect(h.saved[0]!.annotation.area).toBeDefined();

    clickPageElement(document.querySelector("main")!);

    // An area mark never owns its anchor: this is a new element draft on
    // <main>, not the saved area's editor (no Delete, empty text).
    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("");
    expect(editorButton(h, "delete").style.display).toBe("none");
  });

  it("restores an area at its anchor's rect plus the saved offset, and follows the anchor", async () => {
    const h = harness();
    const button = place(document.getElementById("cta")!);

    h.overlay.syncAnnotations([areaAnnotation("srv-a", 1)]);

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;

    expect(outline.style.left).toBe("50px");
    expect(outline.style.top).toBe("50px");
    expect(outline.style.width).toBe("20px");
    expect(outline.style.height).toBe("10px");
    // Dashed, unlike an element's solid frame — regions are not elements.
    expect(outline.style.cssText).toContain("dashed");
    expect(h.presence).toEqual([{ id: "srv-a", stale: false }]);

    // The anchor moved: the mark re-derives its rect from the offset.
    vi.mocked(button.getBoundingClientRect).mockReturnValue(rectAt(80, 90));
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(outline.style.left).toBe("90px");
    expect(outline.style.top).toBe("100px");
  });

  it("reports a missing area anchor stale after the restore wait", async () => {
    vi.useFakeTimers();
    const h = harness();

    try {
      h.overlay.syncAnnotations([areaAnnotation("srv-a", 1, "#never")]);

      await vi.advanceTimersByTimeAsync(5000);

      expect(h.presence).toEqual([{ id: "srv-a", stale: true }]);
      expect(badges(h)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores the anchor's own scroll in the offset when the area is saved", async () => {
    const h = harness();

    document.body.innerHTML =
      '<div id="scrollbox"><p id="start">inside</p></div>';
    const box = place(document.getElementById("scrollbox")!, 40, 40, 200, 200);
    const start = place(document.getElementById("start")!, 50, 50, 20, 10);
    vi.spyOn(box, "scrollTop", "get").mockReturnValue(100);

    h.overlay.setDesignMode(true);
    drag(start, 60, 60, 160, 110);
    typeDraft(h, "inside the scroller");
    pressKey(editorInput(h), "Enter");
    await nextFrames();

    // The box does not move when its content scrolls, so the offset has to
    // carry scrollTop to keep naming the same content.
    expect(h.saved[0]!.annotation).toMatchObject({
      selector: "#scrollbox",
      rect: { x: 60, y: 60, width: 100, height: 50 },
      area: { x: 20, y: 120, width: 100, height: 50 },
    });
  });

  it("moves the outline with the content when the anchor scrolls its content", async () => {
    const h = harness();

    document.body.innerHTML = '<div id="scrollbox"><p>x</p></div>';
    const box = place(document.getElementById("scrollbox")!, 40, 40, 200, 200);
    const scrollTop = vi.spyOn(box, "scrollTop", "get").mockReturnValue(100);

    // area.y = 120 in content coords: 40 + 120 - 100 = 60 on screen.
    h.overlay.syncAnnotations([
      {
        ...areaAnnotation("srv-a", 1, "#scrollbox"),
        tag: "div",
        rect: { x: 50, y: 60, width: 40, height: 20 },
        area: { x: 10, y: 120, width: 40, height: 20 },
      },
    ]);

    const outline = h.shadow().querySelector<HTMLElement>(
      '[data-slot="annotation-outline"]',
    )!;
    expect(outline.style.top).toBe("60px");

    // The anchor's rect is unchanged but its content moved: a mark pinned
    // to the box alone would slide over different content.
    scrollTop.mockReturnValue(130);
    window.dispatchEvent(new Event("scroll"));
    await nextFrames();

    expect(outline.style.top).toBe("30px");
  });

  it("lets a badge open after a drag's trailing click landed on it", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "saved mark");
    const badge = badges(h)[0]!;

    // A drag released under the area threshold, with its trailing click
    // landing on a saved badge: the badge swallows it — and the swallow
    // clears the flag itself, so the next click is not eaten.
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });
    pointer(button, "pointerup", 200, 52, { button: 0, buttons: 0 });
    badge.click();

    expect(editorAbsent(h)).toBe(true);

    badge.click();

    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("saved mark");
  });

  it("re-arms the click swallow on a pointerdown over overlay chrome", async () => {
    const h = harness();
    place(document.querySelector("main")!, 0, 0, 600, 400);
    const button = place(document.getElementById("cta")!);

    h.overlay.setDesignMode(true);
    await annotate(h, button, "saved mark");
    const badge = badges(h)[0]!;

    // Same dead drag, but the next gesture starts on the badge itself: a
    // pointerdown over overlay chrome must still reset the swallow — the
    // page-target early return cannot be where it is re-armed.
    pointer(button, "pointerdown", 50, 50, { button: 0, buttons: 1 });
    pointer(button, "pointermove", 200, 150, { buttons: 1 });
    pointer(button, "pointerup", 200, 52, { button: 0, buttons: 0 });
    pointer(badge, "pointerdown", 0, 0, { button: 0, buttons: 1 });
    badge.click();

    expect(editorVisible(h)).toBe(true);
    expect(editorInput(h).value).toBe("saved mark");
  });
});
