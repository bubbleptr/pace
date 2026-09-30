# Usage and token truth

Usage is the sidebar page that totals cost and tokens from Pi session logs. Per-session totals also show on the Trajectory Tally. The Live Chat composer shows context-window occupancy, which is not a dollar cost.

## Sub-features

- `usage-empty` shows the empty state when the isolated agent directory has no Pi session log.
- `usage-totals` shows Cost and Tokens KPIs when a log with usage exists.
- `trajectory-tally` shows cost, tokens, and run count on a session that has turns.
- `context-meter` shows context occupancy on the composer footer.

## How to get to it (user POV)

- Press Usage in the sidebar group "Trajectory and usage navigation". The hash route is `#/usage`. The page title is Usage.
- With no recorded sessions, the page says "No sessions recorded yet" and "Usage appears here once a Pi session has run. Start one from Trajectory."
- With sessions, a control labeled "Usage period" offers 7D, 30D, 90D, and All. KPI labels are Cost, Tokens, Sessions, and Avg cost / session. The chart's accessible name is "Daily cost". Refresh is the button "Refresh usage".
- Open a session that has turns in Trajectory. The Tally line in the cockpit header reads cost, tokens, and runs. The slot is `trajectory-tally` inside test id `session-detail-view`.
- In Live Chat, the composer footer ring is slot `context-usage-meter`. Its accessible name is "Context usage not reported yet", or `Context <percent>% · <window>` after the runtime reports occupancy.

## Driving it with Playwright

Preconditions:

- Doctor exits 0 and the in-drive doctor passes.
- Empty proof: `launchPace({ seedPreflightAuth: true })` with no Pi session log.
- Do not point `PI_CODING_AGENT_DIR` at `~/.pi/agent` to manufacture a non-zero total.

- **Open Usage.** Click button "Usage". Heading "Usage" is visible. The Usage button has `aria-current="page"`. URL matches `/#\/usage$/`.
- **Empty state.** Text "No sessions recorded yet" is visible. The "Usage period" control is absent. There is no Cost KPI yet. This proves the page, not a non-zero total.
- **Context meter on a draft.** Click "New Chat for E2E Project" only when a project was seeded. Otherwise stop at the empty Usage page. If the draft is open, slot `context-usage-meter` has accessible name "Context usage not reported yet".
- **Tally needs turns.** A projection with `sessionFileMissing`, or a Pi log that is only a session header, renders "No timeline entries found." and no `trajectory-tally`. Do not assert a dollar amount on that fixture.
- **Proof.** Screenshot the empty Usage page. `result.txt` says `usage`. The evidence states that the total is the empty state because the temp agent directory has no usage records.

## Gotchas

- Cost figures come from the Pi JSONL (`list_sessions`), not from the Pace projection file alone. Seeding a projection without a log does not fill the KPIs.
- Sub-cent costs render as `<$0.01` rather than `$0.00`. Assert the visible currency string.
- The weekday × hour grid uses the local clock. Do not assert a specific cell unless the fixture's timestamps were chosen for that timezone.
- The context meter turns warning above 70% and critical above 90%, matching Pi's footer. Those thresholds are not visible as text. The accessible name is the assertion.
- Tally is Analyze (Trajectory cockpit). It is not the Session dock and not the Usage page.
