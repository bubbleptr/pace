# Brief: Spike 3 — presentation facet in the renderer, backend as a relay, hot reload

Working directory (git worktree, branch `chore/chord-plugin-gui-spike`): `/Users/void/code/opensource/PiGUI-chord-spike`
Do NOT touch `/Users/void/code/opensource/PiGUI` (primary checkout on `main`).

## Background (read first, in this order)

1. `.scratch/chord-plugin-gui/SPIKE.md` — spikes 1 and 2 (what is proven so far).
2. `docs/adr/0042-pace-as-chord-presentation-host.md` — open question 1 ("renderer 侧如何加载 facet 代码") is what this spike attacks.
3. `packages/backend/src/drivers/chord-plugin-spike.ts` — the existing adapters: `serveChordFacetHost`, `createChordPortTransport`, `createChordPortServiceSource`, `createJsonMessagePortPair`, `createChildProcessChordPort`, `createParentProcessChordPort`, and the `JsonMessagePort` / `ChordWireMessage` types. Reuse them; extend only where needed.
4. `packages/backend/src/drivers/chord-plugin-spike-demo.ts` (shared token + session facet), `chord-plugin-spike.test.ts`, `chord-plugin-spike-process.test.ts`, `fixtures/chord-session-process.mjs`.
5. chord runtime is `@earendil-works/chord` 0.86.0 (installed at `node_modules/.bun/@earendil-works+chord@0.86.0/node_modules/@earendil-works/chord`). Read `dist/types.d.ts` for `FacetHost.reload(facets)`; README.md in that package for replicated-state semantics ("Replicas become unready on disconnect or replacement until they are rehydrated").

Pace's real process topology, which this spike must mirror:

```
Session child process (fork, Node IPC)  <->  backend utilityProcess  <->  renderer (Chromium, Electron MessagePort / structured clone)
```

Today the backend↔renderer channel is a `MessageChannelMain` port (see `apps/desktop/electron/main.ts` ~line 218) — structured-clone semantics, async delivery. Node's global `MessageChannel` has the same semantics and is what the tests should use for that hop.

Vitest config: root `vite.config.ts`, default environment is **jsdom** for every test file. `bun run test` = `vitest run`. Run single files with `bunx vitest run <path>`. Do not use `bun test`.

## Goal

Answer three questions with runnable vitest tests plus a written report. All new code lives next to the existing spike files under `packages/backend/src/drivers/` and is exploratory (not wired into any driver).

### Q1. Can the chord runtime run inside the renderer (browser environment)?

- Add a test that bundles the chord root entry (`@earendil-works/chord` and `@earendil-works/chord/context`) with esbuild, `platform: "browser"`, `bundle: true`, `format: "esm"`, `write: false`, no externals. If chord's runtime entry reaches any `node:` module the build fails — that failure is the finding, not something to work around. Assert the build succeeds and the output text contains no `node:` specifier. esbuild 0.28.2 is already in the Bun store (chord's own dependency); add `"esbuild": "0.28.2"` as a root `devDependencies` entry and run `bun install` so it resolves. Do not add any other dependency.
- Also assert, in the same test or a sibling, that `createFacetHost` + `defineFacet` work under the jsdom environment (they will, since the spike tests already run under jsdom — make the assertion explicit by checking `typeof window !== "undefined"` inside the test so the report can say "verified under jsdom").

### Q2. Three-hop relay: session facet in a forked child, backend as a pure frame relay, presentation host in the "renderer"

- New test file `chord-plugin-spike-relay.test.ts`. Reuse `fixtures/chord-session-process.mjs` unchanged (it already runs the demo session facet + the real `serveSessionProcess` and sends `spike_ready`).
- Backend role: a small `relayChordFrames(childPort: JsonMessagePort, rendererPort: JsonMessagePort): () => void` in `chord-plugin-spike.ts` that forwards every `chord_*` frame from the child to the renderer port and vice-versa **without parsing `call` / `update` payloads** (it may only look at `kind`). The point to prove: the backend does not need to host chord or understand the wire grammar to serve plugin panels; it is a pipe.
- Renderer role: a `JsonMessagePort` over one side of a Node `MessageChannel` (`port.postMessage` / `port.on("message")`; remember `port.unref()` or `close()` so the test process exits). Add `createMessagePortChordPort(port: MessagePort): JsonMessagePort` for that. The presentation `FacetHost` (with `createChordPortTransport` + `createChordPortServiceSource`) runs on that port, in the jsdom test environment.
- Assertions, same shape as spike 2: hydrate before activation (`progress.value` is `{ step: 0, label: "idle" }`), `advance({ by: 2 })` returns `{ step: 2 }`, replica and subscriber see `[0, 2, 5]`, and a driver `createSession` request sent on the child IPC in parallel still gets its reply. Additionally assert the relay never emitted anything but `chord_call` / `chord_result` / `chord_update` toward the renderer (tap the renderer port).
- Teardown order (learned in spike 2): dispose presentation host, transport, relay, then send `{ id: 99, method: "dispose", args: [] }` to the child. Reuse the `waitForSpikeReady` / `waitForDriverResult` / `disposeChild` helpers from `chord-plugin-spike-process.test.ts` — move them into a small shared test helper module (`chord-plugin-spike-test-helpers.ts`) rather than duplicating.

