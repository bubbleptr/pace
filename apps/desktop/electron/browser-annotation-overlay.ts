import {
  describeAnnotatedElement,
  maxCommentLength,
  readSource,
  resolveAnnotationTarget,
} from "./browser-annotation";
import type {
  BrowserAnnotationElement,
  BrowserAnnotationPalette,
  BrowserAnnotationViewport,
} from "@/shared/browser-protocol";

/**
 * The annotation-mode overlay, as it runs inside the embedded page's isolated
 * world: a host element under `<html>` with a **closed** shadow root holding
 * the hover highlight, the mode chrome (frame + pill), the saved marks
 * (outline + numbered badge) and the comment editor.
 *
 * Electron-free on purpose — the preload only wires it to IPC — so every
 * interaction rule below is testable in jsdom.
 *
 * Lifecycle (decision 1 of `.scratch/browser-annotation-v2/PRD.md`): a click
 * opens a focused *draft* editor — not yet an annotation, and main hears
 * nothing until Save/Enter commits it. Cancel/Esc discards without a trace.
 * Clicking a saved element or its badge re-opens that annotation's editor
 * (with Delete); an empty comment can never be saved.
 *
 * Two properties of the host page drive the implementation:
 *
 * - **It is hostile.** The shadow root is closed, so page script can see the
 *   host element but never read what is in it (S0 spike, third result). It can
 *   still remove the host; defending against that is out of scope for v1.
 * - **It may forbid nearly everything.** Structure is built with DOM calls and
 *   styled through CSSOM instead of `innerHTML` and a `<style>` element:
 *   Trusted Types blocks the first and a strict `style-src` the second, and
 *   the overlay has to work on pages that ship both.
 */

export const annotationOverlayHostTag = "pigui-annotation-overlay";

type AnnotationEntry = {
  annotation: BrowserAnnotationElement;
  /** Kept so outline and badge can be re-measured; the rect it reported cannot. */
  element: Element;
  outline: HTMLElement;
  badge: HTMLButtonElement;
};

/** The one open editor: what it annotates, and what it started with. */
type EditorState = {
  element: Element;
  annotationId: string | null;
  savedText: string;
};

export type BrowserAnnotationOverlay = {
  setDesignMode(enabled: boolean, palette?: BrowserAnnotationPalette): void;
  setAnnotationPalette(palette: BrowserAnnotationPalette): void;
  clearAnnotations(): void;
  /**
   * Put the overlay out of shot and say what it holds, so main can photograph
   * the page without the overlay's own chrome on it. A draft worth keeping is
   * saved first: asking for the shot is intent to send.
   */
  prepareCapture(): void;
  /** The shot is done — the mode chrome `prepareCapture` hid comes back. */
  finishCapture(): void;
  dispose(): void;
};

type OverlayColors = {
  accent: string;
  accentForeground: string;
  surface: string;
  foreground: string;
  border: string;
  muted: string;
};

const defaultColors: OverlayColors = {
  accent: "#6d28d9",
  accentForeground: "#ffffff",
  surface: "#ffffff",
  foreground: "#111827",
  border: "#e5e7eb",
  muted: "#6b7280",
};

const overlayFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/**
 * Pointer events design mode swallows. `click` alone is not enough: a page
 * that acts on `mousedown` would still run while the user is only marking.
 */
const pointerEvents = [
  "pointerdown",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
];

const editorWidthPx = 280;

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function applyStyles(element: HTMLElement, styles: Record<string, string>) {
  for (const [property, value] of Object.entries(styles)) {
    // Important throughout: the host element sits in the page's own tree, so
    // a broad page rule could otherwise hide or move the whole overlay.
    element.style.setProperty(property, value, "important");
  }
}

/** A palette colour is honoured only if this page's CSS engine can parse it. */
function supportsColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("color", value)
  );
}

/**
 * The renderer's palette, field by field against the defaults: a token the
 * page cannot parse falls back alone, so one bad colour never costs the rest.
 */
function resolveOverlayPalette(palette: BrowserAnnotationPalette): OverlayColors {
  return {
    accent: supportsColor(palette.accent) ? palette.accent : defaultColors.accent,
    accentForeground: supportsColor(palette.accentForeground)
      ? palette.accentForeground
      : defaultColors.accentForeground,
    surface: supportsColor(palette.surface) ? palette.surface : defaultColors.surface,
    foreground: supportsColor(palette.foreground)
      ? palette.foreground
      : defaultColors.foreground,
    border: supportsColor(palette.border) ? palette.border : defaultColors.border,
    muted: supportsColor(palette.muted) ? palette.muted : defaultColors.muted,
  };
}

