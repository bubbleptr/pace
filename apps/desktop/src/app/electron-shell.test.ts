import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Electron shell", () => {
  it("keeps main thin and runs backend work in a utility process", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("utilityProcess.fork");
    expect(main).toContain("MessageChannelMain");
    expect(main).toContain("ipcMain.handle");
    expect(main).toContain('"pigui:invoke"');
    expect(main).not.toContain('"pig:invoke"');
    expect(main).not.toContain('"pig:backend-event"');
    expect(main).not.toContain('"pig:window-focus"');
    expect(main).not.toContain("createBackendService");
    expect(main).not.toContain("buildSessionIndex");
    expect(main).not.toContain("spawn(");
  });

  it("uses secure BrowserWindow defaults for the renderer", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain('titleBarStyle: "hidden"');
    expect(main).toContain("trafficLightPosition: { x: 16, y: 13 }");
    expect(main).toContain("transparent: true");
    expect(main).toContain('vibrancy: "under-window"');
    expect(main).toContain('backgroundColor: "#00000000"');
    expect(main).toContain('process.platform === "darwin"');
  });

  it("marks the document for sidebar vibrancy only on macOS", () => {
    const preload = readProjectFile("apps/desktop/electron/preload.ts");

    expect(preload).toContain('process.platform === "darwin"');
    expect(preload).toContain('data-pigui-vibrancy');
  });

  it("sets the Pace Dock icon during electron-vite dev", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("applyDevelopmentDockIcon");
    expect(main).toContain("app.dock.setIcon");
    expect(main).toContain("ELECTRON_RENDERER_URL");
    expect(main).toContain("build/icon-512.png");
  });

  it("uses hash history for the packaged Electron file URL", () => {
    const renderer = readProjectFile("apps/desktop/src/app/main.tsx");

    expect(renderer).toContain("createHashHistory");
    expect(renderer).toContain("isElectronRuntime()");
  });

  // bun nests a second `react` under @astryxdesign/core. Vite then prebundles
  // Astryx CodeBlock's `useTranslator` against that copy while the renderer
  // uses the workspace copy — React 19 throws `reading 'use'` on /design.
  it("pins the renderer to a single React copy", () => {
    const config = readProjectFile("apps/desktop/electron.vite.config.ts");

    expect(config).toContain('dedupe: ["react", "react-dom"]');
    expect(config).toMatch(/react:\s*reactPackage/);
    expect(config).toMatch(/"react-dom":\s*reactDomPackage/);
  });

  it("exposes only a typed Pace API from preload", () => {
    const preload = readProjectFile("apps/desktop/electron/preload.ts");

    expect(preload).toContain('contextBridge.exposeInMainWorld("pace"');
    expect(preload).toContain('ipcRenderer.invoke("pigui:invoke"');
    expect(preload).toContain('ipcRenderer.on("pigui:backend-event"');
    expect(preload).toContain('ipcRenderer.on("pigui:window-focus"');
    expect(preload).not.toContain('contextBridge.exposeInMainWorld("pigui",');
    expect(preload).not.toContain('contextBridge.exposeInMainWorld("pig",');
    expect(preload).not.toContain('ipcRenderer.invoke("pig:invoke"');
    expect(preload).not.toContain('ipcRenderer.on("pig:backend-event"');
    expect(preload).not.toContain('ipcRenderer.on("pig:window-focus"');
    expect(preload).not.toContain("window.ipcRenderer");
  });

  it("opens a native directory picker for manual Project selection", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("dialog.showOpenDialog");
    expect(main).toContain('input.command === "select_project_directory"');
    expect(main).toContain('title: "Select Project"');
    expect(main).toContain('properties: ["openDirectory"]');
  });

  it("reveals Projects in Finder through the main process", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("shell.showItemInFolder");
    expect(main).toContain('input.command === "reveal_project_in_finder"');
  });

  it("hosts the backend service inside the utility process entrypoint", () => {
    const backend = readProjectFile("apps/desktop/electron/backend.ts");

    expect(backend).toContain("createBackendService");
    expect(backend).toContain('import type { MessagePortMain } from "electron"');
    expect(backend).toContain("const { parentPort } = process");
    expect(backend).toContain("parentPort");
    expect(backend).toContain('event.data?.type === "connect"');
    expect(backend).not.toMatch(/^import (?!type\b).*from ["']electron["'];/m);
  });

  it("rejects renderer invokes after the backend utility process exits", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("backendPort = null");
    expect(main).toContain("backendPort?.close()");
    expect(main).toContain("Pace backend utility process is not connected.");
  });

  it("restarts the backend utility process and reports lifecycle state", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain("scheduleBackendRestart");
    expect(main).toContain("backendRestartBaseDelayMs");
    expect(main).toContain('lifecycle: "connected"');
    expect(main).toContain('lifecycle: "disconnected"');
    expect(main).toContain('app.on("before-quit"');
    expect(main).toContain("backendProcess?.kill()");
  });

  it("gates backend process control behind the explicit E2E environment", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");

    expect(main).toContain('const e2eKillBackendCommand = "__e2e_kill_backend"');
    expect(main).toContain('process.env.PACE_E2E !== "1"');
    expect(main).toContain("killBackendForEndToEndTest");
  });

  it("sets the package version on Linux before electron-updater reads it", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");
    const setName = main.indexOf('app.setName("Pace")');
    const setVersion = main.indexOf(".setVersion(__PACE_APP_VERSION__)");
    const readUpdater = main.indexOf("autoUpdater: autoUpdater");

    expect(setName).toBeGreaterThan(-1);
    expect(setVersion).toBeGreaterThan(setName);
    expect(readUpdater).toBeGreaterThan(setVersion);
    expect(main).toContain('process.platform === "linux"');
  });

  it("navigates the renderer through pigui:navigate instead of executeJavaScript", () => {
    const main = readProjectFile("apps/desktop/electron/main.ts");
    const navigation = readProjectFile("apps/desktop/electron/app-navigation.ts");
    const protocol = readProjectFile("apps/desktop/src/shared/navigate-protocol.ts");

    expect(main).not.toContain("executeJavaScript");
    expect(`${main}\n${navigation}\n${protocol}`).toContain("pigui:navigate");
  });
});