### Q3. Hot reload semantics on both sides

Use the in-memory harness from `chord-plugin-spike.test.ts` (fast, deterministic). Add tests in a new file `chord-plugin-spike-reload.test.ts`:

- **Presentation-side reload.** Presentation facet v1 subscribes to `progress` via `env.own(panel.progress.subscribe(...))` and records values into `renderedV1`. Call `presentationHost.reload([presentationFacetV2])` where v2 has the same `id` and records into `renderedV2`. Then `advance({ by: 1 })` from v2. Assert: v1 receives no further values after reload; v2 has the current value immediately after reload (hydrated, no re-catalogue needed if chord keeps the remote binding — observe and report either way); v2 receives the post-reload delta. Also tap the wire and report whether reload caused an `unsubscribe` + new `subscribe` round trip or reused the existing subscription — that is a finding for the report, not a required assertion.
- **Session-side reload.** With presentation subscribed, call `sessionHost.reload([sessionFacetV2])` where v2 has the same facet id and provides the same service but initial state `{ step: 100, label: "reloaded" }`. Observe and assert what the presentation replica sees: does `progress.value` become the new snapshot? Does the subscriber callback fire? Is there any window where `progress.value` is `undefined` / unready? Chord's README says replicas go unready on provider replacement until rehydrated — measure it via the subscriber sequence and via polling `progress.value`. Write the assertions to match observed behavior after you have confirmed the behavior is deterministic across 3 runs; describe the behavior precisely in the report.
- If `reload()` throws or misbehaves for the remote-provided service case, that is a finding: capture the error text in the report and keep a test that documents the current behavior with `expect(...).rejects` or similar.

## Report (write this file; it is a deliverable)

Append a section `## 8. Spike 3（2026-09-22）：renderer 侧 presentation host、backend 只做转发、热重载` to `.scratch/chord-plugin-gui/SPIKE.md`, in Chinese, same style as §7: what was built (file names), exact results per question with the numbers you observed (test durations, message counts), and anything that surprised you. Keep it factual, no recommendations beyond one short "接入生产前必须处理" list if something came up.

Also add one bullet under the "上游依赖" open question in ADR-0042 (do not restructure the ADR): chord 0.87.0 (Pi upstream, 2026-09-21, commit `10d1ad621` "feat: add transactional replicated state") replaced `MutableReplicatedState.state` + `publish(ctx)` with `change(ctx, draft => …)` + `replace(ctx, value)`; the wire API (`createRemoteServiceEndpoint`, state codecs, `createRemoteServiceBinding`) did not change in that commit. Pace pins 0.86.0. Just record it.

## Constraints

- TypeScript, English comments (why over what), existing code style (2-space, double quotes, no semicolons omitted — match neighbours).
- No changes to `session-process-*.ts` production files, no wiring into drivers, no renderer (`apps/desktop`) code.
- Tests must be deterministic: poll with bounded `waitFor` like the existing tests, no bare sleeps.
- Verification before reporting: `bunx vitest run packages/backend/src/drivers/chord-plugin-spike` (all spike files), then `bun run typecheck`, then full `bun run test`. Paste real output.
- Commit on the current branch when everything is green, one commit, Conventional Commits, e.g. `chore(backend): spike chord presentation host in renderer with backend relay and hot reload`. Do not push.

## Out of scope

- Multiplexing chord frames per session id, iframe isolation, loading facet bundles in the renderer, any production protocol change (issue #355 covers B0).
- Upgrading chord / pi-coding-agent to 0.87.
