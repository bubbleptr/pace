import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewState } from "@/shared/browser-protocol";
import {
  browserCaptureAckTimeoutMs,
  browserTitlebarBandPx,
  createBrowserHost,
  createBrowserTabHost,
  createBrowserSessionProvider,
  isBrowserCommand,
  normalizeBrowserUrl,
  resolveBrowserViewBounds,
  type BrowserHostView,
} from "./browser-host";

function createFakeView() {
  const calls: string[] = [];
  let url = "";

  const view: BrowserHostView & {
    calls: string[];
    bounds: { x: number; y: number; width: number; height: number } | null;
    visible: boolean;
    destroyed: boolean;
    loadRejection: Error | null;
    loadCount: () => number;
  } = {
    calls,
    bounds: null,
    visible: false,
    destroyed: false,
    loadRejection: null,
    loadCount: () => calls.filter((call) => call.startsWith("loadUrl")).length,
    setBounds(bounds) {
      view.bounds = bounds;
      calls.push(
        `setBounds(${bounds.x},${bounds.y},${bounds.width},${bounds.height})`,
      );
    },
    setVisible(visible) {
      view.visible = visible;
      calls.push(`setVisible(${visible})`);
    },
    async loadUrl(next) {
      calls.push(`loadUrl(${next})`);
      // Chromium commits its error page under the requested URL, so a failed
      // load leaves getURL() reporting the target just like a good one.
      url = next;
      if (view.loadRejection) {
        throw view.loadRejection;
      }
    },
    goBack() {
      calls.push("goBack");
    },
    setDesignMode(enabled, palette) {
      calls.push(`setDesignMode(${enabled}${palette ? ",palette" : ""})`);
      calls.push(`palette(${palette ? JSON.stringify(palette) : ""})`);
    },
    prepareCapture() {
      calls.push("prepareCapture");
    },
    finishCapture() {
      calls.push("finishCapture");
    },
    clearAnnotations() {
      calls.push("clearAnnotations");
    },
    goForward() {
      calls.push("goForward");
    },
    reload() {
      calls.push("reload");
    },
    destroy() {
      view.destroyed = true;
      calls.push("destroy");
    },
    async capture(maxWidth) {
      calls.push(`capture(${maxWidth ?? ""})`);
      return "data:image/png;base64,SNAPSHOT";
    },
    readState() {
      return { url, canGoBack: false, canGoForward: false };
    },
  };

  return view;
}

function createHostHarness(
  contentSize: { width: number; height: number } | null = {
    width: 1440,
    height: 900,
  },
) {
  const views: ReturnType<typeof createFakeView>[] = [];
  const externals: string[] = [];
  const host = createBrowserTabHost({
    createView() {
      const view = createFakeView();
      views.push(view);
      return view;
    },
    getContentSize: () => contentSize,
    openExternal(url) {
      externals.push(url);
    },
  });

  return { host, views, externals };
}

