<p align="center">
  <img src="build/icon-512.png" alt="" width="128" height="128">
</p>
<h1 align="center">Pace</h1>
<p align="center">The desktop GUI for the <a href="https://pi.dev">Pi coding agent</a>. Pi's design and flexibility, carried to the desktop.</p>

<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://github.com/BubblePtr/pace/releases/latest"><img src="https://img.shields.io/github/v/release/BubblePtr/pace?display_name=tag" alt="Release"></a>
  <a href="https://github.com/BubblePtr/pace/releases/latest"><img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Linux%20x64-black" alt="Platform: macOS arm64 and Linux x64"></a>
  <a href="https://github.com/BubblePtr/pace/actions"><img src="https://img.shields.io/github/actions/workflow/status/BubblePtr/pace/release-macos.yml?label=release" alt="Release workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/BubblePtr/pace" alt="License: Apache-2.0"></a>
</p>

Pi is a coding agent that runs in the terminal, extensible in the spirit of VS Code: packages contribute tools, commands, skills, prompts and themes. Pace brings that flexibility to the desktop, so you can shape a desktop agent that is truly your own. The name comes from *move at your own pace*: developers should keep full ownership of their agent and set their own rhythm.

> [!NOTE]
> Pace is in early `0.y.z` development. Only the latest version on GitHub Releases is supported. Journal and projection formats may change between minor versions; the in-app updater handles upgrades. Pi's session data is unaffected (see [Local data and recovery](#local-data-and-recovery)).

<p align="center">
  <img src="docs/assets/readme/home.png" alt="Pace home screen: New Chat with model picker and prompt suggestions" width="800">
</p>

## Highlights

- **Session timeline**: follow the agent's chain of thought and tool calls in order, with token usage and cost for every turn. Watch a run live, or replay a recorded session to see what each step did and what it cost.
- **Session Dock**: Changes, Files, Terminal and an embedded Browser share one sidebar next to the conversation.
- **Your Pi setup, as is**: Pace shares the sessions, auth and extensions under `~/.pi/agent`, and the Packages page manages Pi packages without leaving the app.
- **Pi remains the only engine**: Pace is not a fork of Pi or a separate runtime. Pi's local logs stay the source of truth; uninstalling Pace never deletes a Pi session.

## When Pace is not a fit

- You use Pi in the terminal and do not need a graphical view of cost, chain of thought or tool calls.
- You are on Windows or an Intel Mac. Installers exist for Apple Silicon Macs and 64-bit Linux only.
- You want an agent client that does not depend on Pi. Pace has no agent loop of its own; Pi handles inference and context management.

## Quick start

### Install

Each [GitHub Release](https://github.com/BubblePtr/pace/releases) ships a signed and notarized DMG for Apple Silicon Macs, plus a Linux x64 AppImage and deb.

| Platform | Install | Updates |
| --- | --- | --- |
| macOS 12+ (Apple Silicon) | Open the DMG and drag Pace into Applications. | In-app |
| Linux AppImage (x64) | `chmod +x` the file and run it. Without FUSE, add `--appimage-extract-and-run`. | In-app |
| Linux deb (x64) | Install with `apt`. | Install the new package manually |

The Pi runtime is bundled, so no separate `pi` install is needed. More Linux details: [`docs/release/linux.md`](docs/release/linux.md). To run from source instead, follow [Setup in CONTRIBUTING.md](CONTRIBUTING.md#setup).

### Start your first session

1. On first launch, Pace checks the bundled Pi runtime, the data directory and your model provider login, and shows where data will be saved. If you are not signed in to a provider, run `pi` in a terminal and sign in there; Pace picks up the new login without a restart.
2. Select a project directory and create a session.
3. Send a first message, for example: *Explain this repo's architecture*.
4. Read the conversation in Live Chat, inspect the chain of thought and tool calls in Trajectory, and check the turn's token usage and cost in the status bar.

## Design principles

- **Pi owns the context.** Pi's session log under `~/.pi` is the single source of truth. Pace never assembles a prompt and never writes to that log; it stores only projections of Pi's event stream, in its own directory.
- **The event journal drives the UI.** Every Pi event is normalized, sequenced and appended to a journal. The live timeline, history replay and cost accounting are all derived from it.
- **The GUI never blocks the agent.** The backend runs in a separate Electron `utilityProcess` and each root session runs Pi in its own process, so heavy log parsing or a crashing session cannot freeze the window.
- **Built to be extended.** Event routing, the Session Dock and the gateway's capability model are designed so Pi extensions can add their own panels and controls. The protocol for that is the first item on the roadmap below.

How these principles turn into code: [`docs/architecture.md`](docs/architecture.md).

## Extensibility

Pace reuses Pi's `Package → Extension / Skill / Prompt / Theme` model unchanged. The **Packages** page in the sidebar installs, removes and updates packages, toggles individual resources, and adds local resources to Pi's convention directories. Package rows flag available updates, and resource details show extension errors from the most recently active session. Changes apply to the next new session.

Extensions cannot contribute GUI panels yet. The roadmap, in priority order:

1. **Extension Surface protocol**: let a Pi extension register its own panel, fed by the same event stream as the built-in views.
2. **Multi-agent workflow visualization**: render multi-step and multi-agent runs as an execution topology instead of interleaved logs.
3. **Pluggable runtime tuning**: expose prompt injection, permissions and interruption policy as extension points, so behavior changes ship as packages rather than client patches.

## Local data and recovery

| Data | Installed app | `bun run dev` | Owner |
| --- | --- | --- | --- |
| Pi sessions, auth, extensions | `~/.pi/agent` | shared | Pi owns session truth; Pace manages user resource settings through the SDK and imports local resources. |
| Session journal, projections, preflight state | `~/.pace` | `~/.pace-dev` | Pace. Override with `PACE_DATA_DIR` (`PIGUI_DATA_DIR` is a deprecated alias). |
| Renderer preferences (project registry, drafts, model choice), Chromium profile | Electron userData | userData `-dev` | Pace. |

Deleting Pace's data directory loses only UI history and cost statistics. Pi session data is never touched, and Pi can rebuild its state from its own log at any time.

## Support and security

- **Bugs and feature requests**: [GitHub Issues](https://github.com/BubblePtr/pace/issues).
- **Security vulnerabilities**: do not open a public issue. Report privately through GitHub as described in [SECURITY.md](SECURITY.md). Only the latest release is supported.
- **Release notes**: [GitHub Releases](https://github.com/BubblePtr/pace/releases).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md): setup, verification commands, branch rules and a good first PR. [`docs/architecture.md`](docs/architecture.md) maps the event pipeline and where each concern lives in the code; [`AGENTS.md`](AGENTS.md) holds the full rule set, written for humans and coding agents alike. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Pace is released under the [Apache License 2.0](LICENSE). The Pace name and icon are not covered by that grant. Pi is a separate project with its own license.
