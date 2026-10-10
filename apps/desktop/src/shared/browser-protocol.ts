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
  BrowserComment,
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
 * outgrew the wire — the Session-level `BrowserComment` and core's
 * `formatBrowserComments` are what the composer renders for Pi. They are
 * re-exported here so main, the annotation preload and the renderer keep
 * reading one protocol module.
 *
 * Type-only on purpose. The annotation preload reaches this module (through
 * `electron/browser-annotation.ts`) and has to stay self-contained, so nothing
 * here may become a runtime import (PRD S2 implementation constraint 6).
 */
export type {
  BrowserAnnotationElement,
  BrowserAnnotationViewport,
  BrowserComment,
};

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

export type BrowserEvent =
  | { type: "state-changed"; tab: BrowserTabState }
  /**
   * The Session's comment store changed — saved, edited, deleted or consumed.
   * Renderer state for a tab's visible marks still arrives via `state-changed`;
   * this is for whoever reads the Session, not a document.
   */
  | {
      type: "comments-changed";
      sessionId: string;
      /** Bumped on every store change — an event older than one already seen is stale. */
      revision: number;
      comments: BrowserComment[];
    }
  /**
   * A page-committed comment could not be stored — today only because the
   * Session is already at its limit. The tab gets its store truth back, so
   * its local mark is already gone; the notice explains why it vanished.
   */
  | {
      type: "comment-rejected";
      sessionId: string;
      tabId: string;
      reason: "limit";
    }
  /**
   * Cmd/Ctrl+Enter in the page asked for the comments to go out now. Emitted
   * only after every pending save-crop settled, so it arrives after the
   * `comments-changed` that carries their `hasImage`.
   */
  | { type: "submit-requested"; sessionId: string };

/**
 * A read of the Session's comment store — `browser_list_comments` and
 * `browser_settle_comments`. `revision` is the store's counter at the moment
 * the answer was built: a stale read drops against any newer one already
 * applied.
 */
export type BrowserCommentList = {
  revision: number;
  comments: BrowserComment[];
};

export const browserEventChannel = "pigui:browser-event";
