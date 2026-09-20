# Task brief: project Pi 0.86 `role: "system"` transcript messages as a chat notice

Repo: /Users/void/code/opensource/PiGUI  Branch: `feat/pi-0.86-system-entries` (already checked out; Pi bumped to 0.86.0, typecheck+tests green). Do NOT commit.

## Background

Pi 0.86.0 persists system prompt and tool-loadout changes as ordinary messages with `role: "system"`:

```ts
{ role: "system", content: string, sections?: Record<string, string | null>,
  toolsAdded?: Tool[], toolsRemoved?: { name: string }[], timestamp: number }
```

The first request of a session emits one declaring every prompt section and every tool; later ones patch `sections` by name (`null` removes) and list `toolsAdded` / `toolsRemoved`. They flow through the same `message_start` / `message_end` agent events as user and assistant messages. Today PiGUI drops them at the normalizer entrance (`packages/backend/src/gateway/agent-runtime-event-normalizer.ts:421`), and the cold transcript parser maps them to role `"unknown"` which the Trajectory ledger renders like an assistant turn.

## Goal

1. Live path: a system message becomes a new `AgentRuntimeEvent` member and renders in the conversation as a compact centered notice using Astryx `ChatSystemMessage` (`import { ChatSystemMessage } from "@astryxdesign/core/Chat"`, props `children`, `variant: "default" | "divider"`, `icon`).
2. Cold path: `packages/backend/src/workspace/sessions.ts` (`effectiveRole` near line 648) must skip system-role entries so the Trajectory viewer does not show them as turns.

## Design (decided, follow it)

- **New event type, not a widened role.** Add to the `AgentRuntimeEvent` union in `packages/core/src/agent-runtime-event.ts`:
  `{ type: "context_change"; runId; turnId; messageId; surface: "chat"; origin; sectionsChanged: string[]; sectionsRemoved: string[]; toolsAdded: string[]; toolsRemoved: string[] }`
  (names only for tools; timestamps follow whatever the `error` member does). It is journaled by default; leave `shouldJournalRuntimeEvent` alone. It is NOT chat activity for the sidebar list time (`session-list-time.ts`), leave that alone.
- **Normalizer**: `message_start` with role `system` emits nothing and does not open a message. `message_end` with `rawMessage.role === "system"` mints a messageId (reuse the `messageSeq` counter) and emits one `context_change`. The existing `rawMessage?.role !== endedMessage.role` guard at ~:463 must not swallow it.
- **Runtime model** (`apps/desktop/src/entities/session/session-runtime-model.ts`): add order-entry kind `"context_change"` and store the payload; reducer currently falls into `default` for unknown types.
- **Page dispatch** (`apps/desktop/src/pages/agent-workspace.tsx`, `liveMessagesFromRuntimeModel` ~:1197 and `LiveChatMessage` ~:358): mirror how the `error` order entry becomes a non-bubble row (`ChatRunFailure`). Pick the cleanest discriminant on `LiveMessage`; it must never fall into the assistant bubble branch. The legacy `liveMessagesFromProjection` path may ignore the new event.
- **New shared component** `apps/desktop/src/shared/ui/chat/chat-context-change.tsx` wrapping `ChatSystemMessage` (pages must not import `@astryxdesign/core/Chat` directly, see `docs/design/chat.md`). Text rules, English UI strings like the rest of the app:
  - tools: `Tools changed: +write, +edit, −bash`; when more than 4 names on a side, use a count: `+12 tools`.
  - sections: `Prompt updated: skills, cwd`; removed: `Prompt section removed: skills`.
  - both present: join fragments with ` · `.
  - nothing to say (empty patch): render nothing.
  - variant `default`; no icon needed.
- **Design page**: register the component in `apps/desktop/src/pages/design-components.tsx` (gallery function + `componentExamples` entry under "Conversation", showing tools-only, sections-only, both, and the >4 count case), add the name to `design-components.test.tsx` region list and to the a11y contract list in `apps/desktop/src/shared/ui/contract.test.tsx`. Add a row to `docs/self-built-ui.md` (Chinese, section 一) and a usage note in `docs/design/chat.md`. Not a region-level component: do not touch `dev/ui-intent/regions.ts`.
- **Docs**: if `docs/adr/0020-agent-runtime-event-model.md` or `CONTEXT.md` enumerates the event union or its terms, add `context_change` there in the same style. Otherwise leave them.

## Tests (behavior, not literals)

- Normalizer: system `message_start`+`message_end` yields exactly one `context_change` with the diff fields; `message_start` alone yields nothing; a system message between two assistant messages does not disturb assistant messageIds / `agent_end` stopReason. Style: `agent-runtime-event-normalizer.test.ts:1038-1076`.
- Runtime model reducer: event lands in `order` with the new kind.
- Page: a model containing a `context_change` renders the notice text and no assistant bubble (existing agent-workspace tests show the harness).
- Component: text formatting rules above, including the >4 count and the empty-patch-renders-nothing case. Style: `chat-run-failure.test.tsx`.
- Cold path: `sessions.ts` skips system entries (one test in its existing suite).

## Verification (must be green, paste real output)

```
bun run typecheck && bun run test && bun run build
```

## Out of scope

Subagent observed sessions (`packages/backend/src/subagent/`), the `usage` cache-warm entry, any refactor of the role types on `LiveMessage` / `SessionRuntimeMessage` beyond what the new kind needs. Record anything else you notice in the report.