describe("normalizeBrowserUrl", () => {
  it("keeps http and https URLs and infers a scheme for bare input", () => {
    expect(normalizeBrowserUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeBrowserUrl("  http://example.com  ")).toBe(
      "http://example.com/",
    );
    // Public hosts must not fall back to cleartext…
    expect(normalizeBrowserUrl("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    // …but a dev server typed as host:port is exactly what this surface is for.
    expect(normalizeBrowserUrl("localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(normalizeBrowserUrl("127.0.0.1:3000/app")).toBe(
      "http://127.0.0.1:3000/app",
    );
  });

  it("refuses everything that is not http or https", () => {
    expect(() => normalizeBrowserUrl("file:///etc/hosts")).toThrow(/http/i);
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(/http/i);
    expect(() => normalizeBrowserUrl("data:text/html,<b>x</b>")).toThrow(
      /http/i,
    );
    expect(() => normalizeBrowserUrl("   ")).toThrow();
  });
});

describe("resolveBrowserViewBounds", () => {
  const contentSize = { width: 1440, height: 900 };

  it("passes a well-formed rect through, rounded", () => {
    expect(
      resolveBrowserViewBounds({
        rect: { x: 887.6, y: 80.2, width: 544.4, height: 780.1 },
        contentSize,
      }),
    ).toEqual({ x: 888, y: 80, width: 544, height: 780 });
  });

  it("clamps a renderer rect that would escape the window or cover the titlebar band", () => {
    expect(
      resolveBrowserViewBounds({
        rect: { x: -40, y: 0, width: 4000, height: 4000 },
        contentSize,
      }),
    ).toEqual({
      x: 0,
      y: browserTitlebarBandPx,
      width: 1440,
      height: 900 - browserTitlebarBandPx,
    });
  });

  it("never reports a negative size for a collapsed or off-screen rect", () => {
    expect(
      resolveBrowserViewBounds({
        rect: { x: 2000, y: 2000, width: -10, height: -10 },
        contentSize,
      }),
    ).toEqual({ x: 1440, y: 900, width: 0, height: 0 });
  });
});

describe("browser host commands", () => {
  /** What the page reported while marking, and what it acks at capture time. */
  const marked = {
    annotations: [
      {
        id: "m1",
        index: 1,
        selector: "#cta",
        tag: "button",
        rect: { x: 0, y: 0, width: 8, height: 8 },
      },
    ],
    viewport: { width: 684, height: 820, dpr: 2 },
  };
  const acked = {
    annotations: [{ ...marked.annotations[0]!, comment: "Too small to hit" }],
    viewport: { width: 900, height: 820, dpr: 2 },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the view on the first navigate and reports the loaded state", async () => {
    const { host, views } = createHostHarness();

    const state = await host.invoke("browser_navigate", {
      url: "localhost:5173",
    });

    expect(views).toHaveLength(1);
    expect(views[0].calls).toContain("loadUrl(http://localhost:5173/)");
    expect(state).toMatchObject({ url: "http://localhost:5173/" });
  });

  it("does not reload when asked to navigate to the URL already showing", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_navigate", { url: "localhost:5173" });

    expect(views).toHaveLength(1);
    expect(views[0].loadCount()).toBe(1);
  });

  it("retries a URL the view is only showing because its load failed", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    // The error page sits under the requested URL, so "already showing" and
    // "already failed" look identical from getURL() alone — Retry and
    // re-entering the surface would both become no-ops.
    host.recordLoadFailure();
    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });

    expect(views[0].loadCount()).toBe(2);
  });

  it("remembers a rejected load as a failure without being told", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    views[0].loadRejection = new Error("ERR_CONNECTION_REFUSED");

    await expect(
      host.invoke("browser_navigate", { url: "http://localhost:4000/" }),
    ).rejects.toThrow("ERR_CONNECTION_REFUSED");

    views[0].loadRejection = null;
    await host.invoke("browser_navigate", { url: "http://localhost:4000/" });

    expect(views[0].loadCount()).toBe(3);
  });

  it("treats an aborted load as a success, because the page replaced it", async () => {
    const { host, views } = createHostHarness();
    // A page that navigates again before its first load finishes (baidu.com
    // does) makes Electron reject the original loadURL with ERR_ABORTED. The
    // page is fine; only the superseded request went away.
    const aborted = Object.assign(
      new Error("ERR_ABORTED (-3) loading 'https://www.baidu.com/'"),
      {
        errno: -3,
        code: "ERR_ABORTED",
      },
    );

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    views[0].loadRejection = aborted;

    await expect(
      host.invoke("browser_navigate", { url: "https://www.baidu.com/" }),
    ).resolves.toMatchObject({ url: "https://www.baidu.com/" });

    views[0].loadRejection = null;
    // Not a failure, so re-entering the surface still short-circuits rather
    // than reloading the page the user is looking at.
    await host.invoke("browser_navigate", { url: "https://www.baidu.com/" });

    expect(views[0].loadCount()).toBe(2);
  });

  it("short-circuits again once a load has succeeded", async () => {
    const { host, views } = createHostHarness();

    host.recordLoadFailure();
    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });

    expect(views[0].loadCount()).toBe(1);
  });

  it("stamps a fresh navigation id on every navigate", async () => {
    const { host } = createHostHarness();
    // The command group is heterogeneous (capture answers with a data URL), so
    // the navigate results need narrowing before the ids can be compared.
    const navigate = async (url: string) =>
      (await host.invoke("browser_navigate", { url })) as BrowserViewState;

    const first = await navigate("http://a.test/");
    const second = await navigate("http://b.test/");

    expect(second.navigationId).toBe(first.navigationId + 1);
    // Events main forwards carry whatever id is current, so a page still
    // talking after a Project switch is distinguishable from the new one.
    expect(host.currentNavigationId()).toBe(second.navigationId);
  });

  it("refuses to navigate to a non-http scheme and never creates a view for it", async () => {
    const { host, views } = createHostHarness();

    await expect(
      host.invoke("browser_navigate", { url: "file:///etc/hosts" }),
    ).rejects.toThrow(/http/i);
    expect(views).toHaveLength(0);
  });

  it("keeps the view hidden until it has usable bounds", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    // Visibility asked for before any bounds arrived: showing now would paint
    // the native view at 0,0 over the whole window.
    await host.invoke("browser_set_visible", { visible: true });
    expect(views[0].visible).toBe(false);

    await host.invoke("browser_set_bounds", {
      rect: { x: 900, y: 80, width: 500, height: 700 },
    });
    expect(views[0].visible).toBe(true);

    // A collapsed rect (panel closed mid-drag) hides it again.
    await host.invoke("browser_set_bounds", {
      rect: { x: 900, y: 80, width: 0, height: 0 },
    });
    expect(views[0].visible).toBe(false);
  });

  it("clamps renderer bounds against the live window content size", async () => {
    const { host, views } = createHostHarness({ width: 1000, height: 700 });

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_bounds", {
      rect: { x: 800, y: 0, width: 900, height: 900 },
    });

    expect(views[0].bounds).toEqual({ x: 800, y: 40, width: 200, height: 660 });
  });

  it("applies bounds and visibility that arrived before the view existed", async () => {
    const { host, views } = createHostHarness();

    // The surface renders its placeholder optimistically, so bounds and
    // visibility can reach main ahead of the navigate that creates the view.
    // Dropping them there would leave the view unbounded and never visible.
    await host.invoke("browser_set_bounds", {
      rect: { x: 900, y: 80, width: 500, height: 700 },
    });
    await host.invoke("browser_set_visible", { visible: true });

    expect(views).toHaveLength(0);

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });

    expect(views[0].bounds).toEqual({ x: 900, y: 80, width: 500, height: 700 });
    expect(views[0].visible).toBe(true);
  });

  it("ignores navigation controls while no view exists", async () => {
    const { host, views } = createHostHarness();

    await expect(host.invoke("browser_back")).resolves.toBeNull();
    await expect(host.invoke("browser_reload")).resolves.toBeNull();
    await expect(
      host.invoke("browser_set_bounds", {
        rect: { x: 0, y: 40, width: 10, height: 10 },
      }),
    ).resolves.toBeNull();
    expect(views).toHaveLength(0);
  });

  it("opens external URLs through the shell without creating a view", async () => {
    const { host, views, externals } = createHostHarness();

    await host.invoke("browser_open_external", { url: "example.com" });

    expect(externals).toEqual(["https://example.com/"]);
    expect(views).toHaveLength(0);
    await expect(
      host.invoke("browser_open_external", { url: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/i);
  });

  it("rejects unknown commands in the group instead of silently succeeding", async () => {
    const { host } = createHostHarness();

    await expect(host.invoke("browser_teleport")).rejects.toThrow(
      /browser_teleport/,
    );
  });

  it("captures the page as a data URL, and answers null with no view to capture", async () => {
    const { host, views } = createHostHarness();

    // The surface asks for a still whenever a DOM overlay opens; before the
    // first navigate there is nothing to photograph, and inventing a blank
    // one would flash over the page.
    await expect(host.invoke("browser_capture")).resolves.toBeNull();
    expect(views).toHaveLength(0);

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });

    await expect(host.invoke("browser_capture")).resolves.toBe(
      "data:image/png;base64,SNAPSHOT",
    );
  });

  it("caps the annotation capture at the panel's own CSS width", async () => {
    const { host, views } = createHostHarness();

    await expect(host.invoke("browser_capture_annotation")).resolves.toBeNull();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_bounds", {
      rect: { x: 748, y: 40, width: 684, height: 820 },
    });

    await host.invoke("browser_capture");

    const capture = host.invoke("browser_capture_annotation");

    host.recordCaptureReady([], marked.viewport);
    await capture;

    // The still that stands in for the native view keeps every device pixel,
    // because it is shown at the placeholder's own size. The one that becomes
    // a prompt attachment does not: a 2x capture of a wide panel is a PNG
    // approaching the 8 MiB image ceiling, and the model gains nothing from it.
    expect(views[0]!.calls).toContain("capture()");
    expect(views[0]!.calls).toContain("capture(684)");
  });

  it("has the page settle its overlay before the shot, and sends what it acked", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_bounds", {
      rect: { x: 748, y: 40, width: 684, height: 820 },
    });
    // What main heard while the user was still marking.
    host.recordAnnotations(marked.annotations, marked.viewport);

    const capture = host.invoke("browser_capture_annotation");

    // The page answers the prepare with the comment it has just committed and
    // a viewport measured now, after the panel was dragged wider.
    host.recordCaptureReady(acked.annotations, acked.viewport);

    expect(await capture).toEqual({
      image: "data:image/png;base64,SNAPSHOT",
      annotations: acked.annotations,
      viewport: acked.viewport,
      url: "http://localhost:5173/",
    });
    // Order is the whole point: shooting first would print the open comment
    // bubble and a stale hover box onto what Pi reads — and the page is told
    // when the shot is over so its annotation chrome can come back.
    expect(views[0]!.calls.slice(-3)).toEqual([
      "prepareCapture",
      "capture(684)",
      "finishCapture",
    ]);
  });

  it("shoots anyway when the page never answers, using what main last heard", async () => {
    vi.useFakeTimers();

    try {
      const { host, views } = createHostHarness();

      await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
      host.recordAnnotations(marked.annotations, marked.viewport);

      const capture = host.invoke("browser_capture_annotation");

      // No annotation preload is listening — a page that replaced the document
      // before its overlay reported in, say. The toolbar must not hang on it.
      await vi.advanceTimersByTimeAsync(browserCaptureAckTimeoutMs);

      expect(await capture).toMatchObject({
        annotations: marked.annotations,
        viewport: marked.viewport,
      });
      expect(views[0]!.calls).toContain("capture()");
      // Even the bail-out tells the page the shot is over.
      expect(views[0]!.calls).toContain("finishCapture");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drives design mode through the view and remembers it for the next document", async () => {
    const { host, views } = createHostHarness();

    // Turning Design on over the empty state must not conjure a view: there is
    // no page to mark up yet.
    await host.invoke("browser_set_design_mode", { enabled: true });
    expect(views).toHaveLength(0);
    expect(host.isDesignModeEnabled()).toBe(true);

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_design_mode", { enabled: true });
    await host.invoke("browser_clear_annotations");

    expect(views[0]!.calls).toContain("setDesignMode(true)");
    expect(views[0]!.calls).toContain("clearAnnotations");
  });

  it("stores a valid palette for ready replays and forwards it to the view", async () => {
    const { host, views } = createHostHarness();
    const palette = {
      accent: "#0064E0",
      accentForeground: "#ffffff",
      surface: "#1f1f22",
      foreground: "#dfe2e5",
      border: "#494d53",
      muted: "#aaafb5",
    };

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_design_mode", { enabled: true, palette });

    expect(views[0]!.calls).toContain(
      `palette(${JSON.stringify(palette)})`,
    );
    // Fresh documents get it back when their overlay reports in.
    expect(host.annotationPalette()).toEqual(palette);
  });

  it("ignores a malformed palette wholesale instead of forwarding part of it", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_design_mode", {
      enabled: true,
      palette: { accent: "#0064E0", surface: 42 },
    });

    expect(host.annotationPalette()).toBeUndefined();
    expect(views[0]!.calls).toContain("palette()");
  });

  it("records design mode the page left on its own without commanding it back", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_design_mode", { enabled: true });

    // Escape inside the page. Main learns about it so the next document is not
    // put back into design mode, but the page is already out of it — telling
    // it again would fight the overlay's own state.
    const callsBefore = views[0]!.calls.length;

    host.recordDesignMode(false);

    expect(host.isDesignModeEnabled()).toBe(false);
    expect(views[0]!.calls).toHaveLength(callsBefore);
  });

  it("claims only the commands it implements, so the backend keeps the rest", () => {
    for (const command of [
      "browser_capture",
      "browser_capture_annotation",
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_set_bounds",
      "browser_set_visible",
      "browser_set_design_mode",
      "browser_clear_annotations",
      "browser_open_external",
    ]) {
      expect(isBrowserCommand(command)).toBe(true);
    }

    // Sniffing the `browser_` prefix would hijack any future backend command
    // that happens to start with it.
    expect(isBrowserCommand("browser_screenshot")).toBe(false);
    expect(isBrowserCommand("list_terminals")).toBe(false);
  });
});

