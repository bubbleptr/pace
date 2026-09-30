/**
 * Native window chrome per OS.
 *
 * `titleBarStyle: "hidden"` keeps Pace's own 40px titlebar. On macOS that
 * still draws traffic lights. On Linux, hidden without `titleBarOverlay` is
 * frameless: no minimize, maximize, or close. The overlay puts those controls
 * on the right, over the custom titlebar, instead of adding a second frame.
 *
 * `height` matches `titlebarHeight` in the renderer (`40px`).
 */
export type WindowChromeOptions = {
  titleBarStyle: "hidden";
  trafficLightPosition?: { x: number; y: number };
  transparent?: boolean;
  vibrancy?: "under-window";
  visualEffectState?: "followWindow";
  backgroundColor?: string;
  titleBarOverlay?: { height: number };
};

export function platformWindowChrome(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 13 },
      // Transparent web contents are required for vibrancy to show through
      // CSS; `sidebar` material is too dense to read as glass.
      transparent: true,
      vibrancy: "under-window",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
    };
  }

  if (platform === "linux") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 40 },
    };
  }

  return { titleBarStyle: "hidden" };
}
