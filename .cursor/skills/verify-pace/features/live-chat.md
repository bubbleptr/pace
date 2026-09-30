# Live Chat and Trajectory

Live Chat is where a user reads a session and composes the next message. Trajectory is the separate Analyze view of that session's turns, tools, tokens, and cost.

## Sub-features

- `open-seeded-session` opens a persisted session from the project sidebar into Live Chat.
- `draft-composer` shows the Prompt field before a session exists.
- `open-trajectory` switches to the Trajectory page from the sidebar.
- `live-send` is not part of the default proof. Smoke tests do not call an LLM.

## How to get to it (user POV)

- With preflight already completed and a project registered, press "New Chat for <project>" in the project row.
- Press the session row in the sidebar. The row's accessible name starts with the session title.
- Read the thread under the session heading. The composer sits at the bottom of Live Chat.
- Press Trajectory in the sidebar group "Trajectory and usage navigation". Pick a session in the list to open its cockpit. The hash route is `#/trajectory` or `#/sessions/<sessionId>`. `#/trace` redirects to `#/trajectory`.

## Driving it with Playwright

Preconditions:

- Doctor exits 0 and the in-drive doctor passes.
- `launchPace({ seedSession: true, seedPreflightAuth: true })`.
- The seeded title is `E2E lifecycle session`. The projection sets `sessionFileMissing`, so there is no Pi JSONL transcript and no token total.
- Resize with `resizeWindow(1440, 900)` before asserting the dock toggle.

- **Open the draft.** Click button "New Chat for E2E Project" (exact). Combobox "Prompt" is visible.
- **Open the session.** Click the button whose name matches `/^E2E lifecycle session/i`. Heading "E2E lifecycle session" is visible. Button "Session dock" (exact) is visible. Test id `live-session-column` is visible.
- **Composer is present and idle.** Test id `full-chat-composer` is visible. Do not click Send. The footer ring `[data-slot="context-usage-meter"]` has accessible name "Context usage not reported yet" until a runtime reports occupancy.
- **Open Trajectory.** Click button "Trajectory" in the group "Trajectory and usage navigation". Heading "Trajectory" is visible. With only the missing-file projection, the reading pane shows "Select a session" or "No timeline entries found." It does not show a Tally line. That empty state is the proof for this fixture, not a failed load.
- **Proof.** Screenshot Live Chat before leaving it, and screenshot Trajectory after the click. `result.txt` says `live-chat`. Do not claim a turn was sent.

## Gotchas

- The sidebar session button's name starts with the title. The menu beside it is "Session actions for <title>". Anchor the row at the start of the name so the menu is not the match.
- Trajectory reads the Pi session log, not the Pace projection. `sessionFileMissing` sessions show in the project sidebar and do not produce a cockpit Tally.
- Button "Send" submits the composer. While a run is active the placeholder is "Queue the next task…" and Stop is available. The default proof never reaches that state.
- `docs/dogfooding.md`: opening history does not start the agent. The first Send is what restores the runtime. An error stays on the composer and the draft is kept. A placeholder key will not produce an assistant message.
- Do not point `PI_CODING_AGENT_DIR` at the operator's `~/.pi/agent` to borrow a real transcript.
