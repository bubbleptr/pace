import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("gives Linux native window controls instead of a frameless titlebar", () => {
    const chrome = platformWindowChrome("linux");
    const titlebar = readFileSync(
      join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"),
      "utf8",
    );

    expect(chrome).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 40 },
    });
    expect(chrome).not.toHaveProperty("trafficLightPosition");
    expect(chrome).not.toHaveProperty("vibrancy");
    expect(titlebar).toContain('const titlebarHeight = "40px"');
  });

  it("does not invent window controls for other platforms", () => {
    expect(platformWindowChrome("win32")).toEqual({ titleBarStyle: "hidden" });
  });
});
