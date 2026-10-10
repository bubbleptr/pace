import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationElement,
  BrowserAnnotationViewport,
  BrowserComment,
  BrowserViewState,
} from "@/shared/browser-protocol";
import {
  browserTitlebarBandPx,
  createBrowserHost,
  createBrowserTabHost,
  createBrowserSessionProvider,
  isBrowserCommand,
  maxSessionComments,
  normalizeBrowserUrl,
  resolveBrowserViewBounds,
  resolveCommentCropRect,
  urlKey,
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
    synced: { id: string }[];
    cropResult: string | null;
  } = {
    calls,
    bounds: null,
    visible: false,
    destroyed: false,
    loadRejection: null,
    synced: [],
    cropResult: "data:image/png;base64,CROP",
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
    setAnnotationPalette(palette) {
      calls.push("setAnnotationPalette");
      calls.push(`palette(${JSON.stringify(palette)})`);
    },
    finishCapture() {
      calls.push("finishCapture");
    },
    syncAnnotations(list) {
      calls.push(
        `syncAnnotations(${list.map((a: { id: string }) => a.id).join(",")})`,
      );
      view.synced = list;
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
    async captureRect(rect, cssWidth) {
      calls.push(
        `captureRect(${rect.x},${rect.y},${rect.width},${rect.height}@${cssWidth})`,
      );
      return view.cropResult;
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
  snapshotComments?: (currentUrl: string) => {
    annotations: BrowserAnnotationElement[];
    viewport: BrowserAnnotationViewport | null;
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
    snapshotComments,
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

  it("drives design mode through the view and remembers it for the next document", async () => {
    const { host, views } = createHostHarness();

    // Turning Design on over the empty state must not conjure a view: there is
    // no page to mark up yet.
    await host.invoke("browser_set_design_mode", { enabled: true });
    expect(views).toHaveLength(0);
    expect(host.isDesignModeEnabled()).toBe(true);

    await host.invoke("browser_navigate", { url: "http://localhost:5173/" });
    await host.invoke("browser_set_design_mode", { enabled: true });

    expect(views[0]!.calls).toContain("setDesignMode(true)");
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

  it("validates palette-only updates without changing design mode", async () => {
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
    await host.invoke("browser_set_annotation_palette", { palette });

    expect(host.annotationPalette()).toEqual(palette);
    expect(host.isDesignModeEnabled()).toBe(false);
    expect(views[0]!.calls).toContain("setAnnotationPalette");
    expect(views[0]!.calls).not.toContain("setDesignMode(false)");

    const callCount = views[0]!.calls.length;
    await host.invoke("browser_set_annotation_palette", {
      palette: { ...palette, surface: 42 },
    });

    expect(host.annotationPalette()).toEqual(palette);
    expect(views[0]!.calls).toHaveLength(callCount);
    expect(host.isDesignModeEnabled()).toBe(false);
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
      "browser_comment_images",
      "browser_delete_comment",
      "browser_consume_comments",
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

  it("keeps annotations per tab and drops only the view when a tab is closed", async () => {
    const { host, views } = createHostHarness();
    await host.invoke("browser_open", first);
    await host.invoke("browser_navigate", { ...first, url: "localhost:3000" });
    await host.invoke("browser_set_design_mode", { ...first, enabled: true });
    await host.saveComment(
      first,
      { id: "a1", index: 1, selector: "#a", tag: "p", rect },
      { width: 600, height: 700, dpr: 1 },
      "http://localhost:3000/",
    );
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
    // Closing removes the view and its markers — the comment lives in the
    // Session store and outlives both.
    await host.invoke("browser_close", first);
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

describe("Session comment store", () => {
  const first = { sessionId: "s", tabId: "a" };
  const second = { sessionId: "s", tabId: "b" };
  const viewport = { width: 800, height: 600, dpr: 1 };

  function annotation(id: string, comment = `note ${id}`) {
    return {
      id,
      index: 1,
      selector: `#${id}`,
      tag: "button",
      rect: { x: 100, y: 100, width: 40, height: 20 },
      comment,
    };
  }

  function harness() {
    const views: ReturnType<typeof createFakeView>[] = [];
    const events: {
      type: string;
      revision?: number;
      comments?: unknown[];
    }[] = [];
    const host = createBrowserHost({
      createView() {
        const view = createFakeView();
        views.push(view);
        return view;
      },
      getContentSize: () => ({ width: 1440, height: 900 }),
      openExternal() {},
      emit: (event) => events.push(event as { type: string }),
    });

    const list = async () =>
      ((
        await host.invoke("browser_list_comments", {
          sessionId: first.sessionId,
        })
      ) as { revision: number; comments: BrowserComment[] }).comments;

    return { host, views, events, list };
  }

  async function openOn(host: ReturnType<typeof harness>["host"], target: typeof first, url: string) {
    await host.invoke("browser_open", target);
    await host.invoke("browser_navigate", { ...target, url });
  }

  it("stores a saved comment, takes its crop, and publishes the change", async () => {
    const { host, views, events, list } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");

    const comments = await list();

    expect(comments).toHaveLength(1);
    expect(comments?.[0]).toMatchObject({
      id: "c1",
      index: 1,
      selector: "#c1",
      tabId: "a",
      url: "http://localhost:3000/",
      comment: "note c1",
      stale: false,
      hasImage: true,
      viewport,
    });
    // The element's region, expanded and clamped, was photographed — and the
    // page was always released afterwards.
    expect(views[0]!.calls).toContain("captureRect(0,10,320,200@320)");
    expect(views[0]!.calls).toContain("finishCapture");
    // The sync carries only this tab's marks on this URL.
    expect(views[0]!.synced).toMatchObject([{ id: "c1", index: 1 }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "comments-changed",
        comments: [expect.objectContaining({ id: "c1" })],
      }),
    );
  });

  it("updates only the comment text when the page edits its own annotation", async () => {
    const { host, views, list } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.saveComment(first, annotation("c1", "edited"), viewport, "http://localhost:3000/");

    const comments = await list();

    expect(comments).toHaveLength(1);
    expect(comments?.[0]?.comment).toBe("edited");
    // No second crop: an edit is not a new mark, so nothing is re-shot.
    expect(
      views[0]!.calls.filter((call) => call.startsWith("captureRect")),
    ).toHaveLength(1);
  });

  it("ignores a save that carries another tab's id", async () => {
    const { host, views, list } = harness();

    await openOn(host, first, "localhost:3000");
    await openOn(host, second, "localhost:4000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    // Tab b cannot edit a comment that belongs to tab a.
    await host.saveComment(second, annotation("c1", "hijacked"), viewport, "http://localhost:4000/");

    const comments = await list();

    expect(comments).toHaveLength(1);
    expect(comments?.[0]?.comment).toBe("note c1");
    expect(views[1]!.calls.filter((c) => c.startsWith("captureRect"))).toHaveLength(0);
  });

  it("ignores saves beyond the Session cap", async () => {
    const { host, list } = harness();

    await openOn(host, first, "localhost:3000");
    for (let i = 0; i < maxSessionComments + 3; i += 1) {
      await host.saveComment(first, annotation(`c${i}`), viewport, "http://localhost:3000/");
    }

    expect(await list()).toHaveLength(maxSessionComments);
  });

  it("releases the overlay, resyncs and reports when a save hits the Session cap", async () => {
    const { host, views, events, list } = harness();

    await openOn(host, first, "localhost:3000");
    for (let i = 0; i < maxSessionComments; i += 1) {
      await host.saveComment(first, annotation(`c${i}`), viewport, "http://localhost:3000/");
    }
    views[0]!.calls.length = 0;

    await host.saveComment(first, annotation("over"), viewport, "http://localhost:3000/");

    expect(await list()).toHaveLength(maxSessionComments);
    // The overlay hid itself for the save's crop: it must come back, and the
    // store's truth pushed back removes the phantom mark it drew locally.
    expect(views[0]!.calls).toContain("finishCapture");
    expect(views[0]!.calls.filter((call) => call.startsWith("captureRect"))).toHaveLength(0);
    expect(views[0]!.synced).toHaveLength(maxSessionComments);
    expect(events[events.length - 1]).toMatchObject({
      type: "comment-rejected",
      sessionId: "s",
      tabId: "a",
      reason: "limit",
    });
  });

  it("drops a save filed from a document that already navigated away", async () => {
    const { host, views, list } = harness();

    await openOn(host, first, "localhost:3000");

    // The page said where it was when it saved; the tab has since moved.
    await host.saveComment(
      first,
      annotation("c1"),
      viewport,
      "http://localhost:3000/older",
    );

    expect(await list()).toHaveLength(0);
    // The overlay is still released — but no sync is owed: the document it
    // hid itself on is gone, its own ready/navigation sync reconciles.
    expect(views[0]!.calls).toContain("finishCapture");
    expect(views[0]!.calls.filter((call) => call.startsWith("captureRect"))).toHaveLength(0);
  });

  it("still finishes the capture handshake when the crop cannot be read", async () => {
    const { host, views, list } = harness();

    await openOn(host, first, "localhost:3000");
    views[0]!.cropResult = null;
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");

    expect((await list())?.[0]?.hasImage).toBe(false);
    expect(views[0]!.calls).toContain("finishCapture");
  });

  it("answers comment images by id, null for ones never taken", async () => {
    const { host, views } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    views[0]!.cropResult = null;
    await host.saveComment(first, annotation("c2"), viewport, "http://localhost:3000/");

    const images = await host.invoke("browser_comment_images", {
      sessionId: "s",
      ids: ["c1", "c2", "unknown"],
    });

    expect(images).toEqual({
      c1: "data:image/png;base64,CROP",
      c2: null,
      unknown: null,
    });
  });

  it("answers image ids that collide with an object key", async () => {
    const { host } = harness();

    await openOn(host, first, "localhost:3000");

    const images = (await host.invoke("browser_comment_images", {
      sessionId: "s",
      ids: ["__proto__"],
    })) as Record<string, string | null>;

    // "__proto__" must be an own data property — writing into a plain object
    // literal would mutate its prototype instead of answering the id.
    expect(Object.keys(images)).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(images, "__proto__")).toEqual({
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("keeps comments through navigation and scopes a tab's marks by urlKey", async () => {
    const { host, views } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");

    // Another document: the comment stays in the store but leaves the page.
    await host.invoke("browser_navigate", {
      ...first,
      url: "localhost:3000/other",
    });

    expect(host.readTab(first).annotations).toEqual([]);
    expect(
      (
        (await host.invoke("browser_list_comments", {
          sessionId: "s",
        })) as { comments: unknown[] }
      ).comments,
    ).toHaveLength(1);

    host.syncTabAnnotations(first, "http://localhost:3000/other");
    expect(views[0]!.synced).toEqual([]);

    // Hash-only differences are the same document: the marks come back.
    host.syncTabAnnotations(first, "http://localhost:3000/#section");
    expect(views[0]!.synced).toMatchObject([{ id: "c1" }]);
  });

  it("keeps a closed tab's comments in the store", async () => {
    const { host, list } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.invoke("browser_close", first);

    // Closing removes the view and its markers — never the comment.
    expect(await list()).toMatchObject([{ id: "c1", tabId: "a" }]);
  });

  it("clearing removes only the owning tab's comments", async () => {
    const { host, list } = harness();

    await openOn(host, first, "localhost:3000");
    await openOn(host, second, "localhost:4000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.saveComment(second, annotation("c2"), viewport, "http://localhost:4000/");
    await host.invoke("browser_clear_annotations", first);

    expect(await list()).toMatchObject([{ id: "c2", tabId: "b" }]);
  });

  it("deletes and consumes exactly the ids given", async () => {
    const { host, list } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.saveComment(first, annotation("c2"), viewport, "http://localhost:3000/");
    await host.invoke("browser_delete_comment", { sessionId: "s", id: "gone" });
    expect(await list()).toHaveLength(2);

    await host.invoke("browser_delete_comment", { sessionId: "s", id: "c1" });
    expect(await list()).toMatchObject([{ id: "c2", index: 1 }]);

    // Consume removes only what it names — a comment saved since the
    // composer's snapshot was taken survives.
    await host.saveComment(first, annotation("c3"), viewport, "http://localhost:3000/");
    await host.invoke("browser_consume_comments", {
      sessionId: "s",
      ids: ["c2", "unknown"],
    });
    expect(await list()).toMatchObject([{ id: "c3", index: 1 }]);
  });

  it("renumbers Session indices after a delete and resyncs every tab", async () => {
    const { host, views } = harness();

    await openOn(host, first, "localhost:3000");
    await openOn(host, second, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.saveComment(second, annotation("c2"), viewport, "http://localhost:3000/");
    await host.invoke("browser_delete_comment", { sessionId: "s", id: "c1" });

    // The deleted comment's successor moves up — the store's numbering is
    // positional, not a saved field.
    expect(views[0]!.synced).toEqual([]);
    expect(views[1]!.synced).toMatchObject([{ id: "c2", index: 1 }]);
  });

  it("marks stale only for the tab the presence came from", async () => {
    const { host, list, events } = harness();

    await openOn(host, first, "localhost:3000");
    await openOn(host, second, "localhost:4000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");

    host.markStale(second, "c1", true);
    expect((await list())?.[0]?.stale).toBe(false);

    host.markStale(first, "c1", true);
    expect((await list())?.[0]?.stale).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "comments-changed" });

    // No second event for the same value.
    const emitted = events.length;
    host.markStale(first, "c1", true);
    expect(events).toHaveLength(emitted);
  });

  it("stamps every comments-changed with the store's growing revision", async () => {
    const { host, events } = harness();

    await openOn(host, first, "localhost:3000");
    await host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    await host.saveComment(first, annotation("c2"), viewport, "http://localhost:3000/");

    const changes = events.filter(
      (event) => event.type === "comments-changed",
    );

    expect(changes.length).toBeGreaterThanOrEqual(2);
    const last = changes[changes.length - 1]!;
    const firstChange = changes[0]!;
    expect(last.revision).toBeGreaterThan(firstChange.revision!);

    const reply = (await host.invoke("browser_list_comments", {
      sessionId: "s",
    })) as { revision: number };

    expect(reply.revision).toBe(last.revision);
  });

  it("settles an in-flight save before answering the send's list", async () => {
    const { host, views } = harness();

    await openOn(host, first, "localhost:3000");

    let releaseCrop = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseCrop = resolve;
    });
    views[0]!.captureRect = async () => {
      await gate;
      return "data:image/png;base64,LATE";
    };

    // IPC order is what makes this observable: the save's crop is in flight
    // when the settle request arrives.
    void host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    const settled = host.invoke("browser_settle_comments", {
      sessionId: "s",
    }) as Promise<{ revision: number; comments: BrowserComment[] }>;

    releaseCrop();
    const reply = await settled;

    // The send's read carries the comment its hook snapshot had not seen yet.
    expect(reply.comments).toMatchObject([{ id: "c1", hasImage: true }]);
    expect(reply.revision).toBeGreaterThan(0);
  });

  it("reads the store without touching tabs, views or activation", async () => {
    const { host, views } = harness();

    expect(
      (
        (await host.invoke("browser_list_comments", {
          sessionId: "s",
        })) as { comments: unknown[] }
      ).comments,
    ).toEqual([]);
    expect(views).toHaveLength(0);
  });

  it("waits for a pending save crop before publishing the page's send", async () => {
    const { host, views, events } = harness();
    let releaseCrop = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseCrop = resolve;
    });

    await openOn(host, first, "localhost:3000");
    views[0]!.captureRect = async () => {
      await gate;
      return "data:image/png;base64,LATE";
    };

    // IPC order is what makes this observable: the save's crop is pending
    // before the page can ask for the send that depends on it.
    void host.saveComment(first, annotation("c1"), viewport, "http://localhost:3000/");
    const submit = host.requestSubmit(first);

    // The request holds until the crop resolves: emitting now would publish a
    // send whose comments-changed has not gone out — and hasImage is not yet
    // known.
    await Promise.resolve();
    expect(events.some((event) => event.type === "submit-requested")).toBe(false);

    releaseCrop();
    await submit;

    const types = events.map((event) => event.type);
    const changed = types.lastIndexOf("comments-changed");
    const submitted = types.indexOf("submit-requested");

    expect(changed).toBeGreaterThanOrEqual(0);
    expect(submitted).toBeGreaterThan(changed);
    expect(events[changed]).toMatchObject({
      sessionId: "s",
      comments: [expect.objectContaining({ id: "c1", hasImage: true })],
    });
    expect(events[submitted]).toEqual({ type: "submit-requested", sessionId: "s" });
  });

  it("emits the send request at once with no crop pending, and ignores stray tabs", async () => {
    const { host, events } = harness();

    await openOn(host, first, "localhost:3000");

    await host.requestSubmit({ sessionId: "other", tabId: "z" });
    await host.requestSubmit({ sessionId: "s", tabId: "zzz" });
    expect(events.some((event) => event.type === "submit-requested")).toBe(false);

    await host.requestSubmit(first);
    expect(events).toContainEqual({ type: "submit-requested", sessionId: "s" });
  });
});

describe("urlKey", () => {
  it("identifies a document by origin, path and search — never hash", () => {
    expect(urlKey("http://localhost:3000/a?x=1#top")).toBe(
      "http://localhost:3000/a?x=1",
    );
    expect(urlKey("https://example.com/")).toBe("https://example.com/");
    // A URL that fails to parse falls back to itself — still a stable key.
    expect(urlKey("")).toBe("");
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