describe("browser host security handlers", () => {
  it("allows only http and https for page-initiated navigation", () => {
    const { host } = createHostHarness();

    expect(host.allowsNavigationTo("https://example.com")).toBe(true);
    expect(host.allowsNavigationTo("http://localhost:5173/")).toBe(true);
    expect(host.allowsNavigationTo("file:///etc/hosts")).toBe(false);
    expect(host.allowsNavigationTo("javascript:alert(1)")).toBe(false);
    expect(host.allowsNavigationTo("data:text/html,<b>x</b>")).toBe(false);
    expect(host.allowsNavigationTo("not a url")).toBe(false);
  });

  it("turns a refused window.open into an in-place navigation, but only for http(s)", async () => {
    const { host, views } = createHostHarness();

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });

    host.handleWindowOpen("https://example.com/next");
    expect(views[0].calls).toContain("loadUrl(https://example.com/next)");

    host.handleWindowOpen("javascript:alert(1)");
    expect(views[0].calls).not.toContain("loadUrl(javascript:alert(1))");
    // A blocked popup must never spawn a second native view either.
    expect(views).toHaveLength(1);
  });

  it("denies every page permission request", () => {
    const { host } = createHostHarness();

    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "midi",
      "clipboard-read",
      "display-capture",
      "fullscreen",
      "openExternal",
    ]) {
      expect(host.allowsPermission(permission)).toBe(false);
    }
  });
});

