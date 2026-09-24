import { HStack } from "@astryxdesign/core/HStack";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import {
  SessionDock,
  sessionDockDefaultWidthPx,
  sessionDockResizableBounds,
  useSessionDockMotionState,
  useSessionDockPresence,
} from "@/shared/ui/session-dock/session-dock";
import {
  type SessionSurfaceId,
} from "@/shared/ui/session-dock/surface-registry";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { AppFrame } from "@/widgets/app-frame";
import { defaultSidebarProjectSessionProjections } from "@/dev/fixtures/agent-workspace";
import {
  Stop,
} from "@/shared/ui/icons";
import {
  shouldUseBrowserDevelopmentData,
} from "@/shared/browser-development-data";
import {
  createExecutionCheckoutManager,
  type ExecutionCheckoutManager,
} from "@/entities/checkout/execution-checkout";
import { createInvokeExecutionCheckoutGitClient } from "@/entities/checkout/execution-checkout-client";
import {
  getProjectGitSummary,
} from "@/entities/project/project-git";
import {
  CHAT_PROJECT_ID,
  chatWorkspaceListEntry,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import { type ProjectRegistryEntry } from "@/entities/project/project-registry";
import { useVisibleProjectRegistry } from "@/entities/project/visible-registry";
import { createDefaultPiRuntimeBridge } from "@/entities/runtime/pi-runtime-factory";
import {
  type ExecutionCheckout,
  type PiRuntimeBridge,
} from "@/entities/runtime/pi-runtime-bridge";
import {
  createSessionFromDraft,
} from "@/entities/session/session-creation";
import {
  ensureSessionDraft,
  getSessionDraft,
  saveSessionDraft,
} from "@/entities/session/session-drafts";
import {
  getSessionProjectionListItems,
  type SessionProjection,
} from "@/entities/session/session-projection";
import {
  sessionChangesBadge,
  useSessionChanges,
  type SessionChangesView,
} from "@/entities/session/use-session-changes";
import {
  findSessionChangeTarget,
  parseSessionChangeLink,
  type SessionChangeLink,
  type SessionChangeTarget,
} from "@/entities/session/session-change-link";
import type { TerminalInstanceInfo } from "@/entities/terminal/terminal-client";
import { useSettingsDialog } from "@/shared/settings-navigation";
import {
  SessionProjectionsStoreProvider,
  sessionProjectionFromPersistedProjection,
  useSessionProjections,
  useSessionProjectionsStoreOptional,
} from "@/entities/session/use-session-projections";
import {
  createSessionProjectionsStore,
} from "@/entities/session/session-projections-store";
import {
  type SessionDraftSubmitEvent,
} from "@/features/session-draft";
import {
  LiveSessionColumn,
  type AgentWorkspaceFixture,
  type SessionCreator,
  type SessionCreatorInput,
} from "@/widgets/live-chat";
import { SessionSurfaceContent, SessionToolbarActions } from "@/widgets/session-dock";

function workspaceFromProject(project: ProjectRegistryEntry): AgentWorkspaceFixture {
  return {
    id: project.id,
    name: project.displayName,
    projectRoot: project.path,
    repoRoot: project.path,
    selectedSessionId: null,
    liveMessages: [],
    runTimeline: [],
    checkout: {
      mode: "Foreground local checkout",
      root: project.path,
      runtimeCwd: project.path,
    },
    summary: {
      model: "Unknown",
      totalCostUsd: 0,
      totalTokens: 0,
    },
  };
}

/**
 * What the resize handle takes out of the width Chat and the panel share: only
 * the 1px divider it draws between them. Its 16px grab zone and pill are
 * absolutely positioned over both panes, so they cost no layout width.
 */
const resizeHandleGutterPx = 1;

/**
 * The 40px row under the fixed header chrome on the Chat side. The dock
 * fills the same band with its own header; the hairline under both is drawn
 * once by the sessions view.
 */
function TitlebarBand() {
  return (
    <div
      aria-hidden="true"
      className="h-10 shrink-0"
      data-testid="session-workspace-titlebar-band"
    />
  );
}

export function AgentWorkspaceSessionsView({
  projectId,
  showDraft = false,
  workspace,
  aside,
  asideOpen = true,
  onDraftSubmit = () => {},
  onSessionCreationStarted,
  onSessionCreated,
  onReopenDraft,
  sessionCreator,
  checkoutManager,
  runtimeBridge,
  sessionId,
  sessionProjection,
  sessionChanges,
  clockNowMs,
  loadProjectGitSummary,
  onManageModels,
  onOpenProviderSettings,
}: {
  projectId: string;
  showDraft?: boolean;
  workspace: AgentWorkspaceFixture;
  aside?: ReactNode;
  /** False while the dock plays its exit; the pane closes on the same clock. */
  asideOpen?: boolean;
  onDraftSubmit?: (event: SessionDraftSubmitEvent) => void;
  onSessionCreationStarted?: (projection: SessionProjection) => void;
  onSessionCreated?: (projection: SessionProjection) => void;
  onReopenDraft?: (projection: SessionProjection) => void;
  sessionCreator?: SessionCreator;
  checkoutManager?: ExecutionCheckoutManager;
  runtimeBridge?: PiRuntimeBridge;
  /** The Session on screen, read from the Session Projections store. */
  sessionId?: string | null;
  /**
   * Test seam for views rendered without a store provider: seeds the view's
   * own store with this Session (once per id) and shows it when `sessionId`
   * is absent.
   */
  sessionProjection?: SessionProjection | null;
  sessionChanges?: SessionChangesView;
  clockNowMs?: number;
  /** Test seam for the Session Draft's Project-level Git read. */
  loadProjectGitSummary?: typeof getProjectGitSummary;
  onManageModels?: () => void;
  onOpenProviderSettings?: () => void;
}) {
  const [getDefaultRuntimeBridge] = useState(() => {
    let bridge: PiRuntimeBridge | null = null;

    return () => {
      bridge ??= createDefaultPiRuntimeBridge();

      return bridge;
    };
  });
  const getActiveRuntimeBridge = runtimeBridge
    ? () => runtimeBridge
    : getDefaultRuntimeBridge;
  const storeContext = useSessionProjectionsStoreOptional();
  // Views rendered without the app provider (isolated view tests) still need
  // a store to read from and for creation and fork to write through.
  const [fallbackProjectionsStore] = useState(() => {
    if (storeContext) return null;

    const store = createSessionProjectionsStore({
      bridge: getActiveRuntimeBridge(),
      listSessions: async () => [],
    });
    // Seeded before the first render so a synchronous test sees the Session.
    if (sessionProjection) store.insert(sessionProjection);
    return store;
  });
  const projectionsStore = storeContext?.store ?? fallbackProjectionsStore!;

  useEffect(() => {
    if (fallbackProjectionsStore && sessionProjection && !fallbackProjectionsStore.get(sessionProjection.id)) {
      fallbackProjectionsStore.insert(sessionProjection);
    }
  }, [fallbackProjectionsStore, sessionProjection]);
  const [defaultCheckoutManager] = useState(() =>
    createExecutionCheckoutManager({
      gitClient: createInvokeExecutionCheckoutGitClient(),
    }),
  );
  const activeCheckoutManager = checkoutManager ?? defaultCheckoutManager;
  const defaultSessionCreator: SessionCreator = (input: SessionCreatorInput) =>
    createSessionFromDraft({
      ...input,
      bridge: getActiveRuntimeBridge(),
      checkoutManager: activeCheckoutManager,
      executionMode: input.executionMode ?? "foreground",
    });
  const liveSessionColumn = (
    <LiveSessionColumn
      projectId={projectId}
      showDraft={showDraft}
      workspace={workspace}
      onDraftSubmit={onDraftSubmit}
      onSessionCreationStarted={onSessionCreationStarted}
      onSessionCreated={onSessionCreated}
      onReopenDraft={onReopenDraft}
      sessionCreator={sessionCreator ?? defaultSessionCreator}
      checkoutManager={activeCheckoutManager}
      getRuntimeBridge={getActiveRuntimeBridge}
      projectionsStore={projectionsStore}
      recommendedCheckoutMode="local"
      sessionId={sessionId !== undefined ? sessionId : sessionProjection?.id ?? null}
      sessionChanges={sessionChanges}
      clockNowMs={clockNowMs}
      loadProjectGitSummary={loadProjectGitSummary}
      onManageModels={onManageModels}
      onOpenProviderSettings={onOpenProviderSettings}
    />
  );
  const liveSession = storeContext ? liveSessionColumn : (
    <SessionProjectionsStoreProvider store={projectionsStore} runtimeGeneration={0}>
      {liveSessionColumn}
    </SessionProjectionsStoreProvider>
  );
  // The panel's ceiling is whatever Chat's minimum does not need, so it has to
  // follow the split container rather than resolve once at mount.
  const [splitElement, setSplitElement] = useState<HTMLDivElement | null>(null);
  const [splitWidth, setSplitWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1280,
  );

  useEffect(() => {
    if (!splitElement || typeof window === "undefined") {
      return;
    }

    const measure = () => setSplitWidth(splitElement.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(splitElement);

    return () => observer.disconnect();
  }, [splitElement]);

  const asideSizeBounds = sessionDockResizableBounds(
    Math.max(0, splitWidth - resizeHandleGutterPx),
  );
  const asideResizable = useResizable({
    defaultSize: sessionDockDefaultWidthPx,
    minSizePx: asideSizeBounds.minSizePx,
    maxSizePx: asideSizeBounds.maxSizePx,
  });
  const { resize: resizeAside, size: asideSize } = asideResizable;
  // The split view mounts with the dock, so a mount always plays the enter.
  const asideMotion = useSessionDockMotionState(asideOpen, true);

  // `useResizable` clamps each drag against the current bounds but keeps the
  // size it already holds, so a window that shrank under the panel has to be
  // given its room back explicitly.
  useEffect(() => {
    if (asideSize > asideSizeBounds.maxSizePx) {
      resizeAside(asideSizeBounds.maxSizePx);
    }
  }, [asideSize, asideSizeBounds.maxSizePx, resizeAside]);

  return (
    <article
      className="relative -mt-10 flex h-[calc(100%+2.5rem)] min-h-0 min-w-0 flex-col overflow-hidden pb-0"
      data-testid="project-sessions-view"
    >
      {/* One hairline under the titlebar band for the whole view. Drawn once
          here rather than per column so it does not break at the resize
          handle between Chat and the dock. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-10 z-10 h-px bg-separator"
        data-testid="session-workspace-titlebar-rule"
      />
      {/* Both layouts span the full width: Chat centers itself via its own
          max-width, so an outer centered box would only strand the docked
          dock's rail (ADR-0028) and Chat's scrollbar short of the
          window edge. */}
      {aside ? (
        <div
          className="flex h-full min-h-0 w-full flex-row"
          data-slot="resizable"
          data-testid="session-workspace-split-view"
          ref={setSplitElement}
        >
          <div
            className="h-full min-h-0 min-w-0 flex-1"
            data-slot="resizable-panel"
          >
            <div
              className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
              data-testid="session-workspace-main-pane"
            >
              <TitlebarBand />
              <div className="min-h-0 flex-1">{liveSession}</div>
            </div>
          </div>
          <ResizeHandle
            direction="horizontal"
            hasDivider
            isReversed
            label="Resize Session dock"
            // Astryx 0.3.0 `hitAreaOffsetX` carries a `-50%` Y translate meant
            // for vertical handles, so a side-biased pill shifts the grab zone
            // up by half its height and only the divider's top half is
            // draggable. Centering the pill skips that offset entirely.
            pillPlacement="center"
            resizable={asideResizable.props}
          />
          {/* Width, not transform, on purpose: the divider and Chat's column
              have to move with the dock's edge, and only a layout change
              does that. It runs solely while the dock is in motion, so drags
              stay 1:1; the inner box keeps the full width so the sliding
              content is clipped, never squeezed. */}
          <div
            className="pigui-session-dock-pane h-full min-h-0 shrink-0"
            data-motion={asideMotion.moving ? "true" : undefined}
            data-open={asideOpen ? "true" : "false"}
            data-slot="resizable-panel"
            style={
              {
                "--pigui-session-dock-width": `${asideResizable.size}px`,
              } as CSSProperties
            }
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) {
                asideMotion.settle();
              }
            }}
          >
            <div
              className="h-full min-h-0 overflow-hidden"
              data-testid="session-workspace-aside-pane"
              style={{ width: asideResizable.size }}
            >
              {aside}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 w-full flex-col">
          <TitlebarBand />
          <div className="min-h-0 flex-1">{liveSession}</div>
        </div>
      )}
    </article>
  );
}

