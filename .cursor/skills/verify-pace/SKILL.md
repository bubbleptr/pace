---
name: verify-pace
description: "Drive Pace, the Electron desktop GUI for the Pi coding agent, through the repo's Playwright Electron harness (e2e/fixtures/electron-app.ts launchPace). Use to prove a user-facing Pace flow — preflight, Live Chat, Session dock, Packages, Usage — against an isolated window, not a unit test."
---

# Verify Pace

Pace is an Electron + React desktop app. Scripted verification launches the built main process with Playwright, the same way `e2e/smoke/` does. It does not attach to a `bun run dev` window and it does not touch `~/.pace` or `~/.pace-dev`.

Read `features/README.md` before driving. One feature file is the recipe. A proof that only opens the window is incomplete when the map names a feature.

## Launch

Human quickstart (hot reload, writes `~/.pace-dev` and a `Pace-dev` userData profile) is `bun install` then `bun run dev`. See README "Quick start" and `docs/dogfooding.md`. Do not use that process for a scripted proof.

Verification launch:

```bash
bun install
bun run build
node .cursor/skills/verify-pace/scripts/doctor.mjs
```

`bun run build` writes `apps/desktop/out/main/main.js`. `launchPace` in `e2e/fixtures/electron-app.ts` starts that file (or `PACE_E2E_EXECUTABLE` when set). There is no port to poll. The drive is ready when doctor prints `"ok": true` and, after `launchPace` returns, the first window title matches `/Pace/`.

Each drive is its own Electron process. `launchPace` creates `/tmp/pace-e2e-*` with `profile/`, `data/`, `agent/`, and `project/`, then sets:

