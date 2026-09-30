import { afterEach, describe, expect, it, vi } from "vitest";

const { exposeInMainWorld } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-pigui-vibrancy");
  delete document.documentElement.dataset.piguiPlatform;
});

describe("renderer preload", () => {
  it("exposes the bridge before HTML exists and marks vibrancy when DOM is ready", async () => {
    vi.resetModules();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const root = document.documentElement;
    const rootGetter = vi.spyOn(document, "documentElement", "get");
    rootGetter.mockReturnValue(null as unknown as HTMLElement);

    await expect(import("./preload")).resolves.toBeDefined();
    expect(exposeInMainWorld).toHaveBeenCalledWith("pace", expect.any(Object));

    rootGetter.mockReturnValue(root);
    window.dispatchEvent(new Event("DOMContentLoaded"));
    expect(root).toHaveAttribute("data-pigui-vibrancy");
    expect(root.dataset.piguiPlatform).toBe("darwin");
  });

  it("marks Linux without the macOS vibrancy gutter signal", async () => {
    vi.resetModules();
    vi.stubGlobal("process", { ...process, platform: "linux" });

    await import("./preload");
    window.dispatchEvent(new Event("DOMContentLoaded"));

    expect(document.documentElement.dataset.piguiPlatform).toBe("linux");
    expect(document.documentElement).not.toHaveAttribute("data-pigui-vibrancy");
  });
});