function createFakeSession() {
  const registrations = {
    permissionRequest: 0,
    permissionCheck: 0,
    downloadBlockers: 0,
  };
  let permissionHandler: ((permission: string) => boolean) | null = null;

  return {
    registrations,
    decidePermission: (permission: string) => permissionHandler?.(permission),
    setPermissionRequestHandler(handler: (permission: string) => boolean) {
      registrations.permissionRequest += 1;
      permissionHandler = handler;
    },
    setPermissionCheckHandler() {
      registrations.permissionCheck += 1;
    },
    blockDownloads() {
      registrations.downloadBlockers += 1;
    },
  };
}

describe("browser session provider", () => {
  it("configures the shared persistent session once, however often the view is recreated", () => {
    const persistent = createFakeSession();
    let built = 0;
    const provide = createBrowserSessionProvider(
      () => {
        built += 1;
        return persistent;
      },
      () => false,
    );

    // Disposing and re-creating the view asks for the session again, and
    // `session.fromPartition` hands back the same object every time. Permission
    // handlers replace, but a download blocker is a listener: registering it
    // per view would stack one copy per recreation.
    expect(provide()).toBe(persistent);
    expect(provide()).toBe(persistent);
    expect(provide()).toBe(persistent);

    expect(built).toBe(1);
    expect(persistent.registrations).toEqual({
      permissionRequest: 1,
      permissionCheck: 1,
      downloadBlockers: 1,
    });
    expect(persistent.decidePermission("geolocation")).toBe(false);
  });
});