- `PACE_DATA_DIR` to `data/` (overrides `~/.pace` and `~/.pace-dev`)
- `PI_CODING_AGENT_DIR` to `agent/` (does not read the operator's `~/.pi/agent`)
- `HOME` to the temp root
- `--user-data-dir` to `profile/`
- `PACE_E2E=1`

`PACE_E2E=1` hides the dock icon, sets window opacity to 0, and shows the window inactive. CDP screenshots still render. Do not decide readiness by looking for a visible window on the desktop.

Linux, matching `bun run test:e2e:linux`:

```bash
env -u WAYLAND_DISPLAY PACE_E2E_ELECTRON_ARGS=--ozone-platform=x11 \
  xvfb-run -a -s "-screen 0 1920x1080x24" \
  ./node_modules/.bin/playwright test --config .cursor/skills/verify-pace/drive/playwright.config.ts
```

`ELECTRON_OZONE_PLATFORM_HINT=x11` does not work. A tiling Wayland compositor overrides `setSize` after a few hundred milliseconds, so Session dock proofs on Linux run under Xvfb. macOS omits `xvfb-run` and the ozone switch. Packaged binaries are `dist/mac-arm64/Pace.app/Contents/MacOS/Pace` and `dist/linux-unpacked/pace`; pass them as `PACE_E2E_EXECUTABLE`. Official installers are Apple Silicon only.

Linux window blocker, confirmed against this repo's unpackaged build: `app.setName("Pace")` in `apps/desktop/electron/main.ts` runs before `createMainWindow()`. On Linux, Electron's `GetApplicationVersion` (`shell/common/application_info_linux.cc`) returns the Electron version only while the name is still `Electron`. After `setName`, with no `app.setVersion`, the version is the fallback string `0.0`. `electron-updater` throws `ERR_UPDATER_INVALID_VERSION` when `autoUpdater` is first read, still inside `whenReady`, so the BrowserWindow is never created and `launchPace` times out in `firstWindow`. A `.desktop` file does not provide that version. macOS does not use this fallback. Doctor reports it as a warning. Do not treat an Xvfb or sandbox retry as a fix.

Teardown of one drive is `testApp.close()` from the fixture, which closes Electron and deletes that temp root. See Cleanup before killing anything by hand.

## Doctor

Run this before the first drive and again after any launch that did not come up:

```bash
node .cursor/skills/verify-pace/scripts/doctor.mjs
```

Exit 0 and `"ok": true` means the checkout can launch: `package.json` name is `pace`, `apps/desktop/out/main/main.js` is non-empty, `node_modules/electron/dist/electron` exists, and Playwright is installed. On Linux, `DISPLAY` or `xvfb-run` must exist. The script does not start Electron.

After `launchPace` returns, and before any click, the spec must confirm the instance is the one just started:

- `app.process().spawnargs` contains `--user-data-dir=` whose path includes `${sep}pace-e2e-`
- unless `PACE_E2E_EXECUTABLE` is set, spawn args end with `apps/desktop/out/main/main.js`
- `window` title matches `/Pace/`
- the user-data dir is not `Pace` or `Pace-dev` under Application Support

If any of those fail, do not click. Close that app and clean up.

## Drive

Harness: a Playwright test that imports `launchPace` from `e2e/fixtures/electron-app.ts`. Prefer `getByRole` and `getByTestId` already used in `e2e/smoke/`. Electron uses hash history, so routes look like `#/preflight`, `#/`, `#/packages`, `#/usage`, `#/trajectory`.

Shared handles:

- Landing, preflight completed: button `Add Project`, test id `sidebar-projects`
- Project row action: button `New Chat for E2E Project` (exact), then combobox `Prompt`
- Seeded session row: button whose name starts with the projection `initialPrompt` (`E2E lifecycle session` unless `seedModelControls`)
- Dock toggle: button `Session dock` (exact). Open dock: complementary region named for the active surface (`Changes` by default), test id `session-dock`
- Page title in the chrome: heading level 1, test id `header-chrome-title`

Call `resizeWindow(1440, 900)` before any Session dock assertion. Below a wide layout the dock does not sit beside Chat; `e2e/README.md` records the 1280px constraint and the Wayland `setSize` failure.

`launchPace` options the smoke suite already uses:

- `requirePreflight: true` leaves the first-run gate up (no `preflight-status.json`)
- `seedPreflightAuth: true` writes a placeholder `auth.json` so Continue can enable
- `seedProject: true` registers "E2E Project"
- `seedSession: true` adds a completed projection titled `E2E lifecycle session`
- `seedGitChanges: true` makes a git checkout with a real diff for Changes

Do not call `__e2e_kill_backend` unless the recipe is the backend-restart smoke. That command exists only when `PACE_E2E=1`.

Do not send a prompt to a real model. The seeded key is the string `pace-e2e-placeholder`. Smoke tests never call an LLM (`e2e/README.md`). A send would talk to the network with that placeholder and is not a successful turn.

The UI Intent Picker (crosshair, `Cmd/Ctrl+Shift+X`) mounts only in `bun run dev` (`import.meta.env.DEV`). The built main the harness launches does not include it. Use the accessible names and test ids in the feature files. Picker output is documented in `docs/ui-intent-picker.md`; term bindings live in `apps/desktop/src/dev/ui-intent/regions.ts` and `CONTEXT.md`.

Do not debug `packages/backend/src/drivers/terminal.ts` under Bun. The Terminal surface smoke is still Playwright on Node, which is allowed.

Per-feature steps are in `features/`. The checked-in drive for Changes is:

```bash
.cursor/skills/verify-pace/scripts/drive-changes.sh
```

## Evidence

Set `PACE_VERIFY_EVIDENCE` to a directory outside the `pace-e2e-` temp root. The default used by `drive-changes.sh` is `.cursor/skills/verify-pace/runs/<UTC timestamp>/`, which is gitignored.

A proof captures the action and the resulting state:

- `doctor.json` from the pre-launch doctor
- `doctor-instance.txt` with the window title and the `--user-data-dir` path
- a full-window PNG (CDP; opacity 0 does not blank it)
- an ARIA snapshot of the surface just exercised
- a copy of the side effect (for Changes: the seeded `src/app.ts` body and `git diff`)
- `result.txt` naming the feature id

Exercise the real user path. Do not prove a panel by writing React state or by calling a test-only endpoint other than the launch fixture the smoke suite already uses. Mocks stop at the boundary the app already isolates: no live LLM call. When a drive uses the placeholder auth key, a provider error is not a successful send.

`PACE_E2E=1` changes window opacity and hides the dock icon. It does not skip preflight, git, or the projection store. Confirm visible text, not the flag name.

## Cleanup

Success path: the spec's `finally` calls `testApp.close()`, which closes that Electron and deletes its temp root.

If `firstWindow` times out, `launchPace` never returns, so `close()` never runs. Electron is gone and the `/tmp/pace-e2e-*` directory remains. Remove that directory (basename starts with `pace-e2e-`, parent is the OS temp dir). Do not delete other temp directories.

Crashed path, or any doubt:

```bash
node .cursor/skills/verify-pace/scripts/cleanup.mjs --evidence "$PACE_VERIFY_EVIDENCE"
```

Cleanup reads `instance.json` in the evidence directory. It sends `SIGTERM` only when `/proc/<pid>/cmdline` (or `ps` off Linux) contains the recorded `--user-data-dir` and that path contains `pace-e2e-`. It deletes `testRoot` only when the path is under the OS temp dir and the basename starts with `pace-e2e-`. It never deletes the evidence directory. It never kills by process name.

After cleanup, the evidence files must still be at the path in `instance.json` / `PACE_VERIFY_EVIDENCE`, and the `pace-e2e-` directory must be gone.

## Helpers

- `node .cursor/skills/verify-pace/scripts/doctor.mjs` — read-only pre-launch check. Exit 0 when `"ok": true`.
- `node .cursor/skills/verify-pace/scripts/cleanup.mjs --evidence <dir>` — kill the recorded Electron, if it is still ours, and delete its temp root. Leaves `<dir>`.
- `.cursor/skills/verify-pace/scripts/drive-changes.sh` — doctor, launch under Xvfb on Linux, drive Session dock Changes, write evidence, clean up, then check the PNG and checkout copy still exist. Feature id `session-dock-changes`.

When Pace's UI changes, run `/maintain-verification-skill` against `.cursor/skills/verify-pace/`. Generation proved `session-dock-changes` only. The other feature files are source-backed recipes, not yet driven in this run.
