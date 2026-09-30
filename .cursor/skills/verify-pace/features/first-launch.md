# First launch and open a session

First launch checks the bundled Pi runtime, the Pace data directory, model auth, and Git, then lets the user into the main shell to add a project and open an empty Session draft.

## Sub-features

- `preflight-cold` shows the gate with no project sidebar.
- `preflight-continue` enables Continue when required checks pass and lands on Add Project.
- `preflight-auth-blocked` keeps Continue disabled when model auth is missing.
- `open-draft` opens an empty Session draft for a registered project.

## How to get to it (user POV)

- Launch Pace with no completed preflight. The window shows the heading "Before your first session" and the hash route `#/preflight`.
- Press Continue after Pi Runtime, Data directory, and Model auth pass. Git is optional.
- From the main shell, press Add Project, or press "New Chat for <project>" on a project that is already registered.
- The draft shows a Prompt field for that project.

## Driving it with Playwright

Preconditions:

- `node .cursor/skills/verify-pace/scripts/doctor.mjs` exits 0.
- Cold gate: `launchPace({ requirePreflight: true })`.
- Continue path: `launchPace({ requirePreflight: true, seedPreflightAuth: true })`.
- Auth blocked: `launchPace({ requirePreflight: true, seedPreflightAuth: false })`.
- Draft path: `launchPace({ seedProject: true, seedPreflightAuth: true })`, which writes `preflight-status.json` so the gate is skipped.
- In-drive doctor passes: spawn args contain a `pace-e2e-` user-data dir, title matches `/Pace/`.

- **Cold gate.** Launch with `requirePreflight: true`. Expect heading "Before your first session", URL `/#\/preflight$/`, test id `app-frame-titlebar-only`, and zero `sidebar-projects`. Rows titled "Pi Runtime", "Data directory", "Model auth", and "Git" are visible. The Data directory detail text includes `pace-e2e-`.
- **Open provider settings from the gate.** Click button `/Configure providers/i`. A dialog named "Settings" appears. Press Escape. The heading "Before your first session" is still visible and the URL is still `#/preflight`.
- **Continue.** On the auth-seeded gate, wait until button "Continue →" is enabled and the text "Bundled Pi engine available" is visible. Click "Continue →". Button "Add Project" and test id `sidebar-projects` become visible. The heading "Before your first session" is gone. `preflight-status.json` exists under the disposable `PACE_DATA_DIR` with a `completedAt` field. Copy that file into the evidence directory before `close()`.
- **Auth blocks Continue.** Without `seedPreflightAuth`, the text `/No provider credentials/i` is visible and the Continue button is disabled.
- **Open a draft.** With `seedProject: true`, click button "New Chat for E2E Project" (exact). Combobox "Prompt" is visible, and the text "E2E Project" is visible. Test id `project-row-with-actions` contains a button "No chats".
- **Proof.** Screenshot the draft. `result.txt` says `first-launch`. The copied `preflight-status.json` still exists after cleanup.

## Gotchas

- Default `launchPace()` writes `preflight-status.json` and skips the gate. `requirePreflight: true` is what shows it.
- Continue stays disabled until model auth passes. The placeholder key is not a real provider login. Do not click Send on the draft.
- Git missing does not block Continue (`forceGitMissing: true` in the fixture). The row says the Changes surface is limited.
- The gate uses test id `app-frame-titlebar-only`. After Continue, `sidebar-projects` is back. Do not look for a sidebar on the gate.
- Two Electrons cannot share one user-data dir. The second exits. Always use the fixture's `--user-data-dir`.
