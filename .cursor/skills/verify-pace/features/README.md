# Pace verification map

This directory is the maintained source for verifying Pace's user-facing behavior. Read this index, then drive one feature file. The harness is Playwright launching Electron through `launchPace` in `e2e/fixtures/electron-app.ts`.

## Baseline preconditions

- Doctor exits 0: `node .cursor/skills/verify-pace/scripts/doctor.mjs`.
- The build artifact is `apps/desktop/out/main/main.js`. Do not drive `bun run dev`.
- Every drive calls `launchPace`, which uses a fresh `/tmp/pace-e2e-*` data directory, Pi agent directory, and `--user-data-dir`. Never point `PACE_DATA_DIR` at `~/.pace` or `~/.pace-dev`.
- On Linux, run under Xvfb with `PACE_E2E_ELECTRON_ARGS=--ozone-platform=x11` and `WAYLAND_DISPLAY` unset. See `e2e/README.md`. That display setup is not sufficient today: after `app.setName("Pace")`, Linux `app.getVersion()` is `0.0`, electron-updater throws before the window exists, and `firstWindow` times out. See the Launch section of `../SKILL.md`.
- Resize to 1440×900 before Session dock assertions.
- Do not send a prompt to a model. Seeded auth is the placeholder `pace-e2e-placeholder`.
- Evidence goes to `PACE_VERIFY_EVIDENCE`, outside the temp root. Cleanup must leave it in place.

## Driving conventions

- Start from the `launchPace` options named in the feature file.
- Prefer `getByRole` and `getByTestId` over CSS and coordinates.
- Hash routes: `#/preflight`, `#/`, `#/trajectory`, `#/usage`, `#/packages`. `/trace` redirects to `/trajectory`. `/setup` redirects to `/packages`.
- The built app does not mount the dev-only UI Intent Picker. Selectors in these files are the handles to use.
- Record the feature id with the evidence. A skipped entry point is not verified by a different one.

## Proof and skip reporting

- Capture the user action and the resulting state, plus a side effect that is not only pixels (projection file, git diff, preflight completion file) when the feature writes one.
- Name the feature id in `result.txt`.
- If a path cannot be reached, record the command and the missing precondition (display, build, auth, OS). Do not mark it verified.

## Feature entry contract

Each feature file has an H1, one opening paragraph, then these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, `Gotchas`.

## Features

- [First launch and open a session](./first-launch.md) — preflight gate, Continue, project draft.
- [Live Chat and Trajectory](./live-chat.md) — open a seeded session, read Live Chat, open Trajectory. No model send.
- [Session dock Changes](./session-dock-changes.md) — docked diff of a seeded git checkout. This is the drive `scripts/drive-changes.sh` runs.
- [Packages](./packages.md) — sidebar Packages page and the installed-toolkit empty state.
- [Usage and token truth](./usage.md) — Usage page, Trajectory Tally, composer context meter.
