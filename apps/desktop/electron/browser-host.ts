import { randomUUID } from "node:crypto";
import type {
  BrowserAnnotationCapture,
  BrowserEvent,
  BrowserSessionState,
  BrowserTabState,
  BrowserTabTarget,
  BrowserAnnotationElement,
  BrowserAnnotationPalette,
  BrowserAnnotationViewport,
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
 * How long main waits for the page to say it is out of shot before taking the
 * screenshot anyway. A page with no annotation preload listening — one that
 * replaced its document before the overlay reported in — would otherwise leave
 * the toolbar waiting forever.
 */
export const browserCaptureAckTimeoutMs = 500;

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
  "browser_capture_annotation",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_set_bounds",
  "browser_set_visible",
  "browser_set_design_mode",
  "browser_set_annotation_palette",
  "browser_clear_annotations",
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
  clearAnnotations(): void;
  /** Asks the overlay to put itself out of shot and report what it holds. */
  prepareCapture(): void;
  /** The shot is done — the overlay may put its mode chrome back. */
  finishCapture(): void;
  reload(): void;
  destroy(): void;
  readState(): BrowserViewSnapshot;
  /**
   * PNG data URL of the view as it stands, or null if it cannot be read.
   * `maxWidth` is in CSS pixels; see `browser_capture_annotation` below for
   * why the annotation capture passes one and the overlay still does not.
   */
  capture(maxWidth?: number): Promise<string | null>;
};

type BrowserTabDependencies = {
  createView(): BrowserHostView;
  /** Null while no window is open; bounds are then not applicable. */
  getContentSize(): { width: number; height: number } | null;
  openExternal(url: string): void | Promise<void>;
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
  ): Promise<BrowserViewState | BrowserAnnotationCapture | string | null>;
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
  /**
   * What the page reports as the user marks. Kept so a capture can go ahead
   * with the last known marks when the page does not answer the prepare.
   */
  recordAnnotations(
    annotations: BrowserAnnotationElement[],
    viewport: BrowserAnnotationViewport | null,
  ): void;
  /** The page is out of shot: whatever capture is waiting can go ahead. */
  recordCaptureReady(
    annotations: BrowserAnnotationElement[],
    viewport: BrowserAnnotationViewport,
  ): void;
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
  let marks: Omit<BrowserAnnotationCapture, "image" | "url"> = {
    annotations: [],
    viewport: null,
  };
  /** Set while a capture is waiting for the page to say it is out of shot. */
  let pendingCaptureAck: ((settled: typeof marks) => void) | null = null;

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
    marks = { annotations: [], viewport: null };
    active.clearAnnotations();

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

  /**
   * The capture handshake. The overlay draws in the page itself — an open
   * comment bubble and the hover box would both be photographed — and the
   * comment being typed has not reached main until the bubble is closed. So
   * the page is asked to settle first and answers with what it then holds,
   * measured at the size the shot is about to be taken at.
   */
  function awaitCaptureAck(active: BrowserHostView) {
    active.prepareCapture();

    return new Promise<typeof marks>((resolve) => {
      const timer = setTimeout(() => settle(marks), browserCaptureAckTimeoutMs);
      const settle = (settled: typeof marks) => {
        clearTimeout(timer);
        if (pendingCaptureAck === settle) {
          pendingCaptureAck = null;
        }
        resolve(settled);
      };

      pendingCaptureAck = settle;
    });
  }

  async function captureForAnnotations(): Promise<BrowserAnnotationCapture | null> {
    if (!view) {
      return null;
    }

    const capturedView = view;
    const capturedNavigation = navigationId;
    const settled = await awaitCaptureAck(capturedView);

    try {
      // Closing or navigating a tab invalidates the page this handshake began on.
      if (view !== capturedView || navigationId !== capturedNavigation) {
        return null;
      }
      const image = await capturedView.capture(bounds?.width);
      if (view !== capturedView || navigationId !== capturedNavigation)
        return null;

      return {
        // Downsampled to the panel's own CSS width: `capturePage` answers in
        // device pixels, so on a 2x display a wide panel is a PNG approaching
        // the 8 MiB an image attachment may weigh, for pixels the model cannot
        // use. The overlay still (`browser_capture`) keeps them, because it is
        // displayed at the placeholder's size.
        image,
        annotations: settled.annotations,
        viewport: settled.viewport,
        url: view.readState().url,
      };
    } finally {
      // However the shot ended — taken, abandoned, never answered — the page
      // gets told so its annotation-mode chrome can come back.
      capturedView.finishCapture();
    }
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
      return {
        url: state?.url || requestedUrl,
        canGoBack: state?.canGoBack ?? false,
        canGoForward: state?.canGoForward ?? false,
        navigationId,
        title,
        loading,
        error: errorMessage,
        designMode,
        annotations: marks.annotations,
        viewport: marks.viewport,
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
        case "browser_clear_annotations":
          marks = { annotations: [], viewport: null };
          view?.clearAnnotations();
          return null;
        case "browser_capture":
          // Full resolution and no handshake: this still stands in for the
          // native view while a DOM overlay is open, so it has to show the page
          // exactly as it is, marks and all.
          return view ? view.capture() : null;
        case "browser_capture_annotation":
          return captureForAnnotations();
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

    recordAnnotations(annotations, viewport) {
      marks = { annotations, viewport };
    },

    recordCaptureReady(annotations, viewport) {
      marks = { annotations, viewport };
      pendingCaptureAck?.(marks);
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
      marks = { annotations: [], viewport: null };
      // A capture waiting on a page that is going away has to be let go, or it
      // sits on its timeout with a view it can no longer photograph.
      pendingCaptureAck?.(marks);
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

/** Session membership owns lifetime; the active target alone owns the native slot. */
export function createBrowserHost(deps: BrowserHostDependencies) {
  const sessions = new Map<
    string,
    { tabs: Map<string, BrowserTabHost>; activeTabId: string | null }
  >();
  let active: BrowserTabTarget | null = null;
  const revisions = new WeakMap<BrowserTabHost, number>();

  function session(sessionId: string) {
    let group = sessions.get(sessionId);
    if (!group) {
      group = { tabs: new Map(), activeTabId: null };
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
      }),
    );
    group.activeTabId = target.tabId;
  }
  function readSessionId(args?: Record<string, unknown>) {
    if (typeof args?.sessionId !== "string" || !args.sessionId)
      throw new Error("A Session id is required.");
    return args.sessionId;
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
    | BrowserAnnotationCapture
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
    }
    const target = readTarget(args);
    const controller = tab(target);
    if (
      ["browser_set_bounds", "browser_set_visible"].includes(command) &&
      !isActive(target)
    )
      return null;
    if (command === "browser_capture_annotation" && !isActive(target))
      return null;
    const result = controller.invoke(command, args);
    if (
      ![
        "browser_set_bounds",
        "browser_set_visible",
        "browser_capture",
        "browser_capture_annotation",
      ].includes(command)
    )
      notify(target);
    try {
      const answer = await result;
      if (command === "browser_capture_annotation")
        return isActive(target)
          ? (answer as BrowserAnnotationCapture | null)
          : null;
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
          "browser_capture_annotation",
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