export function createAnnotationOverlay(options: {
  document: Document;
  onAnnotationsChange: (
    annotations: BrowserAnnotationElement[],
    viewport: BrowserAnnotationViewport,
  ) => void;
  onDesignModeChange: (enabled: boolean) => void;
  /** The ack main waits for before it shoots. */
  onCaptureReady: (
    annotations: BrowserAnnotationElement[],
    viewport: BrowserAnnotationViewport,
  ) => void;
}): BrowserAnnotationOverlay {
  const doc = options.document;
  // The earliest node in the capture path, so page handlers registered later
  // cannot swallow the events design mode needs.
  const listenerTarget: EventTarget = doc.defaultView ?? doc;
  const annotations: BrowserAnnotationElement[] = [];
  const entries = new Map<string, AnnotationEntry>();

  let colors: OverlayColors = { ...defaultColors };
  let designMode = false;
  let host: HTMLElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let highlight: HTMLElement | null = null;
  let highlightLabel: HTMLElement | null = null;
  let markerLayer: HTMLElement | null = null;
  let frame: HTMLElement | null = null;
  let pill: HTMLElement | null = null;
  let editorBox: HTMLElement | null = null;
  let editorText: HTMLTextAreaElement | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let deleteButton: HTMLButtonElement | null = null;
  let editor: EditorState | null = null;
  /** The resolved target of the last pointermove — the base ↑ climbs from. */
  let resolvedTarget: Element | null = null;
  /** What is actually framed now: the resolved target, or an ancestor ↑ chose. */
  let hoverTarget: Element | null = null;
  let markerSyncFrame = 0;

  function applyDesignMode(enabled: boolean) {
    designMode = enabled;

    if (enabled) {
      ensureHost();
      setModeAffordanceVisible(true);
    } else {
      hideHighlight();
      closeEditor();
      resolvedTarget = null;
      hoverTarget = null;
      setModeAffordanceVisible(false);
    }

    // Marks only take pointer events while marking; once annotation mode is
    // off the page has to be fully usable again with the marks still on it.
    if (markerLayer) {
      applyStyles(markerLayer, { "pointer-events": enabled ? "auto" : "none" });
    }
  }

  function setModeAffordanceVisible(visible: boolean) {
    if (frame) {
      applyStyles(frame, { display: visible ? "block" : "none" });
    }
    if (pill) {
      applyStyles(pill, { display: visible ? "block" : "none" });
    }
  }

  // -- Colour-dependent styles, reapplied whenever a new palette lands.

  function styleHighlight() {
    applyStyles(highlight!, {
      border: `2px solid ${colors.accent}`,
      background: `color-mix(in srgb, ${colors.accent} 12%, transparent)`,
    });
  }

  function styleHighlightLabel() {
    applyStyles(highlightLabel!, {
      background: colors.foreground,
      color: colors.surface,
    });
  }

  function styleFrame() {
    applyStyles(frame!, {
      "box-shadow": `inset 0 0 0 2px ${colors.accent}`,
    });
  }

  function stylePill() {
    applyStyles(pill!, {
      background: colors.surface,
      color: colors.foreground,
      border: `1px solid ${colors.border}`,
    });
  }

  function styleOutline(outline: HTMLElement) {
    applyStyles(outline, { border: `1.5px solid ${colors.accent}` });
  }

  function styleBadge(badge: HTMLButtonElement) {
    applyStyles(badge, {
      background: colors.accent,
      color: colors.accentForeground,
    });
  }

  function styleEditor() {
    applyStyles(editorBox!, {
      background: colors.surface,
      border: `1px solid ${colors.border}`,
    });
    applyStyles(editorText!, {
      background: colors.surface,
      color: colors.foreground,
      border: `1px solid ${colors.border}`,
    });
    applyStyles(saveButton!, {
      background: colors.accent,
      color: colors.accentForeground,
    });
    applyStyles(deleteButton!, { color: colors.muted });
  }

  function restyle() {
    if (highlight) styleHighlight();
    if (highlightLabel) styleHighlightLabel();
    if (frame) styleFrame();
    if (pill) stylePill();
    if (editorBox) styleEditor();
    for (const entry of entries.values()) {
      styleOutline(entry.outline);
      styleBadge(entry.badge);
    }
  }

  function applyAnnotationPalette(palette: BrowserAnnotationPalette) {
    colors = resolveOverlayPalette(palette);
    restyle();
  }

  function ensureHost() {
    if (host) {
      return host;
    }

    const parent = doc.documentElement;

    // A preload runs before the document has a root element; every caller here
    // can only run once the user has seen the page, so this never sticks.
    if (!parent) {
      return null;
    }

    host = doc.createElement(annotationOverlayHostTag);
    applyStyles(host, {
      position: "absolute",
      inset: "0 auto auto 0",
      width: "0",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      "pointer-events": "none",
      "z-index": "2147483647",
    });

    const root = host.attachShadow({ mode: "closed" });
    shadowRoot = root;

    // The frame and pill are how the user knows the page is being annotated
    // at all — they only exist while the mode is on, and never take events.
    frame = doc.createElement("div");
    frame.dataset.slot = "annotation-frame";
    applyStyles(frame, {
      position: "fixed",
      inset: "0",
      display: designMode ? "block" : "none",
      "pointer-events": "none",
    });
    styleFrame();

    pill = doc.createElement("div");
    pill.dataset.slot = "annotation-pill";
    pill.textContent = "Annotating · Esc to exit";
    applyStyles(pill, {
      position: "fixed",
      top: "10px",
      left: "50%",
      transform: "translateX(-50%)",
      margin: "0",
      padding: "4px 12px",
      "border-radius": "999px",
      display: designMode ? "block" : "none",
      font: `600 11px/16px ${overlayFont}`,
      "white-space": "nowrap",
      "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.35)",
      "pointer-events": "none",
    });
    stylePill();

    highlight = doc.createElement("div");
    highlight.dataset.slot = "annotation-highlight";
    highlight.hidden = true;
    applyStyles(highlight, {
      position: "fixed",
      "box-sizing": "border-box",
      "border-radius": "2px",
      "pointer-events": "none",
    });
    styleHighlight();

    // The element under the pointer, named: `tag.firstClass · W×H`, with the
    // dev-server source location when one was stamped.
    highlightLabel = doc.createElement("div");
    highlightLabel.dataset.slot = "annotation-highlight-label";
    highlightLabel.hidden = true;
    applyStyles(highlightLabel, {
      position: "fixed",
      margin: "0",
      padding: "1px 6px",
      "border-radius": "3px",
      font: `500 10px/14px ${overlayFont}`,
      "white-space": "nowrap",
      "pointer-events": "none",
    });
    styleHighlightLabel();

    markerLayer = doc.createElement("div");
    markerLayer.dataset.slot = "annotation-markers";
    applyStyles(markerLayer, {
      position: "absolute",
      top: "0",
      left: "0",
      // Annotation mode can be turned on before the document has a root element
      // to hang this on, so the layer arms itself from the current state rather
      // than waiting for the next toggle.
      "pointer-events": designMode ? "auto" : "none",
    });

    root.append(frame, highlight, highlightLabel, markerLayer, pill);
    parent.append(host);

    return host;
  }

  /**
   * The page's own viewport, which is the space every rect above was measured
   * in — and, unlike the panel's rect on the other side of the IPC, it is
   * still the right one when the user resizes the panel before sending.
   */
  function readViewport(): BrowserAnnotationViewport {
    const view = doc.defaultView;

    return {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      dpr: view?.devicePixelRatio ?? 1,
    };
  }

  function notify() {
    options.onAnnotationsChange(
      annotations.map((annotation) => ({ ...annotation })),
      readViewport(),
    );
  }

  /**
   * True when the event began inside our own closed shadow tree — or above
   * the page entirely (window/document), which is where synthetic key events
   * land. `composedPath()` stops at the host for a closed root where the spec
   * is honoured, but Chromium has historically exposed the internals too, so
   * the root itself is what decides, not the first path entry's name.
   */
  function isOverlayEvent(event: Event) {
    const [target] = event.composedPath();

    return (
      !(target instanceof Element) ||
      target === host ||
      (shadowRoot !== null && target.getRootNode() === shadowRoot)
    );
  }

  /** The element the user is pointing at, or null when it is our own overlay. */
  function pageTarget(event: Event) {
    return isOverlayEvent(event) ? null : (event.composedPath()[0] as Element);
  }

  // -- Hover highlight ----------------------------------------------------

  function hideHighlight() {
    if (highlight) {
      highlight.hidden = true;
    }
    if (highlightLabel) {
      highlightLabel.hidden = true;
    }
  }

  function describeHoverTarget(element: Element) {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const firstClass = element.classList.item(0);
    const size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const source = readSource(element);

    return (
      `${tag}${firstClass ? `.${firstClass.slice(0, 24)}` : ""} · ${size}` +
      (source ? ` · ${source.file}:${source.line}` : "")
    );
  }

  function showHighlight(element: Element) {
    if (!ensureHost() || !highlight || !highlightLabel) {
      return;
    }

    const rect = element.getBoundingClientRect();

    applyStyles(highlight, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    highlight.hidden = false;

    highlightLabel.textContent = describeHoverTarget(element);

    // Above the box by default; when there is no room up there the label goes
    // below rather than under the toolbar.
    const labelRect = highlightLabel.getBoundingClientRect();
    const labelHeight = labelRect.height || highlightLabel.offsetHeight;
    const labelWidth = labelRect.width || highlightLabel.offsetWidth;
    const viewport = readViewport();
    const top =
      rect.top - labelHeight - 4 >= 4 ? rect.top - labelHeight - 4 : rect.bottom + 4;

    applyStyles(highlightLabel, {
      left: `${clampValue(rect.left, 4, Math.max(4, viewport.width - labelWidth - 4))}px`,
      top: `${top}px`,
    });
    highlightLabel.hidden = false;
  }

  // -- Saved marks: outline + badge ---------------------------------------

  /**
   * Marks are fixed to the viewport and re-measured, not pinned to where the
   * element was when it was marked: a scroll — of the window or of any nested
   * container — or a reflow would otherwise leave the badge sitting over
   * something else, in the page and on the screenshot alike.
   */
  function positionEntries() {
    if (!markerLayer) {
      return;
    }

    const viewport = readViewport();
    const reconciled = reconcileEntries();
    const placed: { x: number; y: number; width: number; height: number }[] = [];

    // Annotation order is creation order, so the earlier badge always wins
    // the corner and the later one steps aside.
    for (const annotation of annotations) {
      const entry = entries.get(annotation.id);

      if (!entry) {
        continue;
      }

      const elementRects = visibleElementRect(entry.element, viewport);

      if (!elementRects) {
        applyStyles(entry.outline, { display: "none" });
        applyStyles(entry.badge, { display: "none" });
        continue;
      }
      const { visible, clipping } = elementRects;

      applyStyles(entry.outline, {
        display: "block",
        left: `${visible.left}px`,
        top: `${visible.top}px`,
        width: `${visible.right - visible.left}px`,
        height: `${visible.bottom - visible.top}px`,
      });

      const badgeWidth = entry.badge.offsetWidth || 20;
      const badgeHeight = entry.badge.offsetHeight || 20;
      const clippedX = clipping.left > 0 || clipping.right < viewport.width;
      const clippedY = clipping.top > 0 || clipping.bottom < viewport.height;
      const minimumX = clippedX ? clipping.left : 8;
      const minimumY = clippedY ? clipping.top : 8;
      const maximumX = clippedX
        ? clipping.right - badgeWidth
        : viewport.width - badgeWidth - 8;
      const maximumY = clippedY
        ? clipping.bottom - badgeHeight
        : viewport.height - badgeHeight - 8;
      if (maximumX < minimumX || maximumY < minimumY) {
        applyStyles(entry.badge, { display: "none" });
        continue;
      }

      // Centre the badge on the visible top-right corner, then keep it within
      // the viewport or scroll-container clipping bounds.
      let badgeX = clampValue(
        visible.right - badgeWidth / 2,
        minimumX,
        maximumX,
      );
      const badgeY = clampValue(
        visible.top - badgeHeight / 2,
        minimumY,
        maximumY,
      );

      // …and shifted left while it would sit on an earlier badge (nested
      // elements share the corner).
      while (
        placed.some(
          (other) =>
            badgeX < other.x + other.width &&
            other.x < badgeX + badgeWidth &&
            badgeY < other.y + other.height &&
            other.y < badgeY + badgeHeight,
        )
      ) {
        if (badgeX - badgeWidth - 4 < minimumX) {
          break;
        }
        badgeX -= badgeWidth + 4;
      }

      placed.push({ x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight });
      applyStyles(entry.badge, {
        display: "flex",
        left: `${badgeX}px`,
        top: `${badgeY}px`,
      });
    }

    if (reconciled) {
      notify();
    }
  }

  function visibleElementRect(
    element: Element,
    viewport: BrowserAnnotationViewport,
  ) {
    if (!element.isConnected || element.ownerDocument !== doc) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    let clipLeft = 0;
    let clipTop = 0;
    let clipRight = viewport.width;
    let clipBottom = viewport.height;
    const view = doc.defaultView;

    for (
      let ancestor = element.parentElement;
      ancestor && clipLeft < clipRight && clipTop < clipBottom;
      ancestor = ancestor.parentElement
    ) {
      if (!view) {
        break;
      }

      const style = view.getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      const overflowX = style.overflowX || style.overflow;
      const overflowY = style.overflowY || style.overflow;

      if (["hidden", "clip", "auto", "scroll"].includes(overflowX)) {
        clipLeft = Math.max(clipLeft, ancestorRect.left + ancestor.clientLeft);
        clipRight = Math.min(
          clipRight,
          ancestorRect.left + ancestor.clientLeft + ancestor.clientWidth,
        );
      }
      if (["hidden", "clip", "auto", "scroll"].includes(overflowY)) {
        clipTop = Math.max(clipTop, ancestorRect.top + ancestor.clientTop);
        clipBottom = Math.min(
          clipBottom,
          ancestorRect.top + ancestor.clientTop + ancestor.clientHeight,
        );
      }
    }

    const left = Math.max(rect.left, clipLeft);
    const top = Math.max(rect.top, clipTop);
    const right = Math.min(rect.right, clipRight);
    const bottom = Math.min(rect.bottom, clipBottom);

    return left < right && top < bottom
      ? {
          visible: { left, top, right, bottom },
          clipping: {
            left: clipLeft,
            top: clipTop,
            right: clipRight,
            bottom: clipBottom,
          },
        }
      : null;
  }

  function reconcileEntries() {
    const owned = new Set<Element>();
    let changed = false;

    for (const entry of entries.values()) {
      if (entry.element.isConnected && entry.element.ownerDocument === doc) {
        owned.add(entry.element);
      }
    }

    for (const annotation of annotations) {
      const entry = entries.get(annotation.id);

      if (!entry || (entry.element.isConnected && entry.element.ownerDocument === doc)) {
        continue;
      }

      let matches: NodeListOf<Element>;
      try {
        matches = doc.querySelectorAll(entry.annotation.selector);
      } catch {
        continue;
      }

      if (matches.length !== 1 || owned.has(matches[0]!)) {
        continue;
      }

      const replacement = matches[0]!;
      const refreshed = describeAnnotatedElement(
        replacement,
        entry.annotation.index,
        entry.annotation.id,
      );
      if (entry.annotation.comment) {
        refreshed.comment = entry.annotation.comment;
      }
      const annotationIndex = annotations.indexOf(entry.annotation);

      if (annotationIndex !== -1) {
        annotations[annotationIndex] = refreshed;
      }
      entry.annotation = refreshed;
      entry.element = replacement;
      if (editor?.annotationId === refreshed.id) {
        editor.element = replacement;
      }
      owned.add(replacement);
      changed = true;
    }

    return changed;
  }

  /**
   * Anything anchored to an element re-measures in one frame: the marks, the
   * open editor, and the hover box. Scrolling is not blocked while an editor
   * is open, so it is not only the badges that would otherwise be left behind.
   */
  function syncOverlayPositions() {
    positionEntries();
    if (editor) {
      positionEditor(editor.element);
    }
    if (highlight && !highlight.hidden && hoverTarget) {
      showHighlight(hoverTarget);
    }
  }

  function scheduleMarkerSync() {
    const view = doc.defaultView;
    const hoverVisible = highlight !== null && !highlight.hidden;

    if (!view || markerSyncFrame || (entries.size === 0 && !editor && !hoverVisible)) {
      return;
    }

    markerSyncFrame = view.requestAnimationFrame(() => {
      markerSyncFrame = 0;
      syncOverlayPositions();
    });
  }

  function renderEntry(annotation: BrowserAnnotationElement, element: Element) {
    if (!ensureHost() || !markerLayer) {
      return;
    }

    const outline = doc.createElement("div");

    outline.dataset.slot = "annotation-outline";
    // Position and display both come from positionEntries, which is the only
    // thing that knows whether the element is still on the page.
    applyStyles(outline, {
      position: "fixed",
      "box-sizing": "border-box",
      "border-radius": "2px",
      "pointer-events": "none",
    });
    styleOutline(outline);

    const badge = doc.createElement("button");

    badge.type = "button";
    badge.dataset.slot = "annotation-badge";
    badge.textContent = String(annotation.index);
    applyStyles(badge, {
      position: "fixed",
      "align-items": "center",
      "justify-content": "center",
      "min-width": "20px",
      height: "20px",
      margin: "0",
      padding: "0 5px",
      border: "0",
      "border-radius": "10px",
      font: `600 11px/20px ${overlayFont}`,
      cursor: "pointer",
      "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.35)",
    });
    styleBadge(badge);
    badge.addEventListener("click", () => {
      const entry = entries.get(annotation.id);

      if (entry) {
        requestEditor(entry.element, entry);
      }
    });

    entries.set(annotation.id, { annotation, element, outline, badge });
    markerLayer.append(outline, badge);
    positionEntries();
  }

  function entryForElement(element: Element) {
    positionEntries();
    if (editor) {
      positionEditor(editor.element);
    }
    for (const entry of entries.values()) {
      if (entry.element === element) {
        return entry;
      }
    }
    return null;
  }

  /** Badges follow the list order: delete renumbers 1..N with no gaps. */
  function renumber() {
    annotations.forEach((annotation, position) => {
      annotation.index = position + 1;
      const entry = entries.get(annotation.id);

      if (entry) {
        entry.badge.textContent = String(annotation.index);
      }
    });
  }

  function deleteEntry(entry: AnnotationEntry) {
    annotations.splice(annotations.indexOf(entry.annotation), 1);
    entries.delete(entry.annotation.id);
    entry.outline.remove();
    entry.badge.remove();
    renumber();
    positionEntries();
    notify();
  }

  // -- The comment editor --------------------------------------------------

  function ensureEditor() {
    if (editorBox || !ensureHost() || !markerLayer) {
      return;
    }

    editorBox = doc.createElement("div");
    editorBox.dataset.slot = "annotation-editor";
    applyStyles(editorBox, {
      position: "fixed",
      display: "none",
      "flex-direction": "column",
      gap: "8px",
      "box-sizing": "border-box",
      width: `${editorWidthPx}px`,
      padding: "10px",
      "border-radius": "8px",
      "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
    });

    editorText = doc.createElement("textarea");
    editorText.dataset.slot = "annotation-editor-input";
    editorText.rows = 3;
    // Same ceiling main applies when it rebuilds the comment on the way in.
    editorText.maxLength = maxCommentLength;
    editorText.placeholder = "What is wrong here?";
    applyStyles(editorText, {
      "box-sizing": "border-box",
      width: "100%",
      margin: "0",
      padding: "6px 8px",
      "border-radius": "4px",
      font: `400 13px/18px ${overlayFont}`,
      resize: "none",
    });
    editorText.addEventListener("input", syncSaveEnabled);

    const row = doc.createElement("div");
    applyStyles(row, {
      display: "flex",
      "justify-content": "flex-end",
      gap: "6px",
    });

    deleteButton = doc.createElement("button");
    deleteButton.type = "button";
    deleteButton.dataset.slot = "annotation-editor-delete";
    deleteButton.textContent = "Delete";
    applyStyles(deleteButton, {
      display: "none",
      "margin-right": "auto",
      padding: "4px 8px",
      border: "0",
      "border-radius": "4px",
      background: "transparent",
      font: `500 12px/16px ${overlayFont}`,
      cursor: "pointer",
    });
    deleteButton.addEventListener("click", () => {
      const id = editor?.annotationId;
      const entry = id ? entries.get(id) : undefined;

      closeEditor();
      if (entry) {
        deleteEntry(entry);
      }
    });

    const cancelButton = doc.createElement("button");
    cancelButton.type = "button";
    cancelButton.dataset.slot = "annotation-editor-cancel";
    cancelButton.textContent = "Cancel";
    applyStyles(cancelButton, {
      padding: "4px 8px",
      border: "0",
      "border-radius": "4px",
      background: "transparent",
      font: `500 12px/16px ${overlayFont}`,
      cursor: "pointer",
    });
    cancelButton.addEventListener("click", () => closeEditor());

    saveButton = doc.createElement("button");
    saveButton.type = "button";
    saveButton.dataset.slot = "annotation-editor-save";
    saveButton.textContent = "Save";
    applyStyles(saveButton, {
      padding: "4px 10px",
      border: "0",
      "border-radius": "4px",
      font: `600 12px/16px ${overlayFont}`,
      cursor: "pointer",
    });
    saveButton.addEventListener("click", () => saveEditor());

    row.append(deleteButton, cancelButton, saveButton);
    editorBox.append(editorText, row);
    markerLayer.append(editorBox);
    styleEditor();
  }

  function syncSaveEnabled() {
    if (!editorText || !saveButton) {
      return;
    }

    // A comment is required: an empty mark was a misclick, not an annotation.
    const empty = editorText.value.trim() === "";
    saveButton.disabled = empty;
    applyStyles(saveButton, { opacity: empty ? "0.5" : "1" });
  }

  /**
   * Below the element by default; if it would run off the viewport bottom it
   * goes above, and if neither fits it clamps inside what room there is.
   */
  function positionEditor(element: Element) {
    if (!editorBox) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const viewport = readViewport();
    const elementRects = visibleElementRect(element, viewport);
    const anchor = elementRects?.visible ?? rect;
    const height =
      editorBox.getBoundingClientRect().height || editorBox.offsetHeight;

    let top = anchor.bottom + 8;

    if (top + height > viewport.height - 8) {
      top = anchor.top - 8 - height;
    }

    applyStyles(editorBox, {
      left: `${clampValue(anchor.left, 8, Math.max(8, viewport.width - editorWidthPx - 8))}px`,
      top: `${clampValue(top, 8, Math.max(8, viewport.height - height - 8))}px`,
    });
  }

  function openEditor(element: Element, entry?: AnnotationEntry) {
    ensureEditor();

    if (!editorBox || !editorText || !deleteButton) {
      return;
    }

    editor = {
      element,
      annotationId: entry?.annotation.id ?? null,
      savedText: entry?.annotation.comment ?? "",
    };
    editorText.value = editor.savedText;
    applyStyles(deleteButton, { display: entry ? "block" : "none" });
    syncSaveEnabled();
    // Shown before it is measured: a display:none box has no height, so the
    // flip-above check would always think there is room below.
    applyStyles(editorBox, { display: "flex" });
    positionEditor(element);
    editorText.focus();
    editorText.setSelectionRange(editorText.value.length, editorText.value.length);
  }

  /** Close without committing: a draft is discarded, an edit reverts. */
  function closeEditor() {
    editor = null;

    if (editorBox) {
      applyStyles(editorBox, { display: "none" });
    }
  }

  /**
   * Commit the draft. A click on another target while a changed non-empty
   * draft is open does not switch — it shakes instead, so typed text is
   * never silently lost.
   */
  function saveEditor() {
    if (!editor || !editorText) {
      return;
    }

    const comment = editorText.value.trim();

    if (!comment) {
      return;
    }

    const existing = editor.annotationId
      ? entries.get(editor.annotationId)
      : undefined;

    if (existing) {
      existing.annotation.comment = comment;
    } else {
      const annotation = describeAnnotatedElement(
        editor.element,
        annotations.length + 1,
        crypto.randomUUID(),
      );
      annotation.comment = comment;
      annotations.push(annotation);
      renderEntry(annotation, editor.element);
    }

    closeEditor();
    notify();
  }

  function shakeEditor() {
    const reduceMotion =
      doc.defaultView
        ?.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches === true;

    if (reduceMotion || typeof editorBox?.animate !== "function") {
      return;
    }

    editorBox.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(5px)" },
        { transform: "translateX(-3px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 200 },
    );
  }

  /**
   * Every request to open an editor — a page click or a badge. One editor at
   * a time: a dirty unsaved draft holds its ground (with a shake); anything
   * else is discarded in favour of the new target.
   */
  function requestEditor(element: Element, entry?: AnnotationEntry) {
    if (editor && editorText) {
      const sameTarget = entry
        ? editor.annotationId === entry.annotation.id
        : editor.element === element;

      if (sameTarget) {
        editorText.focus();
        return;
      }

      if (editorText.value.trim() && editorText.value !== editor.savedText) {
        shakeEditor();
        return;
      }

      closeEditor();
    }

    openEditor(element, entry);
  }

  // -- Event handlers ------------------------------------------------------

  function handlePointerMove(event: Event) {
    if (!designMode) {
      return;
    }

    const target = pageTarget(event);

    if (!target) {
      hideHighlight();
      resolvedTarget = null;
      hoverTarget = null;
      return;
    }

    // Moving the pointer re-anchors: whatever ↑ did is a per-hover adjustment,
    // not a persistent selection.
    resolvedTarget = resolveAnnotationTarget(target);
    hoverTarget = resolvedTarget;
    showHighlight(hoverTarget);
  }

  /**
   * The pointer left the document — `relatedTarget` is null only then, which
   * is what tells this apart from moving between two elements in the page.
   */
  function handlePointerOut(event: Event) {
    if (designMode && !(event as MouseEvent).relatedTarget) {
      hideHighlight();
      resolvedTarget = null;
      hoverTarget = null;
    }
  }

  function handlePointerEvent(event: Event) {
    if (!designMode) {
      return;
    }

    const target = pageTarget(event);

    // Our own badges and editor have to keep working, so their events are
    // left entirely alone.
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (event.type !== "click") {
      return;
    }

    // A click annotates the current target — the one ↑ may have moved to an
    // ancestor — while a click somewhere unhovered resolves fresh.
    const resolved = resolveAnnotationTarget(target);
    const targetElement =
      resolved === resolvedTarget && hoverTarget ? hoverTarget : resolved;

    resolvedTarget = resolved;
    hoverTarget = targetElement;
    requestEditor(targetElement, entryForElement(targetElement) ?? undefined);
  }

  /** ↑ walks toward the root (never to `<html>`), ↓ back toward the pointer. */
  function moveHover(direction: -1 | 1) {
    if (!hoverTarget) {
      return;
    }

    if (direction < 0) {
      const parent = hoverTarget.parentElement;

      if (parent && parent !== doc.documentElement) {
        hoverTarget = parent;
        showHighlight(hoverTarget);
      }
      return;
    }

    if (
      !resolvedTarget ||
      resolvedTarget === hoverTarget ||
      !hoverTarget.contains(resolvedTarget)
    ) {
      return;
    }

    let step = resolvedTarget;

    while (step.parentElement && step.parentElement !== hoverTarget) {
      step = step.parentElement;
    }

    hoverTarget = step;
    showHighlight(hoverTarget);
  }

  function toggleDesignMode() {
    applyDesignMode(!designMode);
    options.onDesignModeChange(designMode);
  }

  function handleKeyDown(event: Event) {
    const keyboard = event as KeyboardEvent;

    // Cmd/Ctrl+Shift+A toggles annotation mode from anywhere — including an
    // open editor, whose draft goes away with the mode it lives in.
    if (
      keyboard.code === "KeyA" &&
      keyboard.shiftKey &&
      (keyboard.metaKey || keyboard.ctrlKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggleDesignMode();
      return;
    }

    const own = isOverlayEvent(event);

    // Typing a comment must not trigger the page's own keyboard shortcuts —
    // which also means the editor's own listeners never see the keys, so
    // Enter and Escape are answered here rather than on the textarea.
    if (own) {
      event.stopPropagation();
    }

    if (!designMode) {
      return;
    }

    // An IME composition owns its keys: Enter confirms a candidate and Escape
    // cancels the composition — neither may save or close the editor. 229 is
    // what Chromium reports for keyCode during a composition.
    if (keyboard.isComposing || keyboard.keyCode === 229) {
      return;
    }

    if (keyboard.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      // Two-stage: an open editor is cancelled first (draft discarded, saved
      // text reverted); the next Escape leaves annotation mode entirely.
      if (editor) {
        closeEditor();
        return;
      }

      applyDesignMode(false);
      options.onDesignModeChange(false);
      return;
    }

    if (own && editor && keyboard.key === "Enter" && !keyboard.shiftKey) {
      // A bare Enter saves and keeps marking; Shift+Enter stays a newline
      // because its default action is left alone.
      event.preventDefault();
      saveEditor();
      return;
    }

    if (
      !editor &&
      hoverTarget &&
      (keyboard.key === "ArrowUp" || keyboard.key === "ArrowDown")
    ) {
      // Without this the arrow keys would scroll the page being marked.
      event.preventDefault();
      event.stopPropagation();
      moveHover(keyboard.key === "ArrowUp" ? -1 : 1);
    }
  }

  for (const type of pointerEvents) {
    listenerTarget.addEventListener(type, handlePointerEvent, true);
  }
  listenerTarget.addEventListener("pointermove", handlePointerMove, true);
  listenerTarget.addEventListener("mouseout", handlePointerOut, true);
  listenerTarget.addEventListener("keydown", handleKeyDown, true);
  // Scroll does not bubble, so the capture phase is the only way to hear one
  // from a nested container; passive, because this never cancels anything.
  listenerTarget.addEventListener("scroll", scheduleMarkerSync, {
    capture: true,
    passive: true,
  });
  listenerTarget.addEventListener("resize", scheduleMarkerSync, true);

  return {
    setAnnotationPalette(palette) {
      applyAnnotationPalette(palette);
    },

    setDesignMode(enabled, palette) {
      if (palette) {
        applyAnnotationPalette(palette);
      }
      // No notification back: this is main answering its own command, and an
      // echo would fight the renderer's own state.
      applyDesignMode(enabled);
    },

    prepareCapture() {
      // An open editor settles before the shot: a draft with text is saved —
      // asking to send is intent to keep it — an empty one is a misclick.
      if (editor) {
        if (editorText?.value.trim()) {
          saveEditor();
        } else {
          closeEditor();
        }
      }
      syncOverlayPositions();
      // Editor, hover box and mode chrome are overlay chrome — none of them
      // belong in a screenshot of the user's page. The marks stay: they are
      // what the numbered rows in the prompt point at.
      hideHighlight();
      setModeAffordanceVisible(false);
      // Measured now rather than when the mark was made: the panel can have
      // been dragged wider since, and the shot is being taken at this size.
      options.onCaptureReady(
        annotations.map((annotation) => ({ ...annotation })),
        readViewport(),
      );
    },

    finishCapture() {
      if (designMode) {
        setModeAffordanceVisible(true);
      }
    },

    clearAnnotations() {
      // No commit on the way out: clearing throws the marks away, comments and
      // all, so there is nothing left to report but the empty list.
      closeEditor();
      annotations.length = 0;
      for (const entry of entries.values()) {
        entry.outline.remove();
        entry.badge.remove();
      }
      entries.clear();
      notify();
    },

    dispose() {
      for (const type of pointerEvents) {
        listenerTarget.removeEventListener(type, handlePointerEvent, true);
      }
      listenerTarget.removeEventListener("pointermove", handlePointerMove, true);
      listenerTarget.removeEventListener("mouseout", handlePointerOut, true);
      listenerTarget.removeEventListener("keydown", handleKeyDown, true);
      listenerTarget.removeEventListener("scroll", scheduleMarkerSync, true);
      listenerTarget.removeEventListener("resize", scheduleMarkerSync, true);
      host?.remove();
      host = null;
      shadowRoot = null;
      highlight = null;
      highlightLabel = null;
      markerLayer = null;
      frame = null;
      pill = null;
      editorBox = null;
      editorText = null;
      saveButton = null;
      deleteButton = null;
      editor = null;
      resolvedTarget = null;
      hoverTarget = null;
      entries.clear();
      annotations.length = 0;
    },
  };
}
