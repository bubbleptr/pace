import { describe, expect, it } from "vitest";
import {
  hostWindowChrome,
  linuxToggleSafeLeft,
  macChromeSafeLeft,
  revealInFileManagerLabel,
  revealedInFileManagerMessage,
} from "./host-chrome";

describe("host window chrome", () => {
  it("reserves the macOS traffic-light gutter only on darwin", () => {
    expect(hostWindowChrome("darwin")).toMatchObject({
      reserveMacTrafficLights: true,
      safeLeft: macChromeSafeLeft,
      safeRight: "0px",
      trafficWidth: "88px",
    });
    expect(macChromeSafeLeft).toBe("132px");
  });

  it("leaves Linux under a normal frame: no mac gutter and no caption spacer", () => {
    expect(hostWindowChrome("linux", { showSidebarToggle: true })).toEqual({
      platform: "linux",
      reserveMacTrafficLights: false,
      safeLeft: linuxToggleSafeLeft,
      safeRight: "0px",
      trafficWidth: "0px",
    });
    expect(linuxToggleSafeLeft).not.toBe(macChromeSafeLeft);
    expect(hostWindowChrome("linux", { showSidebarToggle: false }).safeLeft).toBe("0px");
    expect(hostWindowChrome("linux").safeRight).toBe("0px");
  });

  it("names the file manager for the host", () => {
    expect(revealInFileManagerLabel("darwin")).toBe("Reveal in Finder");
    expect(revealedInFileManagerMessage("darwin")).toBe("Revealed in Finder");
    expect(revealInFileManagerLabel("linux")).toBe("Show in Files");
    expect(revealedInFileManagerMessage("linux")).toBe("Shown in Files");
    expect(revealInFileManagerLabel("other")).toBe("Show in folder");
  });
});
