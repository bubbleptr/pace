import { Button } from "@astryxdesign/core/Button";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import {
  SessionDock,
  SessionDockTrigger,
  sessionDockDefaultWidthPx,
  sessionDockResizableBounds,
  useSessionDockMotionState,
  useSessionDockPresence,
} from "@/shared/ui/session-dock/session-dock";
import { SessionSurfaceBar } from "@/shared/ui/session-dock/surface-bar";
import {
  type SessionSurfaceId,
} from "@/shared/ui/session-dock/surface-registry";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SessionChangedFile, SessionChanges } from "@pace/core";
import { AppFrame, defaultSidebarProjectSessionProjections } from "@/app/app-shell";
import {
  Stop,
  FileDiff,
  RefreshCw,
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
import { SessionBrowserPanel } from "@/pages/session-browser-panel";
import { SessionFilesPanel } from "@/pages/session-files-panel";
import { SessionTerminalPanel } from "@/pages/session-terminal-panel";
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


type SessionChangesPanelProps = {
  sessionId: string | null;
  target?: SessionChangeTarget | null;
  stale: boolean;
  /** The page owns the read so the rail badge can share it (ADR-0028). */
  changes: SessionChanges | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
};


const SessionDiffViewer = lazy(
  () => import("@/entities/session/session-diff-viewer"),
);

const fixtureWorkspace: AgentWorkspaceFixture = {
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

function changeKindLabel(kind: SessionChangedFile["kind"]) {
  switch (kind) {
    case "type-changed":
      return "Type changed";
    case "conflicted":
      return "Conflict";
    default:
      return `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
  }
}

function changeStageLabel(file: SessionChangedFile) {
  if (file.kind === "untracked") return "Working tree";
  if (file.staged && file.unstaged) return "Staged + unstaged";
  if (file.staged) return "Staged";
  return "Working tree";
}

/**
 * One line of working-tree state for the Changes bar, or nothing when there is
 * none to state. A failed read says nothing here: the alert below already
 * carries the message, and a stale count beside it would contradict it.
 */
function sessionChangesStatus({
  changes,
  error,
  loading,
}: Pick<SessionChangesPanelProps, "changes" | "error" | "loading">): ReactNode {
  if (error) {
    return null;
  }

  if (!changes) {
    return loading ? "Loading…" : null;
  }

  if (changes.state === "non-git") {
    return "Not a Git repository";
  }

  // Same predicate the file list below uses, so the row and the list can never
  // disagree about whether there is anything to review.
  if (changes.state === "clean" || changes.files.length === 0) {
    return "Working tree clean";
  }

  return (
    <>
      {changes.totals.files} files ·{" "}
      <span className="text-success">+{changes.totals.additions}</span>{" "}
      <span className="text-danger">-{changes.totals.deletions}</span>
    </>
  );
}

export function SessionChangesPanel({
  sessionId,
  target,
  stale,
  changes,
  error,
  loading,
  onRefresh,
}: SessionChangesPanelProps) {
  // Fold state is the set of *closed* paths: a file the reviewer has not
  // touched is open, so a fresh read (new files included) needs no
  // bookkeeping to come up expanded, and only explicit folds are remembered.
  const [closedPaths, setClosedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  // Another Session is another review; its folds start from scratch.
  useEffect(() => {
    setClosedPaths(new Set());
    setCurrentPath(null);
  }, [sessionId]);

  // Each read yields a new object; keep folds for files that survived and let
  // the rest go so a path that comes back later is open again.
  useEffect(() => {
    if (!changes) return;

    const present = new Set(changes.files.map((file) => file.path));
    setClosedPaths((current) => {
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
    setCurrentPath((current) =>
      current !== null && present.has(current) ? current : null,
    );
  }, [changes]);

  const files = changes?.files ?? [];
  const openPaths = files
    .map((file) => file.path)
    .filter((path) => !closedPaths.has(path));
  const anyOpen = openPaths.length > 0;

  const toggleAll = () => {
    setClosedPaths(anyOpen ? new Set(files.map((file) => file.path)) : new Set());
  };

  const navigateTo = useCallback((path: string) => {
    setClosedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setCurrentPath(path);
    // The section root stays mounted while folded, so it can be scrolled to
    // before React has re-rendered the expanded body. jsdom has no
    // scrollIntoView, hence the optional call.
    const section = sectionRefs.current.get(path);
    section?.scrollIntoView?.({ block: "start" });
    // Continue keyboard navigation from the diff after an outline jump.
    section?.querySelector("button")?.focus({ preventScroll: true });
  }, []);

  const status = sessionChangesStatus({ changes, error, loading });
  const hasReview =
    Boolean(sessionId) &&
    !error &&
    changes?.state === "ready" &&
    files.length > 0;

  useEffect(() => {
    if (hasReview && target?.sessionId === sessionId) navigateTo(target.path);
  }, [hasReview, target, sessionId, navigateTo]);

  return (
    <section aria-label="Session changes" className="flex h-full min-h-0 flex-col">
      {/* The surface's first row (ADR-0028): working-tree state on the left,
          actions on the right — the slot Session-scoped checkout / commit /
          push actions (ADR-0008) will land in. A Session without a checkout
          has neither, so it gets no band at all. */}
      {sessionId ? (
        <SessionSurfaceBar
          actions={
            <>
              {hasReview ? (
                <>
                  <Button
                    className="pigui-pressable"
                    label={anyOpen ? "Collapse all" : "Expand all"}
                    size="sm"
                    variant="ghost"
                    onClick={toggleAll}
                  />
                </>
              ) : null}
              <IconButton
                className="pigui-pressable"
                icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />}
                isDisabled={loading}
                label="Refresh Session changes"
                size="sm"
                tooltip="Refresh changes"
                variant="ghost"
                onClick={onRefresh}
              />
            </>
          }
        >
          {status ? (
            <p className="min-w-0 truncate text-xs text-muted">{status}</p>
          ) : null}
        </SessionSurfaceBar>
      ) : null}

      {/* Keep scrolling and size containment below the window's header band.
          The bar must stay in the root stacking context above its drag region. */}
      <div className="@container/changes flex min-h-0 flex-1 flex-col overflow-hidden">
        {stale ? (
          <p className="mt-3 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Runtime state is stale. This diff is fresh, but the Session status may be outdated.
          </p>
        ) : null}

        {!sessionId ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes to review"
            description="Start a session in a project to review its file changes here."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : loading && !changes ? (
          <div className="mt-3 grid gap-2" aria-label="Loading Session changes">
            <div className="h-8 animate-pulse motion-reduce:animate-none bg-default/40" />
            <div className="h-24 animate-pulse motion-reduce:animate-none bg-default/30" />
          </div>
        ) : error ? (
          <div
            className="mt-3 bg-danger/5 px-3 py-3"
            role="alert"
          >
            <p className="text-sm text-danger">{error}</p>
            <Button
              className="mt-3"
              label="Retry"
              size="sm"
              variant="secondary"
              onClick={onRefresh}
            />
          </div>
        ) : changes?.state === "non-git" ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No Git repository"
            description="This session’s working directory is not a Git repository. File changes appear here for Git projects."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : changes?.state === "clean" || !changes?.files.length ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes yet"
            description="Your working tree is clean. Staged, unstaged, and new files will appear here as you work."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_min(40%,13rem)] grid-rows-[minmax(0,1fr)]">
            {/* Every diff, top to bottom: the reviewer scrolls instead of
                switching. Each section is one file; a folded one drops its
                viewer so a wide tree never keeps hundreds of renderers alive. */}
            <CollapsibleGroup
              className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-surface"
              density="compact"
              hasDividers
              type="multiple"
              value={openPaths}
              onChange={(value) => {
                const open = new Set(Array.isArray(value) ? value : [value]);
                setClosedPaths(
                  new Set(
                    files.map((file) => file.path).filter((path) => !open.has(path)),
                  ),
                );
              }}
            >
              {changes.files.map((file) => {
                const isOpen = !closedPaths.has(file.path);

                return (
                  <Collapsible
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    className="pigui-change-section shrink-0"
                    data-testid="session-change-section"
                    ref={(node) => {
                      if (node) sectionRefs.current.set(file.path, node);
                      else sectionRefs.current.delete(file.path);
                    }}
                    trigger={
                      <span className="flex w-full min-w-0 items-center gap-3 text-left">
                        <span
                          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span
                          className="hidden min-w-0 shrink truncate text-xs text-muted @sm/changes:inline"
                          title={changeStageLabel(file)}
                        >
                          {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                        </span>
                        <ChangeCounts file={file} />
                      </span>
                    }
                    value={file.path}
                  >
                    {isOpen ? (
                      <>
                        {file.kind === "conflicted" ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This file has unresolved merge conflicts. Resolve it in the
                            checkout before reviewing a normal patch.
                          </p>
                        ) : file.binary ? (
                          <EmptyState
                            className="px-4 py-6"
                            title="Diff unavailable"
                            description="Binary file changed. A textual diff is not available."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        ) : file.patchTruncated ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This patch exceeds the review limit and was omitted. Open the
                            checkout for the full diff.
                          </p>
                        ) : file.patch ? (
                          <Suspense
                            fallback={
                              <div
                                className="h-40 animate-pulse motion-reduce:animate-none bg-default/30"
                                aria-label="Loading diff renderer"
                              />
                            }
                          >
                            <SessionDiffViewer
                              cacheKey={`${changes.sessionId}:${changes.generatedAt}:${file.path}`}
                              patch={file.patch}
                              line={target?.sessionId === sessionId && target.path === file.path ? target.line : undefined}
                              style="unified"
                            />
                          </Suspense>
                        ) : (
                          <EmptyState
                            className="px-4 py-6"
                            title="No textual changes"
                            description="No textual patch is available for this file."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        )}
                      </>
                    ) : null}
                  </Collapsible>
                );
              })}
            </CollapsibleGroup>

            {/* Both columns own their scroll position, including in narrow docks. */}
            <nav
              aria-label="Changed files"
              className="flex min-h-0 min-w-0 flex-col border-l border-separator bg-surface"
            >
              <p className="shrink-0 px-2 py-1 text-xs font-medium text-muted">
                {changes.files.length} files
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {changes.files.map((file) => (
                  <button
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    data-current={file.path === currentPath ? "true" : undefined}
                    className={`w-full min-w-0 px-2 py-1.5 text-left transition-colors ${
                      file.path === currentPath
                        ? "bg-default/70 text-foreground"
                        : "text-muted hover:bg-default/40 hover:text-foreground"
                    }`}
                    type="button"
                    onClick={() => navigateTo(file.path)}
                  >
                    <span className="block truncate text-sm" title={file.path}>
                      {file.path}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate" title={changeStageLabel(file)}>
                        {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                      </span>
                      <ChangeCounts file={file} />
                    </span>
                  </button>
                ))}
              </div>
            </nav>
          </div>
        )}
        {hasReview && changes?.truncated ? (
          <p className="shrink-0 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Review is bounded. {changes.omittedFileCount > 0
              ? `${changes.omittedFileCount} additional files were omitted.`
              : "One or more oversized patches were omitted."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The +A −D tail of a file row, or what stands in for it. */
function ChangeCounts({ file }: { file: SessionChangedFile }) {
  if (file.kind === "conflicted") {
    return <span className="shrink-0 text-xs">Resolve</span>;
  }
  if (file.binary) {
    return <span className="shrink-0 text-xs">Binary</span>;
  }
  return (
    <span className="shrink-0 text-xs">
      <span className="text-success">+{file.additions ?? 0}</span>{" "}
      <span className="text-danger">-{file.deletions ?? 0}</span>
    </span>
  );
}

/** Renders the active surface inside the shared dock panel. */
function SessionSurfaceContent({
  surfaceId,
  projection,
  changeTarget,
  sessionChanges,
  docked = false,
  onTerminalInstancesChange,
  onBrowserInstancesChange,
}: {
  surfaceId: SessionSurfaceId;
  projection?: SessionProjection | null;
  changeTarget?: SessionChangeTarget | null;
  sessionChanges: SessionChangesView;
  /** Whether the surface can host a native browser view. */
  docked?: boolean;
  onTerminalInstancesChange?: (instances: TerminalInstanceInfo[]) => void;
  onBrowserInstancesChange?: (instances: import("@/shared/browser-protocol").BrowserTabState[]) => void;
}) {

  if (surfaceId === "changes") {
    return (
      <SessionChangesPanel
        target={changeTarget}
        changes={sessionChanges.changes}
        error={sessionChanges.error}
        loading={sessionChanges.loading}
        sessionId={projection?.id ?? null}
        stale={projection?.stale ?? false}
        onRefresh={sessionChanges.refresh}
      />
    );
  }

  if (surfaceId === "files") {
    // No projection means no checkout, so there is no tree to browse.
    if (!projection) {
      return null;
    }

    return <SessionFilesPanel sessionId={projection.id} />;
  }

  if (surfaceId === "terminal") {
    // No projection means no checkout, so there is nothing to host a shell in.
    if (!projection) {
      return null;
    }

    return (
      <SessionTerminalPanel
        sessionId={projection.id}
        onInstancesChange={onTerminalInstancesChange}
      />
    );
  }

  if (surfaceId === "browser") {
    // The remembered preview URL is keyed by Project, so a Session without a
    // projection has nothing to restore.
    if (!projection) {
      return null;
    }

    return (
      <SessionBrowserPanel
        docked={docked}
        projectId={projection.projectId}
        sessionId={projection.id}
        onInstancesChange={onBrowserInstancesChange}
      />
    );
  }

  return null;
}


export function SessionToolbarActions({
  dockOpen = false,
  onDockOpenChange = () => {},
}: {
  dockOpen?: boolean;
  onDockOpenChange?: (isOpen: boolean) => void;
}) {
  return <SessionDockTrigger alignToRail isOpen={dockOpen} onOpenChange={onDockOpenChange} />;
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
  projectId = fixtureWorkspace.id,
  showDraft = false,
  workspace = fixtureWorkspace,
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
  projectId?: string;
  showDraft?: boolean;
  workspace?: AgentWorkspaceFixture;
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
