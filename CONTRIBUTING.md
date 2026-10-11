# Contributing to Pace

Thanks for wanting to help. This guide is for a first-time human contributor. Coding agents should follow [`AGENTS.md`](AGENTS.md), which is the canonical rule set; this file is the human-oriented subset.

## Setup

Toolchain: **Bun 1.3.x** (workspaces and scripts) and **Node 24** (Electron's runtime and vitest). Electron 42 is installed by `bun install`.

```sh
git clone https://github.com/BubblePtr/pace.git pace
cd pace
bun install
bun run dev
```

`bun run dev` writes to `~/.pace-dev` and a `-dev` Electron userData profile. It never touches `~/.pace` or the installed app's sessions. Override the backend data directory with `PACE_DATA_DIR` if you need to (`PIGUI_DATA_DIR` is a deprecated alias). Isolation details: [`docs/dogfooding.md`](docs/dogfooding.md).

Do not run the terminal pty driver under Bun (`bun script.ts`, `bun -e`). Use `node` for one-off pty debug scripts. Production runs the backend in Electron's Node via `utilityProcess`.

## Finding work

Actionable work lives on [GitHub Issues](https://github.com/BubblePtr/pace/issues). Product requirements stay in the repo at `.scratch/<feature>/PRD.md`.

Issues use five triage labels:

| Label | Meaning |
| --- | --- |
| `needs-triage` | Maintainer has not classified it yet |
| `needs-info` | Waiting on the reporter |
| `ready-for-agent` | Fully specified; an AFK agent can take it |
| `ready-for-human` | Needs a person (judgment, credentials, or design) |
| `wontfix` | Will not be actioned |

Pick up anything labeled `ready-for-human` or `good first issue`. Leave `ready-for-agent` issues unless you are running an agent against them. Label vocabulary: [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md). Tracker layout: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

## Branches and pull requests

- Work on a `feat/`, `fix/`, or `chore/` branch. Never push to `main`.
- `main` is the only long-lived branch. Releases are tags (`vX.Y.Z`), not branches. How to pick the next version: [docs/release/macos.md](docs/release/macos.md#怎么选版本号).
- Open a PR. Merges use a merge commit (`gh pr merge --merge`), matching existing history.
- Dependent PRs use [`gh stack`](https://gh.io/stacks). Do not point one PR's base at another PR's branch by hand: deleting the lower branch after merge closes every PR based on it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, …).

## What a PR must include

Before you open it:

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

All four must be green. Also:

- An [ADR](docs/adr/) when the change moves an architectural boundary or a product term.
- A [`CONTEXT.md`](CONTEXT.md) update in the same PR when vocabulary changes. Terms there are the names used in code, tests, and issues.
- A new or changed component in `apps/desktop/src/shared/ui/` must be registered on the dev-only `/design` page in the same PR, with its variants and typical states.
- Code comments are English. Prefer *why* over *what*.

UI work has extra rules in [`docs/design/`](docs/design/). Discover Astryx components before writing new ones; reusable pieces live only in `shared/ui/`.

## Testing, packaging and dev tools

The four commands above are the PR gate. Two more suites cover the edges:

```bash
bun run test:e2e         # Playwright smoke tests against the dev Electron build
bun run test:release     # release script and publish behavior tests
```

The manual `Validate macOS ARM64` workflow runs packaging and the packaged-app E2E on demand.

Packaging:

```bash
bun run package:mac:unsigned   # unsigned .app + zip, for local testing
bun run dist:mac               # signed + notarized DMG (needs Apple credentials)
bun run dist:linux             # AppImage + deb (x64)
```

The signing, notarization and release pipeline is documented in [`docs/release/macos.md`](docs/release/macos.md). Linux AppImage and deb builds ship on the same tag: [`docs/release/linux.md`](docs/release/linux.md).

Two dev-only tools help when working on the UI locally:

- The `/design` route: a live gallery of the design system, showing every base component under `shared/ui/` with all of its states and variants.
- The **UI Intent Picker**: press `Cmd/Ctrl+Shift+X` to activate a crosshair, then click any element to copy its CONTEXT.md term, its component stack with file and line, and the nearest `data-testid` (see [`docs/ui-intent-picker.md`](docs/ui-intent-picker.md)).

## A good first PR

Add a new fixture stream to the event normalizer (`packages/backend/src/gateway/agent-runtime-event-normalizer.test.ts`): record a Pi session, add the raw events, and assert the normalized `AgentRuntimeEvent` sequence. That exercises the protocol without touching UI.

## Documentation map

- [`docs/architecture.md`](docs/architecture.md): the canonical code map — the event pipeline, which file owns which concern, and the step-by-step prompt flow.
- [`CONTEXT.md`](CONTEXT.md): domain glossary. The terms here are the names used in code, tests and issues.
- [`docs/adr/`](docs/adr/): architecture decision records, from the control-plane pivot ([ADR-0001](docs/adr/0001-agent-workspace-control-plane.md)) to the current surfaces.
- [`docs/design/`](docs/design/): which tokens, which Astryx variants, which self-built components.
- [`docs/release/macos.md`](docs/release/macos.md), [`docs/release/linux.md`](docs/release/linux.md), [`docs/dogfooding.md`](docs/dogfooding.md): shipping and daily-driving Pace.
- [`docs/agents/`](docs/agents/): how issues, triage labels and domain docs are organized for both human and agent contributors.
- [`.scratch/<feature>/PRD.md`](.scratch/): point-in-time product requirement records.

## License

Contributions are accepted under the [Apache License 2.0](LICENSE). There is no CLA. The Pace name and icon are not covered by that grant.

By participating you also agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).
