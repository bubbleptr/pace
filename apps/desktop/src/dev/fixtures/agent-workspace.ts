// Browser-development and test data for the Agent Workspace. Production code
// reads it only behind shouldUseBrowserDevelopmentData(); nothing takes it as a
// default prop.
import { createSessionProjection, type SessionProjection } from "@/entities/session/session-projection";
import { browserDevelopmentProjectId } from "@/dev/browser-development-data";
import type { AgentWorkspaceFixture } from "@/widgets/live-chat";

export const fixtureWorkspace: AgentWorkspaceFixture = {
  id: "pig",
  name: "Pig",
  projectRoot: "/Users/void/code/opensource/Pig",
  repoRoot: "/Users/void/code/opensource/Pig",
  selectedSessionId: "session-control-plane-shell",
  liveMessages: [
    {
      id: "message-user",
      role: "user",
      body: "Create the Agent Workspace entry shape for this Project.",
    },
    {
      id: "message-assistant",
      role: "assistant",
      body: "Project Sessions keep live Pi work separate from Trajectory and Usage evidence.",
    },
  ],
  runTimeline: [
    {
      id: "timeline-read-context",
      title: "Project context loaded",
      meta: "Pace workspace and recent session evidence",
    },
    {
      id: "timeline-render-shell",
      title: "Workspace view prepared",
      meta: "Session list, live chat, timeline, and action surface",
    },
    {
      id: "timeline-analyze",
      title: "Evidence preserved",
      meta: "Trajectory and Usage stay as historical evidence views",
    },
  ],
  checkout: {
    mode: "Foreground local checkout",
    root: "/Users/void/code/opensource/Pig",
    runtimeCwd: "/Users/void/code/opensource/Pig",
  },
  summary: {
    model: "gpt-5-codex",
    totalCostUsd: 0.042137,
    totalTokens: 18_420,
  },
};

const defaultSidebarProjectId = browserDevelopmentProjectId;

function createSidebarProjection({
  id,
  title,
  status,
  updatedAt,
  unreadResult = false,
  archivedAt = null,
  summary = {},
}: {
  id: string;
  title: string;
  status: SessionProjection["status"];
  updatedAt: string;
  unreadResult?: boolean;
  archivedAt?: string | null;
  summary?: Partial<SessionProjection["summary"]>;
}): SessionProjection {
  const projection = createSessionProjection({
    id,
    projectId: defaultSidebarProjectId,
    initialPrompt: title,
    createdAt: "2026-06-26T08:00:00.000Z",
  });

  return {
    ...projection,
    status,
    creationStage: "accepted",
    checkout:
      status === "running"
        ? {
            mode: "foreground-local",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig",
          }
        : projection.checkout,
    runtimeId: status === "running" ? `${id}-runtime` : projection.runtimeId,
    piSessionId: status === "running" ? `${id}-pi-session` : projection.piSessionId,
    runtimeEvents:
      status === "running"
        ? [
            {
              id: `${id}-runtime-event`,
              piSessionId: `${id}-pi-session`,
              kind: "message",
              role: "assistant",
              body: title,
              timestamp: updatedAt,
            },
          ]
        : [],
    unreadResult,
    archivedAt,
    summary: {
      ...projection.summary,
      ...summary,
    },
    modelControls: {
      models: [
        {
          provider: "openai",
          modelId: "gpt-5-codex",
          name: "GPT-5 Codex",
          thinkingLevels: ["off", "low", "medium", "high"],
        },
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          thinkingLevels: ["off", "low", "medium", "high"],
        },
      ],
      selected: {
        provider: "openai",
        modelId: "gpt-5-codex",
        thinkingLevel: "high",
      },
    },
    lastUserMessageAt: updatedAt,
    updatedAt,
  };
}

export const defaultSidebarProjectSessionProjections: SessionProjection[] = [
  createSidebarProjection({
    id: "session-usage-review",
    title: "Usage evidence review",
    status: "completed",
    summary: {
      model: "gpt-5-codex",
      totalCostUsd: 0.042137,
      totalTokens: 18_420,
    },
    updatedAt: "2026-06-26T08:03:00.000Z",
  }),
  createSidebarProjection({
    id: "session-control-plane-shell",
    title: "Agent Workspace shell",
    status: "running",
    summary: {
      model: "gpt-5-codex",
      totalCostUsd: 0.042137,
      totalTokens: 18_420,
    },
    updatedAt: "2026-06-26T08:06:00.000Z",
  }),
  createSidebarProjection({
    id: "session-archived-checkout",
    title: "Archived checkout snapshot",
    status: "completed",
    archivedAt: "2026-06-26T08:05:00.000Z",
    updatedAt: "2026-06-26T08:05:00.000Z",
  }),
  createSidebarProjection({
    id: "session-analyze-boundary",
    title: "Trace boundary pass",
    status: "completed",
    unreadResult: true,
    summary: {
      model: "gpt-5-codex",
      totalCostUsd: 0.042137,
      totalTokens: 18_420,
    },
    updatedAt: "2026-06-26T08:02:00.000Z",
  }),
];