export function AgentWorkspaceSessionsPage() {
  const navigate = useNavigate();
  const { openSettings } = useSettingsDialog();
  const { projectId } = useParams({ from: "/projects/$projectId/sessions" });
  const showDraft = useRouterState({
    select: (state) => {
      const search = state.location.search as { view?: string };

      return search.view === "draft";
    },
  });
  const [browserDevelopmentData] = useState(() =>
    shouldUseBrowserDevelopmentData(),
  );
  const registryProjects = useVisibleProjectRegistry();
  const {
    sessionProjections,
    sessionsHydrated,
    store: projectionsStore,
    runtimeBridge,
  } = useSessionProjections();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Browser/vitest fixture sessions live in the same app-wide store as Electron hydrate.
  useEffect(() => {
    if (!browserDevelopmentData) {
      return;
    }

    if (projectionsStore.list().length > 0) {
      return;
    }
    // `insert` puts each Session first; reverse to keep the fixture order.
    for (const projection of [...defaultSidebarProjectSessionProjections].reverse()) {
      projectionsStore.insert(projection);
    }
  }, [browserDevelopmentData, projectionsStore]);
  // Shell count for the Terminal rail badge, reported up by the Terminal
  // surface while it is mounted; reset per Session below.
  const [terminalInstanceCount, setTerminalInstanceCount] = useState(0);
  const [browserInstanceCount, setBrowserInstanceCount] = useState(0);
  // Open state and the active surface are Workspace-level, so switching
  // Sessions keeps the dock where the user left it.
  const [dockOpen, setDockOpen] = useState(false);
  // Terminal/Browser own live pty / WebContentsView instances, so the closed
  // dock cannot stay mounted; keep it only through the exit transition.
  const dockMounted = useSessionDockPresence(dockOpen);
  const [activeSurfaceId, setActiveSurfaceId] =
    useState<SessionSurfaceId>("changes");
  const [pendingChangeLink, setPendingChangeLink] = useState<{
    sessionId: string;
    link: SessionChangeLink;
  } | null>(null);
  const [changeTarget, setChangeTarget] = useState<SessionChangeTarget | null>(null);
  const project = isChatProjectId(projectId)
    ? chatWorkspaceListEntry()
    : registryProjects.find((candidate) => candidate.id === projectId) ?? null;
  const workspace = project ? workspaceFromProject(project) : null;
  const selectedSessionProjection =
    sessionProjections.find(
      (projection) =>
        projection.id === selectedSessionId && projection.projectId === projectId,
    ) ?? null;
  const emptyChatDraft =
    registryProjects.length === 0 &&
    isChatProjectId(projectId) &&
    showDraft &&
    !sessionProjections.some((projection) => isChatProjectId(projection.projectId));
  // One read for the composer git-branch chip, the Changes panel, and the
  // rail badge. The docked rail carries the Changes count whatever surface
  // is showing, so it needs the diff even on Terminal. The composer footer
  // needs the branch whenever a live Session is on screen, which is why this
  // is no longer gated on the dock being open.
  // Draft handoff precedes worktree creation; the backend projection is only
  // queryable once create_session returns and the runtime is bound.
  const sessionChanges = useSessionChanges({
    sessionId: selectedSessionProjection?.id ?? null,
    enabled:
      Boolean(selectedSessionProjection?.piSessionId) &&
      !showDraft &&
      !isChatProjectId(projectId),
  });

  // Resolve only after the click's fresh read. The initial composer read may
  // predate this run's edits; matching it would silently miss newly changed files.
  useEffect(() => {
    if (!pendingChangeLink) return;
    if (showDraft || pendingChangeLink.sessionId !== selectedSessionProjection?.id) {
      setPendingChangeLink(null);
      return;
    }
    if (sessionChanges.loading || sessionChanges.refreshing) return;
    const target = sessionChanges.changes
      ? findSessionChangeTarget(
          pendingChangeLink.link,
          sessionChanges.changes,
          selectedSessionProjection.checkout?.diffRoot ?? selectedSessionProjection.cwd ?? undefined,
        )
      : null;
    setPendingChangeLink(null);
    if (target) {
      setChangeTarget(target);
      setActiveSurfaceId("changes");
      setDockOpen(true);
    }
  }, [pendingChangeLink, sessionChanges.changes, sessionChanges.loading, sessionChanges.refreshing, selectedSessionProjection, showDraft]);

  useEffect(() => {
    setTerminalInstanceCount(0);
    setBrowserInstanceCount(0);
    setChangeTarget(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (registryProjects.length > 0 || isChatProjectId(projectId)) {
      return;
    }

    if (!getSessionDraft()) ensureSessionDraft(CHAT_PROJECT_ID);
    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: CHAT_PROJECT_ID },
      search: { view: "draft" } as never,
      replace: true,
      resetScroll: false,
    });
  }, [navigate, projectId, registryProjects.length]);

  // After hydrate (or when project sessions appear), select the first valid session.
  useEffect(() => {
    if (selectedSessionId) {
      return;
    }

    const nextSessionId = firstSessionIdForProject(sessionProjections, projectId);
    if (nextSessionId) {
      setSelectedSessionId(nextSessionId);
    }
  }, [projectId, selectedSessionId, sessionProjections]);

  useEffect(() => {
    if (!selectedSessionProjection) {
      setDockOpen(false);
    }
  }, [selectedSessionProjection?.id]);

  // Selection changes are explicit — sidebar clicks, the first-session
  // fallback, and Session takeovers — never a store update: the store also
  // advances Sessions the user is not viewing.
  // The Live Session takes over as soon as the `creating` projection exists:
  // waiting for Pi to accept the prompt left the draft on screen for as long
  // as extensions held the user-message boundary. Also fires on success so a
  // retargeted draft lands on its Project route.
  const enterLiveSession = (projection: SessionProjection) => {
    setSelectedSessionId(projection.id);
    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: projection.projectId },
      search: ((previous: Record<string, unknown>) => {
        const { view: _view, ...search } = previous;
        return search;
      }) as never,
      hash: true,
      replace: true,
      resetScroll: false,
    });
  };
  const handleReopenDraft = (projection: SessionProjection) => {
    if (!getSessionDraft()?.prompt.trim()) {
      saveSessionDraft(projection.projectId, projection.initialPrompt);
    }

    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: projection.projectId },
      search: { view: "draft" } as never,
      resetScroll: false,
    });
  };
  const handleTerminalInstancesChange = (instances: TerminalInstanceInfo[]) => {
    setTerminalInstanceCount(instances.length);
  };

  if (!workspace) {
    return (
      <AppFrame
        sessionProjections={sessionProjections}
        sessionsHydrated={sessionsHydrated}
        selectedSessionId={null}
        onSelectedSessionIdChange={setSelectedSessionId}
      >
        {registryProjects.length === 0 ? null : (
          <section
            className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center px-6 text-center"
            data-testid="project-not-found-state"
          >
            <h2 className="text-lg font-semibold text-foreground">Project not found</h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
              Choose an existing Project from the sidebar.
            </p>
          </section>
        )}
      </AppFrame>
    );
  }

  return (
    <AppFrame
      sessionProjections={sessionProjections}
      sessionsHydrated={sessionsHydrated}
      selectedSessionId={selectedSessionId}
      onSelectedSessionIdChange={setSelectedSessionId}
      toolbarActions={!showDraft && selectedSessionProjection ? (
        <SessionToolbarActions
          dockOpen={dockOpen}
          onDockOpenChange={setDockOpen}
        />
      ) : undefined}
    >
      <div
        className="flex h-full min-h-0 min-w-0 flex-col"
        data-testid={emptyChatDraft ? "empty-workspace-state" : undefined}
        onClick={(event) => {
          // Delegate within Chat only, covering settled and streaming Markdown
          // without coupling the shared renderer to Session/Dock state.
          if (event.defaultPrevented || showDraft || !selectedSessionProjection?.piSessionId || isChatProjectId(projectId)) return;
          const anchor = event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('[data-slot="chat-conversation"] a[href]')
            : null;
          const cwd = selectedSessionProjection.checkout?.runtimeCwd ?? selectedSessionProjection.cwd;
          const link = anchor && cwd ? parseSessionChangeLink(anchor.getAttribute("href")!, cwd) : null;
          if (!link) return;
          event.preventDefault();
          setChangeTarget(null);
          setPendingChangeLink({ sessionId: selectedSessionProjection.id, link });
          sessionChanges.refresh();
        }}
      >
      <AgentWorkspaceSessionsView
        sessionChanges={sessionChanges}
        asideOpen={!showDraft && dockOpen}
        aside={
          !showDraft && dockMounted ? (
            <SessionDock
              activeSurfaceId={activeSurfaceId}
              badges={{
                changes: sessionChangesBadge(sessionChanges.changes),
                terminal:
                  terminalInstanceCount > 0 ? String(terminalInstanceCount) : undefined,
                browser: browserInstanceCount > 0 ? String(browserInstanceCount) : undefined,
              }}
              mountMotion
              isOpen={dockOpen}
              onActiveSurfaceChange={setActiveSurfaceId}
            >
              <SessionSurfaceContent
                docked
                changeTarget={changeTarget}
                sessionChanges={sessionChanges}
                surfaceId={activeSurfaceId}
                projection={selectedSessionProjection}
                onTerminalInstancesChange={handleTerminalInstancesChange}
                onBrowserInstancesChange={(tabs) => setBrowserInstanceCount(tabs.length)}
              />
            </SessionDock>
          ) : undefined
        }
        projectId={projectId}
        showDraft={showDraft}
        workspace={workspace}
        runtimeBridge={runtimeBridge}
        sessionId={selectedSessionProjection?.id ?? null}
        onSessionCreationStarted={enterLiveSession}
        onSessionCreated={enterLiveSession}
        onReopenDraft={handleReopenDraft}
        onManageModels={() => openSettings("models")}
        onOpenProviderSettings={() => openSettings("providers")}
      />
      </div>
    </AppFrame>
  );
}

function firstSessionIdForProject(
  projections: SessionProjection[],
  projectId: string,
) {
  return (
    getSessionProjectionListItems(
      projections.filter((projection) => projection.projectId === projectId),
    )[0]?.id ?? null
  );
}
