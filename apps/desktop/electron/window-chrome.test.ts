import { describe, expect, it } from "vitest";
import { platformWindowChrome } from "./window-chrome";

describe("platform window chrome", () => {
  it("keeps macOS traffic lights and vibrancy on darwin", () => {
    expect(platformWindowChrome("darwin")).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 13 },
      transparent: true,
      vibrancy: "under-window",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
    });
  });

  it("lets the window manager draw the Linux title bar", () => {
    expect(platformWindowChrome("linux")).toEqual({ frame: true });
  });

  it("does not invent window controls for other platforms", () => {
    expect(platformWindowChrome("win32")).toEqual({ titleBarStyle: "hidden" });
  });
});
