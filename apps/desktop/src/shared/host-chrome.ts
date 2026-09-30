/**
 * Renderer-side insets for the native window chrome.
 *
 * Electron preload sets `data-pigui-platform` before the page scripts run.
 * Missing or unknown platforms get no macOS traffic-light gutter: the browser
 * mock has no traffic lights, and a Linux window must not reserve an empty
 * left strip.
 */

export const macChromeSafeLeft = "132px";
export const macTrafficWidth = "88px";
/**
 * The sidebar toggle is 28px. This slot keeps the title clear of that button
 * when the sidebar is collapsed. It is not the macOS traffic-light gutter.
 * Linux does not reserve caption space: the window manager draws those
 * controls in its own title bar, above this header.
 */
export const linuxToggleSafeLeft = "40px";

export type HostPlatform = "darwin" | "linux" | "other";

export type HostChrome = {
  platform: HostPlatform;
  reserveMacTrafficLights: boolean;
  safeLeft: string;
  safeRight: string;
  trafficWidth: string;
};

export function readHostPlatform(platform?: string): HostPlatform {
  const value =
    platform ??
    (typeof document === "undefined" ? undefined : document.documentElement?.dataset.piguiPlatform);

  if (value === "darwin" || value === "linux") {
    return value;
  }

  return "other";
}

export function hostWindowChrome(
  platform: HostPlatform = readHostPlatform(),
  options: { showSidebarToggle?: boolean } = {},
): HostChrome {
  if (platform === "darwin") {
    return {
      platform,
      reserveMacTrafficLights: true,
      safeLeft: macChromeSafeLeft,
      safeRight: "0px",
      trafficWidth: macTrafficWidth,
    };
  }

  return {
    platform,
    reserveMacTrafficLights: false,
    safeLeft: options.showSidebarToggle ? linuxToggleSafeLeft : "0px",
    safeRight: "0px",
    trafficWidth: "0px",
  };
}

export function revealInFileManagerLabel(platform: HostPlatform = readHostPlatform()): string {
  if (platform === "linux") {
    return "Show in Files";
  }

  if (platform === "darwin") {
    return "Reveal in Finder";
  }

  return "Show in folder";
}

export function revealedInFileManagerMessage(platform: HostPlatform = readHostPlatform()): string {
  if (platform === "linux") {
    return "Shown in Files";
  }

  if (platform === "darwin") {
    return "Revealed in Finder";
  }

  return "Shown in folder";
}
