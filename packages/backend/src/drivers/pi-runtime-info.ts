import { homedir } from "node:os";
import { join } from "node:path";

declare const __PACE_APP_VERSION__: string;
declare const __PACE_PI_VERSION__: string;

export type PiRuntimeInfo = {
  appVersion: string;
  piVersion: string;
  mode: "SDK";
};

export async function inspectPiRuntime(): Promise<PiRuntimeInfo> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  if (typeof sdk.createAgentSession !== "function" || typeof sdk.SessionManager?.create !== "function") {
    throw new Error("The bundled Pi SDK is missing its session APIs.");
  }

  // Bundling relocates Pi's package lookup to the App package.json. Capture
  // the installed engine version at build time instead of reporting App's version as Pi's.
  const piVersion = typeof __PACE_PI_VERSION__ === "string" ? __PACE_PI_VERSION__ : sdk.VERSION;
  if (!piVersion) {
    throw new Error("The bundled Pi SDK version could not be determined.");
  }
  return {
    appVersion: typeof __PACE_APP_VERSION__ === "string" ? __PACE_APP_VERSION__ : "development",
    piVersion,
    mode: "SDK",
  };
}

export type RuntimeInfo = PiRuntimeInfo & {
  platform: NodeJS.Platform;
  arch: string;
  // Null outside Electron (vitest, one-off Node scripts).
  electronVersion: string | null;
  // A boolean, not the path: bug-report diagnostics must not carry user paths.
  isDevDataDir: boolean;
};

// What the About page copies into bug reports. Host facts are read here in the
// utilityProcess so the renderer needs no second IPC channel for them.
export async function inspectRuntime(input: { dataDir: string }): Promise<RuntimeInfo> {
  return {
    ...(await inspectPiRuntime()),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron ?? null,
    isDevDataDir: input.dataDir === join(homedir(), ".pace-dev"),
  };
}