describe("Browser multi-instance host", () => {
  function createHostHarness() {
    const views: ReturnType<typeof createFakeView>[] = [];
    const host = createBrowserHost({
      createView() {
        const view = createFakeView();
        views.push(view);
        return view;
      },
      getContentSize: () => ({ width: 1440, height: 900 }),
      openExternal() {},
    });
    return { host, views };
  }
  const first = { sessionId: "session-a", tabId: "a" };
  const second = { sessionId: "session-a", tabId: "b" };
  const rect = { x: 800, y: 120, width: 600, height: 700 };

  it("routes navigation by tab and lets only the active tab receive bounds and visibility", async () => {
    const { host, views } = createHostHarness();
    await host.invoke("browser_open", first);
    await host.invoke("browser_navigate", { ...first, url: "localhost:3000" });
    await host.invoke("browser_set_bounds", { ...first, rect });
    await host.invoke("browser_set_visible", { ...first, visible: true });
    expect(views[0]?.visible).toBe(true);
    await host.invoke("browser_open", second);
    await host.invoke("browser_navigate", { ...second, url: "localhost:4000" });
    expect(views[0]?.visible).toBe(false);
    expect(views[1]?.visible).toBe(false);
    await host.invoke("browser_set_bounds", { ...second, rect });
    await host.invoke("browser_set_visible", { ...second, visible: true });
    await host.invoke("browser_set_bounds", {
      ...first,
      rect: { ...rect, width: 5 },
    });
    await host.invoke("browser_set_visible", { ...first, visible: true });
    expect(views.map((view) => view.visible)).toEqual([false, true]);
    expect(views[1]?.bounds).toEqual(rect);
    await host.invoke("browser_activate", first);
    await host.invoke("browser_set_bounds", { ...first, rect });
    await host.invoke("browser_set_visible", { ...first, visible: true });
    expect(views.map((view) => view.visible)).toEqual([true, false]);
    expect(views[0]?.loadCount()).toBe(1);
    expect(views[0]?.readState().url).toBe("http://localhost:3000/");
  });

  it("keeps annotations per tab and cancels captures when their tab is closed", async () => {
    const { host, views } = createHostHarness();
    await host.invoke("browser_open", first);
    await host.invoke("browser_navigate", { ...first, url: "localhost:3000" });
    await host.invoke("browser_set_design_mode", { ...first, enabled: true });
    host
      .tab(first)
      .recordAnnotations(
        [{ id: "a1", index: 1, selector: "#a", tag: "p", rect }],
        null,
      );
    const capture = host.invoke("browser_capture_annotation", first);
    await host.invoke("browser_open", second);
    await host.invoke("browser_navigate", { ...second, url: "localhost:4000" });
    expect(host.readTab(second)).toMatchObject({
      designMode: false,
      annotations: [],
    });
    expect(host.readTab(first)).toMatchObject({
      designMode: true,
      annotations: [{ selector: "#a" }],
    });
    await host.invoke("browser_close", first);
    expect(await capture).toBeNull();
    expect(views[0]?.destroyed).toBe(true);
    expect(views[1]?.destroyed).toBe(false);
  });

  it("restores saved tabs on request, preserves existing tabs, and leaves an empty reattach empty", async () => {
    const { host, views } = createHostHarness();
    expect(await host.invoke("browser_attach", { sessionId: "session-a" }))
      .toMatchObject({ tabs: [], activeTabId: null });
    expect(views).toHaveLength(0);

    await host.invoke("browser_attach", {
      sessionId: "session-a",
      tabs: ["localhost:3000", "localhost:4000"],
      activeIndex: 1,
    });
    const group = (await host.invoke("browser_list", {
      sessionId: "session-a",
    })) as import("@/shared/browser-protocol").BrowserSessionState;
    expect(group.tabs).toHaveLength(2);
    expect(group.activeTabId).toBe(group.tabs[1]?.tabId);
    await host.invoke("browser_attach", {
      sessionId: "session-b",
      tabs: ["localhost:5000"],
      activeIndex: 0,
    });
    await host.invoke("browser_attach", {
      sessionId: "session-a",
      tabs: ["localhost:6000"],
      activeIndex: 0,
    });
    expect(
      await host.invoke("browser_list", { sessionId: "session-a" }),
    ).toMatchObject({
      activeTabId: group.activeTabId,
      tabs: [{ tabId: group.tabs[0]?.tabId }, { tabId: group.tabs[1]?.tabId }],
    });
    for (const tab of group.tabs) await host.invoke("browser_close", tab);
    expect(
      await host.invoke("browser_attach", {
        sessionId: "session-a",
      }),
    ).toMatchObject({ tabs: [], activeTabId: null });
  });

  it("rejects commands for a tab outside the requested Session", async () => {
    const { host } = createHostHarness();
    await host.invoke("browser_open", first);
    await expect(
      host.invoke("browser_navigate", {
        ...first,
        sessionId: "other",
        url: "localhost:4000",
      }),
    ).rejects.toThrow(/tab/i);
  });
});
