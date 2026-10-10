import { randomUUID } from "node:crypto";
import { resolveCommentCropRect } from "@pace/core";
import type {
  BrowserAnnotationElement,
  BrowserAnnotationPalette,
  BrowserAnnotationViewport,
  BrowserComment,
  BrowserCommentList,
  BrowserEvent,
  BrowserSessionState,
  BrowserTabState,
  BrowserTabTarget,
  BrowserViewRect,
  BrowserViewSnapshot,
  BrowserViewState,
} from "@/shared/browser-protocol";
import { readAnnotationPalette } from "./browser-annotation";

/**
 * Policy and lifecycle for the embedded browser surface, with every Electron
 * type kept behind the `BrowserHostView` seam so the rules that matter —
 * which URLs load, where the native view may paint, when it becomes visible —
 * are testable without an Electron process.
 *
 * The embedded page is treated as hostile: the renderer only reports intent,
 * this module resolves and caps it (the ADR-0022 pattern).
 */

/**
 * The window's own titlebar band (traffic lights, drag region). A native child
 * view painted over it would eat the drag region and the window controls, so
 * bounds never start above it however the renderer measures.
 */
export const browserTitlebarBandPx = 40;

/**
 * Enumerated rather than prefix-sniffed: main routes on this set, so a future
 * backend command that happens to start with `browser_` still reaches the
 * backend instead of being swallowed here.
 */
const browserCommands = new Set([
  "browser_attach",
  "browser_list",
  "browser_open",
  "browser_close",
  "browser_activate",
  "browser_hide_session",
  "browser_capture",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_set_bounds",
  "browser_set_visible",
  "browser_set_design_mode",
  "browser_set_annotation_palette",
  "browser_clear_annotations",
  "browser_list_comments",
  "browser_settle_comments",
  "browser_comment_images",
  "browser_delete_comment",
  "browser_consume_comments",
  "browser_open_external",
]);
const allowedProtocols = new Set(["http:", "https:"]);
/**
 * A bare `localhost:5173` looks like a scheme; a real scheme is never followed
 * by a digit, so the lookahead tells the two apart.
 */
const schemePattern = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

export function isBrowserCommand(command: string) {
  return browserCommands.has(command);
}

/**
 * Chromium's ERR_ABORTED. `webContents.loadURL()` rejects with it whenever a
 * page supersedes its own pending navigation (baidu.com does this on load), so
 * it means "superseded", never "broken". `did-fail-load` already ignores the
 * same code.
 */
export function isAbortedLoadError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const { errno, code } = error as { errno?: unknown; code?: unknown };

  return errno === -3 || code === "ERR_ABORTED";
}

