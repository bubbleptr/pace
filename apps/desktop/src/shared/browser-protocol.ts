/**
 * Wire contract for the embedded browser surface.
 *
 * The view is a native `WebContentsView` owned by the Electron main process —
 * it never reaches the utilityProcess backend, so the embedded page can never
 * touch the Runtime Gateway MessagePort (ADR-0013). Main, preload and the
 * renderer share only the shapes below.
 */

import type {
  BrowserAnnotationElement,
  BrowserAnnotationViewport,
} from "@pace/core";

export type BrowserViewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** What the view itself can answer about the page it is showing. */
export type BrowserViewSnapshot = {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserViewState = BrowserViewSnapshot & {
  /** Bumped by navigation within one tab; stale completions cannot replace it. */
  navigationId: number;
};

/**
 * What the user marked in design mode lives in `@pace/core`: the shapes
 * outgrew the wire — the renderer assembles a payload out of them and core's
 * `formatBrowserAnnotationPrompt` renders it for Pi. They are re-exported here
 * so main, the annotation preload and the renderer keep reading one protocol
 * module.
 *
 * Type-only on purpose. The annotation preload reaches this module (through
 * `electron/browser-annotation.ts`) and has to stay self-contained, so nothing
 * here may become a runtime import (PRD S2 implementation constraint 6).
 */
export type { BrowserAnnotationElement, BrowserAnnotationViewport };

/**
 * The renderer's theme tokens, resolved to computed colour values and carried
 * to the page's overlay with `set-design-mode`. The overlay accepts each
 * colour only if `CSS.supports("color", v)` parses it, falling back per field
 * to its built-in defaults, so nothing here needs to be a legal colour.
 */
export type BrowserAnnotationPalette = {
  accent: string;
  accentForeground: string;
  surface: string;
  foreground: string;
  border: string;
  muted: string;
};

/**
 * What `browser_capture_annotation` answers with: the screenshot and the marks
 * it was taken against, which the page settled and re-measured for this shot.
 * They travel together because a payload assembled from two moments would
 * describe a viewport the picture was not taken in.
 */
export type BrowserAnnotationCapture = {
  /** PNG data URL, or null when the page could not be photographed. */
  image: string | null;
  annotations: BrowserAnnotationElement[];
  viewport: BrowserAnnotationViewport | null;
  url: string;
};

export type BrowserTabTarget = { sessionId: string; tabId: string };

export type BrowserTabState = BrowserViewState &
  BrowserTabTarget & {
    /** Orders snapshots across command replies and the event channel. */
    revision: number;
    title: string;
    loading: boolean;
    error: string | null;
    designMode: boolean;
    annotations: BrowserAnnotationElement[];
    viewport: BrowserAnnotationViewport | null;
  };

export type BrowserSessionState = {
  sessionId: string;
  tabs: BrowserTabState[];
  activeTabId: string | null;
};

/**
 * A saved annotation as the Session-level comment store hands it out. The
 * page element it describes (`selector`/`tag`/`rect`/`comment`) is the
 * annotation's own shape; the fields here pin it to a tab, a document and a
 * moment. `index` is its 1-based position in the Session's comment order and
 * is recomputed on every read — a badge number only ever means "the nth
 * comment kept for this Session".
 */
export type BrowserComment = BrowserAnnotationElement & {
  tabId: string;
  /** Page URL when saved; documents sharing it (`urlKey`) get the marker back. */
  url: string;
  title: string;
  /** The viewport the rect was measured in. */
  viewport: BrowserAnnotationViewport;
  /** The last restore attempt could not find the element in the document. */
  stale: boolean;
  /** A cropped screenshot was taken for it. */
  hasImage: boolean;
  createdAt: string;
};

export type BrowserEvent =
  | { type: "state-changed"; tab: BrowserTabState }
  /**
   * The Session's comment store changed — saved, edited, deleted or consumed.
   * Renderer state for a tab's visible marks still arrives via `state-changed`;
   * this is for the composer-to-be, which reads the Session, not a document.
   */
  | {
      type: "comments-changed";
      sessionId: string;
      comments: BrowserComment[];
    };

export const browserEventChannel = "pigui:browser-event";
