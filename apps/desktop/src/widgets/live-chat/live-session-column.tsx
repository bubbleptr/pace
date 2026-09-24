import { Button } from "@astryxdesign/core/Button";
import { ChatConversation } from "@/shared/ui/chat/chat-conversation";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ModelSelectorControl } from "@/shared/ui/model-selector/model-selector-control";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RuntimePromptImage } from "@pace/core";
import { getBrowserDevelopmentSessionDraft } from "@/shared/browser-development-data";
import { type ExecutionCheckoutManager } from "@/entities/checkout/execution-checkout";
import {
  getProjectGitSummary,
  useProjectGit,
} from "@/entities/project/project-git";
import {
  CHAT_PICKER_LABEL,
  CHAT_PROJECT_ID,
  chatWorkspaceListEntry,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import { type ProjectRegistryEntry } from "@/entities/project/project-registry";
import { useVisibleProjectRegistry } from "@/entities/project/visible-registry";
import { checkoutModeToExecutionMode } from "@/entities/checkout/checkout-strategy-picker";
import {
  PiRuntimeBridgeError,
  type PiRuntimeBridge,
  type RuntimeModelSelection,
} from "@/entities/runtime/pi-runtime-bridge";
import {
  prepareChatSessionCheckout,
  type CreateSessionFromDraftInput,
  type CreateSessionFromDraftResult,
} from "@/entities/session/session-creation";
import { saveFollowUpDraft } from "@/entities/session/follow-up-drafts";
import {
  clearSessionDraft,
  getSessionDraft,
  saveSessionDraft,
  setSessionDraftBaseRef,
  setSessionDraftCheckoutMode,
  setSessionDraftTarget,
  subscribeSessionDrafts,
  type SessionDraftCheckoutMode,
  type SessionDraft,
} from "@/entities/session/session-drafts";
import {
  createSessionProjection,
  isSessionProjectionActive,
  type SessionProjection,
} from "@/entities/session/session-projection";
import { type SessionChangesView } from "@/entities/session/use-session-changes";
import { saveLastModelSelection } from "@/entities/session/last-model-preference";
import { useVisibleModels } from "@/entities/model/visible-models";
import { useLiveSession } from "@/entities/session/use-session-projections";
import { type SessionProjectionsStore } from "@/entities/session/session-projections-store";
import {
  isAssistantAnswerMessage,
  isReadOnlyProjection,
  isRuntimeUnavailableProjection,
  liveMessagesFromProjection,
  liveMessagesFromRuntimeModel,
  relatedMessageIdsFor,
  runTimelineFromProjection,
  runtimeModelIsActive,
  type LiveMessage,
  type RunTimelineItem,
} from "@/entities/session/live-chat-model";
import {
  SessionCreationFailureDetail,
  SessionDraftComposer,
  SessionDraftExitEcho,
  type SessionDraftSubmitEvent,
} from "@/features/session-draft";
import { LiveChatMessage, settledCotViewFromTimeline } from "./live-chat-message";
import { FullChatComposer } from "./full-chat-composer";
import { messageFromError, restoreProjectionRuntimeState } from "./restore-runtime-state";

export type AgentWorkspaceFixture = {
  id: string;
  name: string;
  projectRoot: string;
  repoRoot: string;
  selectedSessionId: string | null;
  liveMessages: LiveMessage[];
  runTimeline: RunTimelineItem[];
  checkout: {
    mode: string;
    root: string;
    runtimeCwd: string;
  };
  summary: {
    model: string;
    totalCostUsd: number;
    totalTokens: number;
  };
};

export type SessionCreatorInput = Omit<CreateSessionFromDraftInput, "bridge">;

export type SessionCreator = (
  input: SessionCreatorInput,
) => Promise<CreateSessionFromDraftResult>;

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `session-${crypto.randomUUID()}`;
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Mirrors `--duration-medium` (410ms): how long the Live Session keeps the
 * handoff attributes after leaving the draft, so the transform never outlives
 * the transition (docs/design/typography-motion.md rule 2).
 */
const draftHandoffMs = 410;

export function LiveSessionColumn({
  workspace,
  projectId,
  showDraft,
  onDraftSubmit,
  onSessionCreationStarted,
  onSessionCreated,
  onReopenDraft,
  sessionCreator,
  checkoutManager,
  getRuntimeBridge,
  projectionsStore,
  recommendedCheckoutMode,
  sessionId,
  sessionChanges,
  clockNowMs,
  loadProjectGitSummary,
  onManageModels,
  onOpenProviderSettings,
}: {
  workspace: AgentWorkspaceFixture;
  projectId: string;
  showDraft: boolean;
  onDraftSubmit: (event: SessionDraftSubmitEvent) => void;
  /** The `creating` projection exists; the view can leave the draft now. */
  onSessionCreationStarted?: (projection: SessionProjection) => void;
  onSessionCreated?: (projection: SessionProjection) => void;
  /** Return to the kept Session Draft after a failed creation. */
  onReopenDraft?: (projection: SessionProjection) => void;
  sessionCreator: SessionCreator;
  checkoutManager: ExecutionCheckoutManager;
  getRuntimeBridge: () => PiRuntimeBridge;
  projectionsStore: SessionProjectionsStore;
  recommendedCheckoutMode: SessionDraftCheckoutMode;
  /** The Session on screen outside the Session Draft. */
  sessionId: string | null;
  sessionChanges?: SessionChangesView;
  clockNowMs?: number;
  loadProjectGitSummary?: typeof getProjectGitSummary;
  onManageModels?: () => void;
  onOpenProviderSettings?: () => void;
}) {
  // The retry control under a failed run reads the same live set as the composer.
  const visibleModels = useVisibleModels();
  const registryProjects = useVisibleProjectRegistry();
  const fallbackProject: ProjectRegistryEntry = isChatProjectId(projectId)
    ? chatWorkspaceListEntry()
    : {
        id: projectId,
        path: workspace.projectRoot,
        displayName: workspace.name,
        addedAt: "1970-01-01T00:00:00.000Z",
      };
  const usingRegistryProjects = registryProjects.length > 0;
  const projects = usingRegistryProjects
    ? registryProjects
    : isChatProjectId(projectId)
      ? []
      : [fallbackProject];
  const projectIds = projects.map((project) => project.id);
  const projectIdsKey = projectIds.join("\n");
  const getVisibleSessionDraft = () =>
    getSessionDraft({ projectIds }) ??
    (showDraft ? getBrowserDevelopmentSessionDraft(projectIds) : null);
  const [sessionDraft, setSessionDraft] = useState<SessionDraft | null>(() =>
    getVisibleSessionDraft(),
  );
  // Only the Session Draft asks Git about the Project folder, and never for
  // the Chat workspace. A Session's own branch keeps coming from
  // useSessionChanges, which may not run before its checkout exists (#268).
  const draftProjectRoot =
    showDraft &&
    sessionDraft?.projectId &&
    !isChatProjectId(sessionDraft.projectId)
      ? projects.find((project) => project.id === sessionDraft.projectId)?.path ??
        null
      : null;
  const projectGit = useProjectGit({
    projectRoot: draftProjectRoot,
    ...(loadProjectGitSummary ? { loadSummary: loadProjectGitSummary } : {}),
  });
  // The Session this column's draft submit is creating; the draft composer
  // shows its stages until the route leaves the draft.
  const [creatingSessionId, setCreatingSessionId] = useState<string | null>(null);
  const {
    projection: liveProjection = null,
    history,
    apply,
    retryHistory,
  } = useLiveSession(showDraft ? creatingSessionId : sessionId);
  // Set by a draft submit in this column; consumed when the route leaves the
  // draft so only that handoff plays the composer settle, not a sidebar click.
  const draftHandoffPendingRef = useRef(false);
  const [draftHandoff, setDraftHandoff] = useState<"measure" | "run" | null>(null);
  // Where the draft composer sat when it was submitted, in viewport
  // coordinates: the Live composer starts there instead of at a guessed
  // centre, so the two never appear at different heights.
  const draftComposerRectRef = useRef<{ top: number; height: number } | null>(null);
  // The branch the draft's Location row showed, kept for the Session it
  // started so the row never blanks while Git looks at the new checkout.
  const [draftLocationHandoff, setDraftLocationHandoff] = useState<{
    sessionId: string;
    branchLabel: string | null;
    checkoutMode: SessionDraftCheckoutMode;
  } | null>(null);
  const columnRef = useRef<HTMLElement | null>(null);
  // Keyed by Session so a Stop in flight never locks another Session's composer.
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
  const stoppingRun = stoppingSessionId !== null && stoppingSessionId === liveProjection?.id;
  const [liveClockNowMs, setLiveClockNowMs] = useState(() => Date.now());

  useEffect(() => {
    setSessionDraft(getVisibleSessionDraft());
    setCreatingSessionId(null);

    return subscribeSessionDrafts(() => {
      setSessionDraft(getVisibleSessionDraft());
    });
  }, [projectId, projectIdsKey, showDraft]);

  useEffect(() => {
    if (showDraft || !draftHandoffPendingRef.current) {
      return;
    }

    draftHandoffPendingRef.current = false;
    setDraftHandoff("measure");
  }, [showDraft]);

  // First frame: park the composer where the draft composer sat. Next frame:
  // release it so the transition carries it down.
  useLayoutEffect(() => {
    if (draftHandoff !== "measure") {
      return;
    }

    const column = columnRef.current;
    const composer = column?.querySelector<HTMLElement>(
      '[data-testid="full-chat-composer"] [data-slot="prompt-input"]',
    );
    const draftRect = draftComposerRectRef.current;

    if (column && composer && draftRect) {
      const offset = draftRect.top - composer.getBoundingClientRect().top;
      column.style.setProperty("--pigui-draft-handoff-offset", `${offset}px`);
    }

    const frame = requestAnimationFrame(() => setDraftHandoff("run"));

    return () => cancelAnimationFrame(frame);
  }, [draftHandoff]);

  useEffect(() => {
    if (draftHandoff !== "run") {
      return;
    }

    const timer = setTimeout(() => {
      columnRef.current?.style.removeProperty("--pigui-draft-handoff-offset");
      draftComposerRectRef.current = null;
      setDraftHandoff(null);
    }, draftHandoffMs);

    return () => clearTimeout(timer);
  }, [draftHandoff]);

  useEffect(() => {
    if (!showDraft && liveProjection?.unreadResult) {
      apply({ type: "latest-message-rendered", occurredAt: new Date().toISOString() });
    }
  }, [apply, liveProjection?.unreadResult, showDraft]);

  const handleDraftChange = (prompt: string) => {
    setSessionDraft(saveSessionDraft(sessionDraft?.projectId ?? null, prompt));
  };
  const handleDraftCheckoutModeChange = (
    checkoutMode: SessionDraftCheckoutMode,
  ) => {
    setSessionDraft(setSessionDraftCheckoutMode(checkoutMode));
  };
  const handleDraftBaseRefChange = (baseRef: string) => {
    setSessionDraft(setSessionDraftBaseRef(baseRef));
  };
  const handleDraftTargetChange = (targetProjectId: string | null) => {
    setSessionDraft(setSessionDraftTarget(targetProjectId));
  };
  const handleDraftSubmit = async (event: SessionDraftSubmitEvent) => {
    const draftComposer = columnRef.current?.querySelector<HTMLElement>(
      '[data-testid="session-draft-composer"] [data-slot="prompt-input"]',
    );

    if (draftComposer) {
      const rect = draftComposer.getBoundingClientRect();
      draftComposerRectRef.current = { top: rect.top, height: rect.height };
    }

    const draft = getSessionDraft({ projectIds });

    if (!draft?.projectId) {
      return;
    }

    const draftBranch = event.baseRef ?? projectGit.summary?.branch ?? null;
    const draftBranchLabel = draftBranch
      ? event.checkoutMode === "worktree"
        ? `from ${draftBranch}`
        : draftBranch
      : null;

    const targetProject = isChatProjectId(draft.projectId)
      ? chatWorkspaceListEntry()
      : projects.find((project) => project.id === draft.projectId);

    if (!targetProject) {
      return;
    }

    onDraftSubmit(event);

    const chatTarget = isChatProjectId(draft.projectId);
    const targetProjectRoot = chatTarget
      ? CHAT_PROJECT_ID
      : usingRegistryProjects
        ? targetProject.path
        : workspace.projectRoot;
    const targetRepoRoot = chatTarget
      ? undefined
      : usingRegistryProjects
        ? undefined
        : workspace.repoRoot;

    let creationStarted = false;
    const result = await sessionCreator({
      draft: {
        ...draft,
        prompt: event.prompt,
        // The composer already dropped a pick the Project no longer lists.
        baseRef: event.baseRef,
      },
      project: {
        id: targetProject.id,
        repoRoot: targetRepoRoot,
        projectRoot: targetProjectRoot,
      },
      executionMode: chatTarget
        ? "foreground"
        : checkoutModeToExecutionMode(event.checkoutMode),
      ...(event.modelSelection ? { modelSelection: event.modelSelection } : {}),
      ...(event.images?.length ? { images: event.images } : {}),
      store: projectionsStore,
      // The creator writes every step to the store; the first one, the
      // `creating` projection, is the signal to leave the draft (ADR-0010).
      onProjectionChange: (projection) => {
        if (creationStarted) {
          return;
        }

        creationStarted = true;
        draftHandoffPendingRef.current = true;
        setCreatingSessionId(projection.id);
        setDraftLocationHandoff({
          sessionId: projection.id,
          branchLabel: draftBranchLabel,
          checkoutMode: event.checkoutMode,
        });
        onSessionCreationStarted?.(projection);
      },
    });

    if (result.clearDraft) {
      clearSessionDraft(draft.projectId);
      setSessionDraft(null);
      onSessionCreated?.(result.projection);
    }
  };
  // Retry only re-reads a failed load; the store keeps every other read to
  // one per runtime identity.
  const canRetryHistoryLoad = history === "failed";
  const shouldTickLiveClock =
    clockNowMs === undefined &&
    Boolean(liveProjection && isSessionProjectionActive(liveProjection));

  useEffect(() => {
    if (!shouldTickLiveClock) {
      return;
    }

    const interval = window.setInterval(() => {
      setLiveClockNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [shouldTickLiveClock, liveProjection?.id]);

  const effectiveClockNowMs = clockNowMs ?? liveClockNowMs;
  const projectionMessages = liveProjection
    ? (liveMessagesFromRuntimeModel(liveProjection, effectiveClockNowMs) ??
      liveMessagesFromProjection(liveProjection, effectiveClockNowMs))
    : [];
  const liveMessages = projectionMessages.length
    ? projectionMessages
    : workspace.liveMessages;
  // Only the legacy pipeline still routes a trace through timeline items; the
  // runtime-model path derives its view with the bubble it belongs to.
  const runTimeline = !liveProjection
    ? workspace.runTimeline
    : runtimeModelIsActive(liveProjection)
      ? []
      : runTimelineFromProjection(liveProjection);
  const fallbackTraceMessageId = runTimeline.some((item) => !item.messageId)
    ? [...liveMessages]
        .reverse()
        .find((message) => isAssistantAnswerMessage(message))?.id
    : undefined;
  // Legacy pipeline only: the runtime-model path derives its view alongside
  // the bubble, so there is nothing here to attach.
  const withLegacyCotView = (message: LiveMessage) => {
    if (message.cotView || !isAssistantAnswerMessage(message)) {
      return message;
    }

    const relatedMessageIds = new Set(relatedMessageIdsFor(message));

    return {
      ...message,
      cotView: settledCotViewFromTimeline(
        runTimeline.filter((item) =>
          item.messageId
            ? relatedMessageIds.has(item.messageId)
            : message.id === fallbackTraceMessageId,
        ),
      ),
    };
  };
  const readOnlyProjection = isReadOnlyProjection(liveProjection);
  const runtimeUnavailableProjection =
    isRuntimeUnavailableProjection(liveProjection) ? liveProjection : null;
  // Session Creation owns the column until Pi accepts the initial prompt: no
  // queueing before the first prompt exists, no follow-up input either.
  const creating = liveProjection?.status === "creating";
  const creationFailure =
    liveProjection?.status === "failed" ? liveProjection.failure : null;
  const pendingInitialPrompt =
    liveProjection &&
    (creating || creationFailure) &&
    !liveMessages.some((message) => message.role === "user")
      ? liveProjection.initialPrompt
      : null;
  const queueMode =
    Boolean(liveProjection?.piSessionId) &&
    Boolean(liveProjection && isSessionProjectionActive(liveProjection)) &&
    !creating &&
    !readOnlyProjection;
  // Handlers apply their result through `apply`, which stays bound to the
  // Session they started on: a reply that lands after the user switched away
  // updates that Session in the store and nothing on screen.
  const handleQueueSubmit = async (
    message: string,
    images?: RuntimePromptImage[],
  ) => {
    if (!liveProjection?.piSessionId || !queueMode) {
      return;
    }

    const queuedMessage = await getRuntimeBridge().queueFollowUp({
      piSessionId: liveProjection.piSessionId,
      message,
      ...(images?.length ? { images } : {}),
    });

    apply({ type: "queued-message-added", queuedMessage });
  };
  const pendingPromptsRef = useRef(new Map<string, { content: string; promise: Promise<void> }>());
  const handlePromptSubmit = async (
    message: string,
    images?: RuntimePromptImage[],
  ) => {
    const projection = liveProjection;

    if (!projection?.piSessionId || readOnlyProjection) {
      return;
    }

    const piSessionId = projection.piSessionId;
    const content = JSON.stringify({ message, images });
    const pending = pendingPromptsRef.current.get(projection.piSessionId);
    if (pending) {
      if (pending.content !== content) throw new Error("Wait for the pending message before sending another.");
      return pending.promise;
    }
    const sending = (async () => {
      await restoreProjectionRuntimeState({
        bridge: getRuntimeBridge(),
        projection,
        workspace,
      });

      const submittedAt = new Date().toISOString();
      const accepted = await getRuntimeBridge().sendInitialPrompt({
        piSessionId,
        prompt: message,
        ...(images?.length ? { images } : {}),
      });

      if (accepted.state) {
        apply({ type: "runtime-state-resynced", state: accepted.state });
      }
      apply({ type: "runtime-event-received", submittedAt, event: accepted.event });
    })();
    pendingPromptsRef.current.set(projection.piSessionId, { content, promise: sending });
    try {
      await sending;
    } finally {
      pendingPromptsRef.current.delete(projection.piSessionId);
    }
  };
  const modelChangeInFlight = useRef<Promise<void> | null>(null);
  const lastMessage = liveMessages[liveMessages.length - 1];
  const latestFailure = lastMessage?.controlLabel === "Run failed" ? lastMessage : undefined;
  const failedRequest = latestFailure
    ? [...liveMessages].reverse().find((message) => message.role === "user" && !message.controlLabel)
    : undefined;
  const retryImages = failedRequest?.images?.map((image) => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(image.src);
    return match ? { mimeType: match[1], data: match[2], ...(image.name ? { name: image.name } : {}) } : null;
  });
  const canRetryRequest = Boolean(
    failedRequest && liveProjection?.piSessionId && !queueMode &&
    !readOnlyProjection && !retryImages?.includes(null),
  );
  const retryFailedRequest = async () => {
    // A retry must use the model the user just chose, even during its RPC.
    await modelChangeInFlight.current;
    const current = liveProjection && projectionsStore.get(liveProjection.id);
    if (!canRetryRequest || !failedRequest || !current || isSessionProjectionActive(current)) return;
    await handlePromptSubmit(failedRequest.body, retryImages as RuntimePromptImage[] | undefined);
  };

  const handleModelConfigChange = async (
    selection: RuntimeModelSelection,
  ) => {
    if (!liveProjection?.piSessionId || queueMode) {
      return;
    }

    const bridge = getRuntimeBridge();

    if (!bridge.configureModel) {
      throw new Error("Runtime model controls are unavailable.");
    }

    const change = bridge.configureModel({
      sessionId: liveProjection.id,
      piSessionId: liveProjection.piSessionId,
      ...selection,
    }).then((modelControls) => {
      if (modelControls.selected) {
        saveLastModelSelection(modelControls.selected);
      }
      apply({
        type: "model-controls-changed",
        modelControls,
        occurredAt: new Date().toISOString(),
      });
    });
    modelChangeInFlight.current = change;
    try {
      await change;
    } finally {
      if (modelChangeInFlight.current === change) modelChangeInFlight.current = null;
    }
  };
  const handleWithdrawQueuedMessage = async (queuedMessageId: string) => {
    if (!liveProjection?.piSessionId) {
      return;
    }

    const result = await getRuntimeBridge().withdrawQueuedMessage({
      piSessionId: liveProjection.piSessionId,
      queuedMessageId,
    });

    if (!result.ok) {
      apply({
        type: "queued-messages-synced",
        queuedMessages: result.queuedMessages,
        occurredAt: new Date().toISOString(),
      });
      throw new Error(result.error);
    }

    apply({
      type: "queued-message-withdrawn",
      queuedMessageId,
      occurredAt: new Date().toISOString(),
    });
  };
  const handleReorderQueuedMessages = async (orderedIds: string[]) => {
    const projection = liveProjection;

    if (!projection?.piSessionId) {
      return;
    }

    const previousIds = projection.queuedMessages.map((queuedMessage) => queuedMessage.id);
    if (previousIds.join("\0") === orderedIds.join("\0")) {
      return;
    }

    apply({
      type: "queued-messages-reordered",
      orderedIds,
      occurredAt: new Date().toISOString(),
    });

    try {
      const pendingIds = orderedIds.filter((id) => {
        const queuedMessage = projection.queuedMessages.find((item) => item.id === id);
        return queuedMessage?.status === "pending";
      });
      const result = await getRuntimeBridge().reorderQueuedMessages({
        piSessionId: projection.piSessionId,
        orderedIds: pendingIds,
      });
      apply({
        type: "queued-messages-synced",
        queuedMessages: result.queuedMessages,
        occurredAt: new Date().toISOString(),
      });
    } catch {
      apply({
        type: "queued-messages-reordered",
        orderedIds: previousIds,
        occurredAt: new Date().toISOString(),
      });
    }
  };
  const handleSteerFromQueue = async (queuedMessageId: string) => {
    if (!liveProjection?.piSessionId) {
      return;
    }

    const result = await getRuntimeBridge().steerFromQueue({
      piSessionId: liveProjection.piSessionId,
      queuedMessageId,
    });

    apply({
      type: "queued-messages-synced",
      queuedMessages: result.queuedMessages,
      occurredAt: new Date().toISOString(),
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
  };
  const handleStopRun = async () => {
    const projection = liveProjection;

    if (!projection?.piSessionId || !queueMode || stoppingRun) {
      return;
    }

    const { piSessionId } = projection;

    setStoppingSessionId(projection.id);

    try {
      await restoreProjectionRuntimeState({
        bridge: getRuntimeBridge(),
        projection,
        workspace,
      });

      const event = await getRuntimeBridge().abortRun({ piSessionId });
      apply({ type: "run-stopped", event });
    } catch (error) {
      apply({
        type: "run-stop-failed",
        event: {
          id: `stop-failed-${Date.now()}`,
          piSessionId,
          kind: "error",
          title: "Stop failed",
          body: messageFromError(error),
          timestamp: new Date().toISOString(),
        },
      });
    } finally {
      setStoppingSessionId((current) => (current === projection.id ? null : current));
    }
  };
  const handleForkMessage = async (message: LiveMessage) => {
    if (
      !message.piEntryId ||
      !liveProjection?.piSessionId ||
      !liveProjection.sessionFile
    ) {
      return;
    }

    const bridge = getRuntimeBridge();

    if (!bridge.forkSession) {
      return;
    }

    const chatFork = isChatProjectId(liveProjection.projectId);
    const confirmed = window.confirm(
      chatFork
        ? [
            "Fork this message into a new Session?",
            "",
            "Pace will create a separate Chat Session from this message boundary.",
            "The selected message text will be pre-filled in the new composer.",
          ].join("\n")
        : [
            "Fork this message into a new Session?",
            "",
            "Pace will create a separate Session from this message boundary.",
            "Git Projects use a managed worktree; non-Git Projects may reuse the foreground directory.",
            "The selected message text will be pre-filled in the new composer.",
          ].join("\n"),
    );

    if (!confirmed) {
      return;
    }

    const targetProject = chatFork
      ? chatWorkspaceListEntry()
      : projects.find((candidate) => candidate.id === liveProjection.projectId) ??
        projects.find((candidate) => candidate.id === projectId) ??
        fallbackProject;
    const forkSessionId = createSessionId();
    const now = () => new Date().toISOString();
    const targetProjectRoot = chatFork
      ? CHAT_PROJECT_ID
      : usingRegistryProjects
        ? targetProject.path
        : workspace.projectRoot;
    const targetRepoRoot = chatFork
      ? undefined
      : usingRegistryProjects
        ? undefined
        : workspace.repoRoot;
    // Creation steps go through the store so it subscribes to the forked
    // Session's runtime on `runtime-bound`, like a Session created from a draft.
    const forkCreated = projectionsStore.insert(
      createSessionProjection({
        id: forkSessionId,
        projectId: targetProject.id,
        initialPrompt: message.body,
        createdAt: now(),
      }),
    );

    if (message.body.trim()) {
      saveFollowUpDraft(forkSessionId, message.body);
    }
    // The fork takes the view while it is created, as a draft's Session does.
    onSessionCreationStarted?.(forkCreated);

    try {
      const checkout = chatFork
        ? await prepareChatSessionCheckout({
            sessionId: forkSessionId,
            bridge,
            checkoutManager,
            now,
          })
        : await checkoutManager.prepareCheckout({
            sessionId: forkSessionId,
            strategy: "background-managed",
            project: {
              id: targetProject.id,
              repoRoot: targetRepoRoot,
              projectRoot: targetProjectRoot,
            },
            now,
          });

      projectionsStore.apply(forkSessionId, {
        type: "checkout-selected",
        stage: "preparing checkout",
        checkout,
        occurredAt: now(),
      });

      const fork = await bridge.forkSession({
        sessionId: forkSessionId,
        projectId: targetProject.id,
        sourcePiSessionId: liveProjection.piSessionId,
        sourceSessionFile: liveProjection.sessionFile,
        piEntryId: message.piEntryId,
        cwd: checkout.runtimeCwd,
        checkout,
      });
      const selectedText = fork.selectedText ?? message.body;

      if (selectedText.trim()) {
        saveFollowUpDraft(forkSessionId, selectedText);
      }

      projectionsStore.apply(forkSessionId, {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: fork.state.runtimeId,
        piSessionId: fork.state.piSessionId,
        summary: fork.state.summary,
        modelControls: fork.state.modelControls,
        followUpMode: fork.state.followUpMode,
        occurredAt: now(),
      });
      projectionsStore.apply(forkSessionId, {
        type: "runtime-state-resynced",
        state: fork.state,
      });
      projectionsStore.apply(forkSessionId, {
        type: "creation-accepted",
        initialPrompt: selectedText,
        occurredAt: now(),
      });
    } catch (error) {
      projectionsStore.apply(forkSessionId, {
        type: "creation-failed",
        stage:
          error instanceof PiRuntimeBridgeError &&
          error.stage === "forking session"
            ? "starting runtime"
            : "preparing checkout",
        message: messageFromError(error),
        occurredAt: now(),
      });
    }

    // Also on failure: the failed fork is where its error is shown.
    onSessionCreated?.(projectionsStore.get(forkSessionId) ?? forkCreated);
  };

  // Only the Session this column just created inherits the draft's Location;
  // a Session picked from the sidebar reads its own checkout.
  const draftLocationOfThisSession =
    draftLocationHandoff && draftLocationHandoff.sessionId === liveProjection?.id
      ? draftLocationHandoff
      : null;

  return (
    <main
      ref={columnRef}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="live-session-column"
      data-draft-handoff={draftHandoff ?? undefined}
    >
      {showDraft && sessionDraft ? (
        <SessionDraftComposer
          draft={sessionDraft}
          projects={projects}
          creationProjection={liveProjection}
          recommendedCheckoutMode={recommendedCheckoutMode}
          projectGit={projectGit}
          onDraftChange={handleDraftChange}
          onDraftCheckoutModeChange={handleDraftCheckoutModeChange}
          onDraftBaseRefChange={handleDraftBaseRefChange}
          onDraftTargetChange={handleDraftTargetChange}
          onDraftSubmit={(event) => void handleDraftSubmit(event)}
          onManageModels={onManageModels}
        />
      ) : (
        <>
          {draftHandoff && draftComposerRectRef.current ? (
            <SessionDraftExitEcho
              composerHeight={draftComposerRectRef.current.height}
              isChatTarget={isChatProjectId(sessionDraft?.projectId ?? "")}
              projectLabel={
                isChatProjectId(sessionDraft?.projectId ?? "")
                  ? CHAT_PICKER_LABEL
                  : projects.find(
                      (project) => project.id === sessionDraft?.projectId,
                    )?.displayName ?? null
              }
            />
          ) : null}
          {runtimeUnavailableProjection ? (
            <div
              className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 text-sm text-muted"
              data-testid="runtime-fallback-banner"
            >
              <span>
                Runtime unavailable.{" "}
                {runtimeUnavailableProjection.staleReason ??
                  "Showing read-only session data."}
              </span>
              {canRetryHistoryLoad ? (
                <Button
                  label="Retry"
                  size="sm"
                  variant="secondary"
                  onClick={retryHistory}
                />
              ) : null}
            </div>
          ) : null}
          <ChatConversation
            aria-label="Live Chat messages"
            className="pigui-draft-handoff__chat min-h-0 flex-1"
            isStreaming={liveMessages.some((message) => message.isStreaming)}
          >
            {/* Tight at the top: the pane already carries the header's own
                offset, so a second 24px band only pushed the first message
                down. The bottom keeps its distance from the composer. */}
            <ChatConversation.Content className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
              {pendingInitialPrompt && liveProjection ? (
                <LiveChatMessage
                  message={{
                    id: `${liveProjection.id}:pending-initial-prompt`,
                    role: "user",
                    body: pendingInitialPrompt,
                  }}
                />
              ) : null}
              {liveMessages.map((message) => (
                <LiveChatMessage
                  key={message.id}
                  message={withLegacyCotView(message)}
                  recovery={message.controlLabel === "Run failed" ? (
                    <ChatRunFailure error={message.body}
                      onOpenProviderSettings={onOpenProviderSettings}
                      onRetry={message.id === latestFailure?.id && canRetryRequest ? retryFailedRequest : undefined}
                      modelControl={message.id === latestFailure?.id && canRetryRequest && liveProjection?.modelControls ? (
                        <ModelSelectorControl controls={liveProjection.modelControls} isDisabled={queueMode}
                          visibleModels={visibleModels} onManageModels={onManageModels} onChange={handleModelConfigChange} />
                      ) : undefined} />
                  ) : undefined}
                  onForkMessage={
                    liveProjection?.sessionFile &&
                    liveProjection.piSessionId &&
                    getRuntimeBridge().forkSession
                      ? (forkMessage) => void handleForkMessage(forkMessage)
                      : undefined
                  }
                />
              ))}
              {history === "loading" ? (
                <p
                  aria-live="polite"
                  className="text-sm text-muted"
                  data-testid="session-history-status"
                  role="status"
                >
                  <TextShimmer>Loading history…</TextShimmer>
                </p>
              ) : null}
              {creating && liveProjection ? (
                <p
                  aria-live="polite"
                  className="text-sm text-muted"
                  data-testid="session-creation-status"
                  role="status"
                >
                  {liveProjection.creationStage}…
                </p>
              ) : null}
            </ChatConversation.Content>
          </ChatConversation>

          {creationFailure && liveProjection ? (
            <div
              className="mt-auto shrink-0 px-4 pb-3 pt-3"
              data-testid="session-creation-failure"
              role="alert"
            >
              <div className="mx-auto w-full max-w-[44rem] rounded-md border border-border bg-surface px-3 py-2 text-sm">
                <SessionCreationFailureDetail
                  failure={creationFailure}
                  action={
                    onReopenDraft ? (
                      <Button
                        label="Back to draft"
                        size="sm"
                        variant="secondary"
                        onClick={() => onReopenDraft(liveProjection)}
                      />
                    ) : undefined
                  }
                />
              </div>
            </div>
          ) : readOnlyProjection ? null : (
            <div className="pigui-draft-handoff__composer mt-auto flex shrink-0 flex-col">
            <FullChatComposer
              key={liveProjection?.id}
              isCreating={creating}
              isStoppingRun={stoppingRun}
              queueMode={queueMode}
              projection={liveProjection}
              draftBranchLabel={draftLocationOfThisSession?.branchLabel ?? null}
              draftCheckoutMode={draftLocationOfThisSession?.checkoutMode ?? null}
              sessionChanges={sessionChanges}
              onPromptSubmit={handlePromptSubmit}
              onQueueSubmit={handleQueueSubmit}
              onWithdrawQueuedMessage={handleWithdrawQueuedMessage}
              onReorderQueuedMessages={handleReorderQueuedMessages}
              onStopRun={handleStopRun}
              onSteerFromQueue={handleSteerFromQueue}
              onModelConfigChange={handleModelConfigChange}
              onManageModels={onManageModels}
            />
            </div>
          )}
        </>
      )}
    </main>
  );
}
