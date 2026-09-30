/**
 * Native window chrome per OS.
 *
 * macOS hides the title bar so Pace's 40px header can host the traffic lights.
 * Linux keeps the default decorated frame: the window manager draws the title
 * and min/max/close. Hiding the title bar there is frameless, and a client-side
 * caption overlay sits on top of Pace's own header.
 */
export type WindowChromeOptions = {
  frame?: boolean;
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
  transparent?: boolean;
  vibrancy?: "under-window";
  visualEffectState?: "followWindow";
  backgroundColor?: string;
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
    return { frame: true };
  }

  return { titleBarStyle: "hidden" };
}
