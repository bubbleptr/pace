# Session dock Changes

Changes is the Session dock surface that stacks the git diff of the session checkout. The user opens the dock from Live Chat and reads every changed file without a separate click per file.

## Sub-features

- `dock-open` opens the dock beside Chat on a wide window. The default surface is Changes.
- `diff-stacked` shows every changed file's diff at once.
- `files-switch` switches the same dock to Files. Files is a second surface, not a second proof.

## How to get to it (user POV)

- Open a project session whose checkout is a git repo with uncommitted edits.
- Press the Session dock button in the session toolbar.
- The right-hand panel is labeled Changes. A count such as "2 files" sits in the surface bar. Each file is a section. The outline is the navigation named "Changed files".
- Drag the separator "Resize Session dock" to give the diff room. Collapse all and Expand all are on that bar.
- Press Files on the same bar to browse the checkout tree instead of the diff.

## Driving it with Playwright

Preconditions:

- Doctor exits 0 and the in-drive doctor passes.
- `git` is on PATH. The fixture runs `git init` and a commit inside the temp project.
- `launchPace({ seedGitChanges: true, seedPreflightAuth: true })`.
- `resizeWindow(1440, 900)` before opening the dock.
- Seeded files, after the fixture's commit: `src/app.ts` contains `export const state = "after";` and untracked `src/new-feature.ts` contains `export const enabled = true;`.

- **Reach the session.** Click button "New Chat for E2E Project" (exact). Combobox "Prompt" is visible. Click the button whose name matches `/^E2E lifecycle session/i`. Button "Session dock" (exact) is visible.
- **Open Changes.** Click "Session dock". Test id `session-dock` is visible and its accessible name is "Changes" (complementary role). Text "2 files" is visible. Test id `session-change-section` has count 2.
- **Read the diff.** The dock shows `export const state = "after";` and `export const enabled = true;` as exact text. Navigation "Changed files" is visible. Separator "Resize Session dock" has a bounding box.
- **Side effect.** Before `close()`, copy `src/app.ts` from `testApp.project.path` and `git diff -- src/app.ts` into the evidence directory. The copy contains `export const state = "after";`.
- **Proof.** Save a full-window screenshot and `dock.ariaSnapshot()` under `PACE_VERIFY_EVIDENCE`. `result.txt` says `session-dock-changes`. Run cleanup. The screenshot, ARIA snapshot, and `src/app.ts` copy are still there. The `pace-e2e-` temp root is gone.

`scripts/drive-changes.sh` is this recipe.

## Gotchas

- On Linux, run under Xvfb with `--ozone-platform=x11`. A tiling compositor puts the window back under 1280px and the dock does not stay beside Chat. `resizeWindow` waits until `innerWidth` is within 32px of the request.
- Narrow widths truncate file-name headers to zero width. Assert the exact diff line, or `getByText("src/app.ts").filter({ visible: true })`, not a zero-width header.
- Changes reads the checkout from disk. Appending lines after launch is visible only after the panel refreshes; the seeded diff is already on disk before launch, which is what this recipe uses.
- `testApp.close()` deletes the checkout. Copy the file into the evidence directory first.
- Do not drive this surface with `bun run dev:mock`. The mock is a static gallery. This proof uses the real backend and the seeded git repo.
