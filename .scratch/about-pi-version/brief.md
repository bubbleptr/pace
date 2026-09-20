# Task brief: show the bundled Pi SDK version on the About page

Repo: /Users/void/code/opensource/PiGUI  Branch: `feat/about-pi-version` (checked out, based on origin/main). Do NOT commit.

## Background
Settings → "About & Updates" (`apps/desktop/src/pages/settings.tsx`, `AboutUpdatesSection`, ~line 433) shows only the Pace version from `useUpdateStatus()`. The backend already knows the bundled Pi SDK version: `packages/backend/src/drivers/pi-runtime-info.ts` exports `inspectPiRuntime(): Promise<PiRuntimeInfo>` (`{ appVersion, piVersion, mode }`), but it is only consumed inside `environment-preflight.ts` and folded into a detail string. Bug reports need the Pi version because most engine behaviour changes ship in Pi, not in Pace.

## Goal
Under the `Version x.y.z` line in the About section, render a second supporting line `Pi SDK 0.86.0` (value from the backend). While loading, render nothing for that line; on failure, render nothing (do not block the section).

## Design (decided)
- Add a backend request `get_runtime_info` that returns `PiRuntimeInfo` by calling `inspectPiRuntime`. Register it exactly the way `get_chat_workspace_root` is registered end to end (backend service dispatch in `packages/backend/src/service.ts`, the shared request contract in `packages/core` if one exists, `apps/desktop/src/shared/runtime.ts` switch, any preload/IPC allowlist). Mirror that method; add nothing else.
- In `AboutUpdatesSection`, fetch it with `useQuery` (same pattern as `ChatsSettingsSection` → `invoke<...>("get_chat_workspace_root")`) and render `<Text as="p" type="supporting">Pi SDK {piVersion}</Text>`.
- No new shared/ui component, no Design page change.

## Tests (behavior only)
- `apps/desktop/src/pages/settings.test.tsx`: the About section shows `Pi SDK <version>` once the request resolves. Mirror how that file mocks `invoke` for other sections.
- Backend: one test that `get_runtime_info` dispatch returns the inspected runtime, only if the service tests already cover sibling methods in a way that is cheap to mirror; otherwise state the exemption (trivial wiring).

## Verification (paste real output)
bun run typecheck && bun run test

## Out of scope
A "Copy diagnostics" button (tracked separately). Changing preflight. Anything in electron.vite.config.ts.