/** `will-navigate` guard for navigation the embedded page starts itself. */
export function isAllowedBrowserUrl(url: string) {
  try {
    return allowedProtocols.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Dev servers are typed as `host:port` and speak http; anything else is a real
 * site that should not get a cleartext first hop.
 */
function inferredScheme(authority: string) {
  const host = authority.split(/[/?#]/)[0] ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]";

  return isLoopback || /:\d+$/.test(host) ? "http:" : "https:";
}

/**
 * The single gate for every URL that reaches the view. `will-navigate` only
 * covers navigation the page starts — a main-process `loadURL` bypasses it
 * entirely (S0 spike), so commands must be checked here as well.
 */
export function normalizeBrowserUrl(input: string) {
  const candidate = input.trim();

  if (!candidate) {
    throw new Error("A URL is required.");
  }

  const withScheme = schemePattern.test(candidate)
    ? candidate
    : `${inferredScheme(candidate)}//${candidate}`;
  let parsed: URL;

  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(
      `The browser surface only opens http and https pages, not "${parsed.protocol}".`,
    );
  }

  return parsed.toString();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Caps the renderer's measured rect against the live window so a layout bug
 * can never let the native view cover the titlebar band or spill outside.
 */
export function resolveBrowserViewBounds(input: {
  rect: BrowserViewRect;
  contentSize: { width: number; height: number };
}): BrowserViewRect {
  const { rect, contentSize } = input;
  const x = clamp(Math.round(rect.x), 0, contentSize.width);
  const y = clamp(
    Math.round(rect.y),
    browserTitlebarBandPx,
    contentSize.height,
  );

  return {
    x,
    y,
    width: clamp(Math.round(rect.width), 0, contentSize.width - x),
    height: clamp(Math.round(rect.height), 0, contentSize.height - y),
  };
}

/**
 * What "the same document" means for comment restores: the part of a URL a
 * page's identity survives. The hash is client-side state — jumping to a
 * section must not lose the document's comments.
 */
export function urlKey(url: string) {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Comments a Session may keep at once — beyond it, saves are ignored. */
export const maxSessionComments = 200;

export type BrowserHostSession = {
  setPermissionRequestHandler(handler: (permission: string) => boolean): void;
  setPermissionCheckHandler(handler: (permission: string) => boolean): void;
  blockDownloads(): void;
};

/**
 * Hands out the embedded browser's session, configured exactly once.
 *
 * `session.fromPartition` returns the same persistent object for the life of
 * the app, while the host is rebuilt whenever the window is (on macOS a window
 * can close and reopen without quitting). Permission handlers replace each
 * other harmlessly, but blocking downloads is a listener registration, so
 * configuring per host would stack another copy every time.
 */
export function createBrowserSessionProvider<
  Session extends BrowserHostSession,
>(
  createSession: () => Session,
  allowsPermission: (permission: string) => boolean,
) {
  let configured: Session | null = null;

  return () => {
    if (configured) {
      return configured;
    }

    const browserSession = createSession();

    browserSession.setPermissionRequestHandler(allowsPermission);
    browserSession.setPermissionCheckHandler(allowsPermission);
    browserSession.blockDownloads();
    configured = browserSession;

    return configured;
  };
}

export type BrowserHostView = {
  setBounds(bounds: BrowserViewRect): void;
  setVisible(visible: boolean): void;
  loadUrl(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  /** Design mode lives in the page's isolated world; this is the command. */
  setDesignMode(enabled: boolean, palette?: BrowserAnnotationPalette): void;
  /** Updates the annotation colours without changing mode. */
  setAnnotationPalette(palette: BrowserAnnotationPalette): void;
  /**
   * The store's marks for the document it is showing. Replaces the old
   * clear command: syncing `[]` removes them.
   */
  syncAnnotations(annotations: BrowserAnnotationElement[]): void;
  /** A save's crop ended — the hidden overlay may come back. */
  finishCapture(): void;
  reload(): void;
  destroy(): void;
  readState(): BrowserViewSnapshot;
  /**
   * PNG data URL of the view as it stands, or null if it cannot be read.
   * `maxWidth` is in CSS pixels.
   */
  capture(maxWidth?: number): Promise<string | null>;
  /**
   * PNG data URL of one region — the crop saved with a comment. `cssWidth`
   * downsamples device pixels back to CSS like `capture` does.
   */
  captureRect(rect: BrowserViewRect, cssWidth: number): Promise<string | null>;
};

type BrowserTabDependencies = {
  createView(): BrowserHostView;
  /** Null while no window is open; bounds are then not applicable. */
  getContentSize(): { width: number; height: number } | null;
  openExternal(url: string): void | Promise<void>;
  /**
   * The Session comment store's projection for this tab on a given document —
   * its marks and the viewport they were last measured in. Injected per tab
   * by the session host; a tab host by itself owns no comments.
   */
  snapshotComments?(currentUrl: string): {
    annotations: BrowserAnnotationElement[];
    viewport: BrowserAnnotationViewport | null;
  };
};

type BrowserTabHost = {
  snapshot(): Omit<BrowserTabState, keyof BrowserTabTarget | "revision">;
  resetBounds(): void;
  recordPageState(state: {
    title?: string;
    loading?: boolean;
    navigated?: boolean;
  }): void;
  invoke(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<BrowserViewState | string | null>;
  allowsNavigationTo(url: string): boolean;
  /** `setWindowOpenHandler`: no new windows; an allowed target loads in place. */
  handleWindowOpen(url: string): void;
  /** v1 grants no page permissions at all. */
  allowsPermission(permission: string): boolean;
  /** The id main stamps on every event it forwards to the renderer. */
  currentNavigationId(): number;
  /**
   * Whether the page should be in design mode. Each document gets its own
   * overlay, so main re-applies this whenever a fresh one reports for duty.
   */
  isDesignModeEnabled(): boolean;
  /** Design mode the page left by itself (Escape), so main stops re-applying it. */
  recordDesignMode(enabled: boolean): void;
  /**
   * The last valid palette, replayed to each fresh document so the overlay
   * keeps Pace's colours.
   */
  annotationPalette(): BrowserAnnotationPalette | undefined;
  /** The document's URL the view is showing (or was last asked for). */
  currentUrl(): string;
  /** URL and title as the page reported them — stamped on saved comments. */
  pageInfo(): { url: string; title: string };
  /** Pushes the store's annotations for this document onto the overlay. */
  syncAnnotations(annotations: BrowserAnnotationElement[]): void;
  /**
   * The save-crop: photograph the comment's region, then always release the
   * page (`capture-done`), however the shot ended.
   */
  captureCommentCrop(rect: BrowserViewRect): Promise<string | null>;
  /**
   * The overlay hid itself for a save main is not going to crop — the page
   * must still be released (`capture-done`).
   */
  releaseAnnotationCapture(): void;
  /**
   * `did-fail-load` on the main frame. Chromium commits its error page under
   * the URL that failed, so without this the next navigate to that same URL
   * would be short-circuited as "already showing" and Retry would do nothing.
   */
  recordLoadFailure(message?: string): void;
  dispose(): void;
};

function readUrlArgument(args: Record<string, unknown> | undefined) {
  const url = args?.url;

  if (typeof url !== "string") {
    throw new Error("A URL is required.");
  }

  return url;
}

function readRectArgument(args: Record<string, unknown> | undefined) {
  const rect = args?.rect as Partial<BrowserViewRect> | undefined;

  if (
    typeof rect?.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number"
  ) {
    throw new Error(
      "Browser view bounds require numeric x, y, width and height.",
    );
  }

  return rect as BrowserViewRect;
}

export function createBrowserTabHost(
  deps: BrowserTabDependencies,
): BrowserTabHost {
  let view: BrowserHostView | null = null;
  let bounds: BrowserViewRect | null = null;
  let visibilityRequested = false;
  let navigationId = 0;
  let loadFailed = false;
  let errorMessage: string | null = null;
  let requestedUrl = "";
  let title = "";
  let loading = false;
  let designMode = false;
  let palette: BrowserAnnotationPalette | undefined;
  /** The document the view is showing, or the one it was last asked for. */
  function currentUrl() {
    return view?.readState().url || requestedUrl;
  }

  /**
   * The Session comment store is the truth for marks; this tab's slice of it
   * on the document being shown — the same projection the renderer reads.
   */
  function commentsNow() {
    return (
      deps.snapshotComments?.(currentUrl()) ?? {
        annotations: [],
        viewport: null,
      }
    );
  }

  /** The view's own answer, stamped with the navigation the renderer asked for. */
  function readState(): BrowserViewState | null {
    return view ? { ...view.readState(), navigationId } : null;
  }

  /**
   * A view with no bounds yet sits at 0,0 and would cover the whole window,
   * so visibility waits for a usable rect. A collapsed rect (panel closed
   * mid-drag) hides it again rather than leaving a sliver behind.
   */
  function applyVisibility() {
    view?.setVisible(
      visibilityRequested &&
        bounds !== null &&
        bounds.width > 0 &&
        bounds.height > 0,
    );
  }

  function ensureView() {
    if (view) {
      return view;
    }

    view = deps.createView();
    if (bounds) {
      view.setBounds(bounds);
    }
    applyVisibility();

    return view;
  }

  async function navigate(url: string) {
    const target = normalizeBrowserUrl(url);

    navigationId += 1;
    const requestedNavigation = navigationId;
    requestedUrl = target;
    errorMessage = null;

    // Re-entering the surface must not reload the page and lose its state —
    // unless the URL is only showing because its load failed, in which case
    // the view is on Chromium's error page and Retry has to really reload.
    if (view && !loadFailed && view.readState().url === target) {
      return readState();
    }

    const active = ensureView();
    loading = true;

    try {
      await active.loadUrl(target);
    } catch (error) {
      // An aborted load is not a failure: the page navigated again before its
      // first request finished, so the request went away while the page it
      // replaced it with is loading fine. Main normalises this too; the guard
      // is repeated here so no caller of the host can be told otherwise.
      if (!isAbortedLoadError(error)) {
        if (requestedNavigation === navigationId) {
          loadFailed = true;
          loading = false;
          errorMessage =
            error instanceof Error
              ? error.message
              : "The page could not be opened.";
        }
        throw error;
      }
    }

    if (requestedNavigation === navigationId) {
      loadFailed = false;
      loading = false;
    }

    return readState();
  }

  function setBounds(rect: BrowserViewRect) {
    const contentSize = deps.getContentSize();

    if (!contentSize) {
      return null;
    }

    bounds = resolveBrowserViewBounds({ rect, contentSize });
    if (!view) {
      return null;
    }

    view.setBounds(bounds);
    applyVisibility();

    return readState();
  }

  return {
    snapshot() {
      const state = readState();
      const comments = commentsNow();
      return {
        url: state?.url || requestedUrl,
        canGoBack: state?.canGoBack ?? false,
        canGoForward: state?.canGoForward ?? false,
        navigationId,
        title,
        loading,
        error: errorMessage,
        designMode,
        annotations: comments.annotations,
        viewport: comments.viewport,
      };
    },
    resetBounds() {
      bounds = null;
      visibilityRequested = false;
      applyVisibility();
    },
    recordPageState(state) {
      if (state.title !== undefined) title = state.title;
      if (state.loading !== undefined) loading = state.loading;
      if (state.navigated) {
        loadFailed = false;
        errorMessage = null;
      }
    },
    async invoke(command, args) {
      switch (command) {
        case "browser_navigate":
          return navigate(readUrlArgument(args));
        case "browser_back":
          view?.goBack();
          return readState();
        case "browser_forward":
          view?.goForward();
          return readState();
        case "browser_reload":
          view?.reload();
          return readState();
        case "browser_set_bounds":
          return setBounds(readRectArgument(args));
        case "browser_set_visible":
          visibilityRequested = args?.visible === true;
          applyVisibility();
          return readState();
        case "browser_set_design_mode": {
          // Deliberately not `ensureView()`: turning annotation mode on over
          // the empty state has nothing to mark up, and creating a view would
          // paint one.
          designMode = args?.enabled === true;
          // An absent or malformed palette keeps the last one — the renderer
          // only sends tokens when it turns the mode on.
          const nextPalette = readAnnotationPalette(args?.palette);
          if (nextPalette) {
            palette = nextPalette;
          }
          view?.setDesignMode(designMode, nextPalette);
          return null;
        }
        case "browser_set_annotation_palette": {
          const nextPalette = readAnnotationPalette(args?.palette);
          if (nextPalette) {
            palette = nextPalette;
            view?.setAnnotationPalette(nextPalette);
          }
          return null;
        }
        case "browser_capture":
          // Full resolution and no handshake: this still stands in for the
          // native view while a DOM overlay is open, so it has to show the page
          // exactly as it is, marks and all.
          return view ? view.capture() : null;
        case "browser_open_external":
          await deps.openExternal(normalizeBrowserUrl(readUrlArgument(args)));
          return null;
        default:
          throw new Error(`Unknown browser command "${command}".`);
      }
    },

    allowsNavigationTo: isAllowedBrowserUrl,

    handleWindowOpen(url) {
      if (!view || !isAllowedBrowserUrl(url)) {
        return;
      }

      void view.loadUrl(url);
    },

    allowsPermission() {
      return false;
    },

    currentNavigationId() {
      return navigationId;
    },

    isDesignModeEnabled() {
      return designMode;
    },

    recordDesignMode(enabled) {
      designMode = enabled;
    },

    annotationPalette() {
      return palette;
    },

    currentUrl,

    pageInfo() {
      return { url: currentUrl(), title };
    },

    syncAnnotations(annotations) {
      view?.syncAnnotations(annotations);
    },

    async captureCommentCrop(rect) {
      const active = view;
      if (!active) {
        return null;
      }
      try {
        return await active.captureRect(rect, rect.width);
      } catch {
        return null;
      } finally {
        // However the crop ended, the overlay hidden for it comes back.
        active.finishCapture();
      }
    },

    releaseAnnotationCapture() {
      view?.finishCapture();
    },

    recordLoadFailure(message = "The page could not be opened.") {
      loadFailed = true;
      loading = false;
      errorMessage = message;
    },

    dispose() {
      view?.destroy();
      view = null;
      bounds = null;
      visibilityRequested = false;
      designMode = false;
    },
  };
}

export type BrowserHostDependencies = Omit<
  BrowserTabDependencies,
  "createView"
> & {
  createView(target: BrowserTabTarget): BrowserHostView;
  emit?(event: BrowserEvent): void;
};
export type BrowserHost = ReturnType<typeof createBrowserHost>;

/**
 * A saved comment minus the two fields computed on read: `index` (Session
 * order changes as comments come and go) and `hasImage` (it answers the
 * images map, which arrives after the record does).
 */
type StoredComment = Omit<BrowserComment, "index" | "hasImage">;

type BrowserSessionGroup = {
  tabs: Map<string, BrowserTabHost>;
  activeTabId: string | null;
  /**
   * The Session's comment store — the single truth S3's composer will read.
   * It outlives documents and tabs: navigation never deletes comments, and
   * closing a tab keeps them (their markers simply vanish with the view).
   */
  comments: StoredComment[];
  /** The save-crop per comment id — null means the shot could not be read. */
  images: Map<string, string | null>;
  /**
   * In-flight save commits (crop → images → comments-changed), registered the
   * moment the report arrives so a `submit-requested` that follows it on IPC
   * always finds the crop it must wait for.
   */
  pendingCrops: Set<Promise<unknown>>;
  /** Bumped on every store change so readers can drop answers older than one they hold. */
  commentRevision: number;
};

/** Session membership owns lifetime; the active target alone owns the native slot. */
export function createBrowserHost(deps: BrowserHostDependencies) {
  const sessions = new Map<string, BrowserSessionGroup>();
  let active: BrowserTabTarget | null = null;
  const revisions = new WeakMap<BrowserTabHost, number>();

  function session(sessionId: string) {
    let group = sessions.get(sessionId);
    if (!group) {
      group = {
        tabs: new Map(),
        activeTabId: null,
        comments: [],
        images: new Map(),
        pendingCrops: new Set(),
        commentRevision: 0,
      };
      sessions.set(sessionId, group);
    }
    return group;
  }
  function tab(target: BrowserTabTarget) {
    const found = sessions.get(target.sessionId)?.tabs.get(target.tabId);
    if (!found)
      throw new Error("The browser tab does not belong to this Session.");
    return found;
  }
  function readTab(target: BrowserTabTarget): BrowserTabState {
    const controller = tab(target);
    const revision = (revisions.get(controller) ?? 0) + 1;
    revisions.set(controller, revision);
    return { ...target, ...controller.snapshot(), revision };
  }
  function readSession(sessionId: string): BrowserSessionState {
    const group = session(sessionId);
    return {
      sessionId,
      activeTabId: group.activeTabId,
      tabs: [...group.tabs.keys()].map((tabId) =>
        readTab({ sessionId, tabId }),
      ),
    };
  }
  function notify(target: BrowserTabTarget) {
    if (sessions.get(target.sessionId)?.tabs.has(target.tabId)) {
      deps.emit?.({ type: "state-changed", tab: readTab(target) });
    }
  }

  // -- The Session comment store ---------------------------------------------

  /**
   * Comments as the wire reports them: `index` is the position in store
   * order, recomputed here on every read, and `hasImage` answers the images
   * map rather than a field that could drift from it.
   */
  function publicComments(sessionId: string): BrowserComment[] {
    const group = sessions.get(sessionId);

    return (group?.comments ?? []).map((comment, position) => ({
      ...comment,
      index: position + 1,
      hasImage: group?.images.get(comment.id) != null,
    }));
  }

  /** One comment back in annotation shape — what a tab renders and shoots. */
  function annotationFor(
    comment: StoredComment,
    index: number,
  ): BrowserAnnotationElement {
    return {
      id: comment.id,
      index,
      selector: comment.selector,
      tag: comment.tag,
      ...(comment.text ? { text: comment.text } : {}),
      rect: { ...comment.rect },
      ...(comment.area ? { area: { ...comment.area } } : {}),
      ...(comment.source ? { source: comment.source } : {}),
      ...(comment.comment ? { comment: comment.comment } : {}),
    };
  }

  /**
   * A tab's marks for a document: its own comments saved under the same
   * urlKey, numbered by Session order. The viewport answers "where they were
   * measured" — the most recent matching comment's.
   */
  function commentsForTab(
    group: BrowserSessionGroup,
    tabId: string,
    url: string,
  ) {
    const key = urlKey(url);
    const annotations: BrowserAnnotationElement[] = [];
    let viewport: BrowserAnnotationViewport | null = null;

    group.comments.forEach((comment, position) => {
      if (comment.tabId === tabId && urlKey(comment.url) === key) {
        annotations.push(annotationFor(comment, position + 1));
        viewport = comment.viewport;
      }
    });

    return { annotations, viewport };
  }

  function emitCommentsChanged(sessionId: string) {
    const group = sessions.get(sessionId);

    if (!group) {
      return;
    }
    group.commentRevision += 1;
    deps.emit?.({
      type: "comments-changed",
      sessionId,
      revision: group.commentRevision,
      comments: publicComments(sessionId),
    });
  }

  /**
   * Every store mutation ends here: the event for whoever reads the store
   * (S3's composer), the per-tab sync that reconciles each document's marks,
   * and the state-changed for tabs whose snapshot changed.
   */
  function commitCommentChange(sessionId: string, affectedTabIds: Set<string>) {
    emitCommentsChanged(sessionId);

    const group = sessions.get(sessionId);

    if (!group) {
      return;
    }
    for (const [tabId, controller] of group.tabs) {
      controller.syncAnnotations(
        commentsForTab(group, tabId, controller.currentUrl()).annotations,
      );
    }
    for (const tabId of affectedTabIds) {
      notify({ sessionId, tabId });
    }
  }

  /**
   * The toolbar's Clear: every comment this tab owns goes, and the document's
   * marks with them. Comments on other tabs are untouched — the button only
   * means "this page".
   */
  function clearTabComments(target: BrowserTabTarget) {
    const group = sessions.get(target.sessionId);

    if (!group) {
      return;
    }

    const removed = new Set(
      group.comments
        .filter((comment) => comment.tabId === target.tabId)
        .map((comment) => comment.id),
    );

    for (const id of removed) {
      group.images.delete(id);
    }
    group.comments = group.comments.filter(
      (comment) => comment.tabId !== target.tabId,
    );

    if (removed.size) {
      commitCommentChange(target.sessionId, new Set([target.tabId]));
    } else {
      // Nothing stored, but the document may still be rendering marks a save
      // left behind — make sure they go too.
      group.tabs.get(target.tabId)?.syncAnnotations([]);
    }
  }
  function isActive(target: BrowserTabTarget) {
    return (
      active?.sessionId === target.sessionId && active.tabId === target.tabId
    );
  }
  function activate(target: BrowserTabTarget | null) {
    if (target && isActive(target)) return;
    if (active)
      sessions.get(active.sessionId)?.tabs.get(active.tabId)?.resetBounds();
    active = target;
    if (target) {
      tab(target).resetBounds();
      session(target.sessionId).activeTabId = target.tabId;
    }
  }
  function open(target: BrowserTabTarget) {
    const group = session(target.sessionId);
    if (group.tabs.has(target.tabId))
      throw new Error("Browser tab already exists.");
    group.tabs.set(
      target.tabId,
      createBrowserTabHost({
        ...deps,
        createView: () => deps.createView(target),
        snapshotComments: (url) => commentsForTab(group, target.tabId, url),
      }),
    );
    group.activeTabId = target.tabId;
  }
  function readSessionId(args?: Record<string, unknown>) {
    if (typeof args?.sessionId !== "string" || !args.sessionId)
      throw new Error("A Session id is required.");
    return args.sessionId;
  }
  function readStringList(value: unknown) {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }
  function readTarget(args?: Record<string, unknown>): BrowserTabTarget {
    const sessionId = readSessionId(args);
    if (typeof args?.tabId !== "string" || !args.tabId)
      throw new Error("A browser tab id is required.");
    return { sessionId, tabId: args.tabId };
  }
  async function invoke(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<
    | BrowserSessionState
    | BrowserTabState
    | BrowserCommentList
    | Record<string, string | null>
    | string
    | null
  > {
    if (command === "browser_open_external") {
      await deps.openExternal(normalizeBrowserUrl(readUrlArgument(args)));
      return null;
    }
    const sessionId = readSessionId(args);
    switch (command) {
      case "browser_attach": {
        // An empty attached group may be restored later by an explicit user action.
        if (!sessions.get(sessionId)?.tabs.size) {
          const urls = Array.isArray(args?.tabs)
            ? args.tabs.filter((url): url is string => typeof url === "string")
            : [];
          session(sessionId);
          for (const url of urls) {
            const target = { sessionId, tabId: randomUUID() };
            open(target);
            // Restoring a slow or failed background page must not hold up the strip.
            if (url)
              void invoke("browser_navigate", { ...target, url }).catch(
                () => {},
              );
          }
          const group = session(sessionId);
          const ids = [...group.tabs.keys()];
          const index =
            typeof args?.activeIndex === "number" ? args.activeIndex : 0;
          group.activeTabId = ids[index] ?? ids[0] ?? null;
        }
        const id = session(sessionId).activeTabId;
        activate(id ? { sessionId, tabId: id } : null);
        return readSession(sessionId);
      }
      case "browser_list":
        return readSession(sessionId);
      case "browser_hide_session":
        if (active?.sessionId === sessionId) activate(null);
        return null;
      case "browser_open": {
        const target = {
          sessionId,
          tabId: typeof args?.tabId === "string" ? args.tabId : randomUUID(),
        };
        open(target);
        activate(target);
        return readSession(sessionId);
      }
      case "browser_activate": {
        const target = readTarget(args);
        tab(target);
        activate(target);
        return readSession(sessionId);
      }
      case "browser_close": {
        const target = readTarget(args);
        const controller = tab(target);
        const group = session(sessionId);
        const index = [...group.tabs.keys()].indexOf(target.tabId);
        const wasActive = isActive(target);
        if (wasActive) activate(null);
        group.tabs.delete(target.tabId);
        controller.dispose();
        if (group.activeTabId === target.tabId) {
          const ids = [...group.tabs.keys()];
          group.activeTabId = ids[Math.min(index, ids.length - 1)] ?? null;
        }
        if (wasActive && group.activeTabId)
          activate({ sessionId, tabId: group.activeTabId });
        return readSession(sessionId);
      }
      case "browser_list_comments":
        // A pure read of the store — no tab is attached, activated or painted.
        return {
          revision: sessions.get(sessionId)?.commentRevision ?? 0,
          comments: publicComments(sessionId),
        };
      case "browser_settle_comments": {
        // The composer's send needs every save whose crop is still in flight
        // to land first — the same wait requestSubmit does — then the fresh
        // list, revision-stamped like the read.
        const group = sessions.get(sessionId);
        if (group) {
          await Promise.allSettled([...group.pendingCrops]);
        }
        return {
          revision: sessions.get(sessionId)?.commentRevision ?? 0,
          comments: publicComments(sessionId),
        };
      }
      case "browser_comment_images": {
        const group = sessions.get(sessionId);
        const ids = readStringList(args?.ids);
        // fromEntries makes every id an own data property — assigning into
        // `{}` would let "__proto__" reach the prototype instead.
        return Object.fromEntries(
          ids.map((id) => [id, group?.images.get(id) ?? null]),
        );
      }
      case "browser_delete_comment": {
        const group = sessions.get(sessionId);
        const id = typeof args?.id === "string" ? args.id : "";
        const comment = group?.comments.find((entry) => entry.id === id);

        if (group && comment) {
          group.comments = group.comments.filter(
            (entry) => entry.id !== id,
          );
          group.images.delete(id);
          commitCommentChange(sessionId, new Set([comment.tabId]));
        }
        return null;
      }
      case "browser_consume_comments": {
        // Sends to the composer take their comments out of the store exactly
        // once — unknown ids are simply already gone.
        const ids = new Set(readStringList(args?.ids));
        const group = sessions.get(sessionId);

        if (group && ids.size) {
          const affected = new Set<string>();

          for (const comment of group.comments) {
            if (ids.has(comment.id)) {
              affected.add(comment.tabId);
              group.images.delete(comment.id);
            }
          }
          if (affected.size) {
            group.comments = group.comments.filter(
              (comment) => !ids.has(comment.id),
            );
            commitCommentChange(sessionId, affected);
          }
        }
        return null;
      }
    }
    const target = readTarget(args);
    if (command === "browser_clear_annotations") {
      tab(target);
      clearTabComments(target);
      return readTab(target);
    }
    const controller = tab(target);
    if (
      ["browser_set_bounds", "browser_set_visible"].includes(command) &&
      !isActive(target)
    )
      return null;
    const result = controller.invoke(command, args);
    if (
      !["browser_set_bounds", "browser_set_visible", "browser_capture"].includes(
        command,
      )
    )
      notify(target);
    try {
      const answer = await result;
      if (command === "browser_capture") return answer as string | null;
      if (sessions.get(sessionId)?.tabs.get(target.tabId) !== controller)
        return null;
      return readTab(target);
    } finally {
      if (
        ![
          "browser_set_bounds",
          "browser_set_visible",
          "browser_capture",
        ].includes(command)
      )
        notify(target);
    }
  }
  return {
    invoke,
    tab,
    readTab,
    notify,

    /**
     * The page committed an annotation. A fresh id becomes a new comment —
     * the record first, then the element's crop (the overlay already hid
     * itself so the shot carries no overlay), the image arriving after the
     * comment is why `hasImage` is computed on read. An id the store already
     * has only updates the comment text — and only on the tab that owns it.
     */
    async saveComment(
      target: BrowserTabTarget,
      annotation: BrowserAnnotationElement,
      viewport: BrowserAnnotationViewport,
      documentUrl: string,
    ) {
      const group = sessions.get(target.sessionId);
      const controller = group?.tabs.get(target.tabId);

      if (!group || !controller) {
        return;
      }

      const existing = group.comments.find(
        (comment) => comment.id === annotation.id,
      );

      if (existing) {
        if (existing.tabId !== target.tabId) {
          return;
        }
        existing.comment = annotation.comment ?? "";
        commitCommentChange(target.sessionId, new Set([target.tabId]));
        return;
      }

      if (group.comments.length >= maxSessionComments) {
        // The overlay hid itself for a crop that will never come: release it
        // and push the store's truth back so the phantom mark disappears —
        // then tell the surface why nothing was kept.
        controller.releaseAnnotationCapture();
        controller.syncAnnotations(
          commentsForTab(group, target.tabId, controller.currentUrl())
            .annotations,
        );
        deps.emit?.({
          type: "comment-rejected",
          sessionId: target.sessionId,
          tabId: target.tabId,
          reason: "limit",
        });
        return;
      }

      // The sender told us where it was when it saved. A navigation in
      // between would file the comment — title and url taken from the tab —
      // against the wrong document.
      if (urlKey(documentUrl) !== urlKey(controller.currentUrl())) {
        controller.releaseAnnotationCapture();
        return;
      }

      const { url, title } = controller.pageInfo();
      const comment: StoredComment = {
        id: annotation.id,
        selector: annotation.selector,
        tag: annotation.tag,
        ...(annotation.text ? { text: annotation.text } : {}),
        rect: { ...annotation.rect },
        ...(annotation.area ? { area: { ...annotation.area } } : {}),
        ...(annotation.source ? { source: annotation.source } : {}),
        comment: annotation.comment ?? "",
        tabId: target.tabId,
        url,
        title,
        viewport: { ...viewport },
        stale: false,
        createdAt: new Date().toISOString(),
      };

      group.comments.push(comment);

      // Registered before the first await: IPC preserves message order from
      // one sender, so a submit-requested that follows the report always sees
      // this pending commit — and it tracks the whole commit, not just the
      // crop, so the emitted submit lands after comments-changed.
      const commit = (async () => {
        const image = await controller.captureCommentCrop(
          resolveCommentCropRect(annotation.rect, viewport),
        );

        // The comment may have been deleted while its crop was in flight —
        // keep an orphan image out of the map.
        if (group.comments.includes(comment)) {
          group.images.set(comment.id, image);
        }
        commitCommentChange(target.sessionId, new Set([target.tabId]));
      })();

      group.pendingCrops.add(commit);
      try {
        await commit;
      } finally {
        group.pendingCrops.delete(commit);
      }
    },

    /**
     * The page deleted one of its marks — scoped to its own tab's comments so
     * a document can never delete another tab's.
     */
    deleteComment(target: BrowserTabTarget, id: string) {
      const group = sessions.get(target.sessionId);
      const comment = group?.comments.find(
        (entry) => entry.id === id && entry.tabId === target.tabId,
      );

      if (!group || !comment) {
        return;
      }

      group.comments = group.comments.filter((entry) => entry.id !== id);
      group.images.delete(id);
      commitCommentChange(target.sessionId, new Set([target.tabId]));
    },

    /**
     * The overlay's answer to a restore attempt. `stale` lives on the
     * comment, not the annotation, so it only reaches `comments-changed`
     * readers — a flag flip alone is not worth re-shooting the document for.
     */
    markStale(target: BrowserTabTarget, id: string, stale: boolean) {
      const group = sessions.get(target.sessionId);
      const comment = group?.comments.find(
        (entry) => entry.id === id && entry.tabId === target.tabId,
      );

      if (!comment || comment.stale === stale) {
        return;
      }

      comment.stale = stale;
      emitCommentsChanged(target.sessionId);
    },

    /**
     * Cmd/Ctrl+Enter in the page. The message only arrives after every
     * `annotation-saved` it belongs to, and IPC order means the crops those
     * saves registered are already pending — so waiting for the set to drain
     * guarantees the emitted request lands after the comments-changed that
     * carries their `hasImage`.
     */
    async requestSubmit(target: BrowserTabTarget) {
      const group = sessions.get(target.sessionId);

      if (!group || !group.tabs.has(target.tabId)) {
        return;
      }

      await Promise.allSettled([...group.pendingCrops]);
      deps.emit?.({ type: "submit-requested", sessionId: target.sessionId });
    },

    /**
     * What a fresh (or re-synced) document should be showing: this tab's
     * comments whose urlKey matches the URL the sender is actually on.
     */
    syncTabAnnotations(target: BrowserTabTarget, url: string) {
      const group = sessions.get(target.sessionId);
      const controller = group?.tabs.get(target.tabId);

      if (!group || !controller) {
        return;
      }

      controller.syncAnnotations(
        commentsForTab(group, target.tabId, url).annotations,
      );
    },

    detachRenderer() {
      activate(null);
    },
    allowsNavigationTo: isAllowedBrowserUrl,
    allowsPermission: (_permission: string) => false,
    dispose() {
      for (const group of sessions.values())
        for (const controller of group.tabs.values()) controller.dispose();
      sessions.clear();
      active = null;
    },
  };
}
