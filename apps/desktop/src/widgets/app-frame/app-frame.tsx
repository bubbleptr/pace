import { useRouter, useRouterState } from "@tanstack/react-router";
import { useSettingsDialog } from "@/shared/settings-navigation";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import {
  AnimatedChartPie,
  AnimatedHistory,
  MoreHorizontal,
  AnimatedNewChat,
  Plus,
  AnimatedPuzzle,
  AnimatedSettings,
  AnimatedSidebar,
  Archive,
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FolderOpenState,
  Palette,
  Pencil,
  Trash2,
} from "@/shared/ui/icons";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CHAT_PROJECT_ID,
  CHAT_WORKSPACE_DISPLAY_NAME,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import {
  addProjectToRegistry,
  renameProjectInRegistry,
  removeProjectFromRegistry,
  type ProjectRegistryEntry,
} from "@/entities/project/project-registry";
import { useVisibleProjectRegistry } from "@/entities/project/visible-registry";
import {
  hasFollowUpDraft,
  subscribeFollowUpDrafts,
} from "@/entities/session/follow-up-drafts";
import {
  ensureSessionDraft,
  getSessionDraft,
  setSessionDraftTarget,
} from "@/entities/session/session-drafts";
import {
  getSessionProjectionListItems,
  type SessionProjection,
  type SessionProjectionListItem,
} from "@/entities/session/session-projection";
import {
  archiveSessionProjection,
  deleteSessionProjection,
  formatSessionListTime,
  renameSessionProjection,
} from "@/entities/session/sessions";
import { useSessionProjectionsOptional } from "@/entities/session/use-session-projections";
import { useUpdateStatus } from "@/entities/update/use-update-status";
import { shouldUseBrowserDevelopmentData } from "@/shared/browser-development-data";
import { defaultSidebarProjectSessionProjections } from "@/dev/fixtures/agent-workspace";
import { DotMatrix } from "@/shared/ui/dot-matrix";
import {
  checkProjectDirectories,
  revealProjectInFinder,
  selectProjectDirectory,
} from "@/shared/runtime";
import { useRefreshOnWindowFocus } from "@/shared/refresh";

type AppFrameProps = {
  sidebar?: ReactNode;
  /**
   * When false, render only the window titlebar chrome + content (no app sidebar).
   * Used by first-run preflight: needs traffic-light titlebar, not navigation.
   */
  showSidebar?: boolean;
  toolbarActions?: ReactNode;
  /** Pane headers that occupy the titlebar band instead of the default page title. */
  headerContent?: ReactNode;
  sessionProjections?: SessionProjection[];
  /** False until first successful projection list (or intentional empty after retries). */
  sessionsHydrated?: boolean;
  selectedSessionId?: string | null;
  onSelectedSessionIdChange?: (sessionId: string | null) => void;
  children: ReactNode;
};

const trajectoryUsageNavigationItems = [
  {
    label: "Trajectory",
    to: "/trajectory",
    icon: AnimatedHistory,
    isActive: (pathname: string) =>
      pathname === "/trajectory" || pathname.startsWith("/sessions/"),
  },
  {
    label: "Usage",
    to: "/usage",
    icon: AnimatedChartPie,
    isActive: (pathname: string) => pathname === "/usage",
  },
  {
    label: "Packages",
    to: "/packages",
    icon: AnimatedPuzzle,
    isActive: (pathname: string) => pathname === "/packages",
  },
] as const;

const systemNavigationItems = [
  // Dev-only design gallery entry; DEV folds to false in production builds
  // so the item never ships.
  ...(import.meta.env.DEV
    ? [
        {
          label: "Design",
          to: "/design",
          icon: Palette,
          isActive: (pathname: string) => pathname === "/design",
        },
      ]
    : []),
  {
    label: "Settings",
    to: "/settings",
    icon: AnimatedSettings,
    isActive: (pathname: string) =>
      pathname === "/settings" || pathname.startsWith("/settings/"),
  },
] as const;

const sidebarDefaultSize = "260px";
const projectExpansionStorageKey = "pigui.projectSidebar.expanded.v1";

const titlebarHeight = "40px";
// The SideNav header slot wraps this spacer with 8px block padding on each
// side, so it only covers the titlebar height the slot doesn't already fill.
const sidebarTitlebarSpacerStyle = {
  height: "24px",
} as CSSProperties;
const titlebarControlStyle = {
  width: "28px",
  height: "28px",
} as CSSProperties;
const trafficWidth = "88px";
const chromeSafeLeft = "132px";
const sidebarAnimationMs = 220;

function getActiveTab(pathname: string) {
  if (pathname === "/") {
    return "New Chat";
  }

  if (pathname.startsWith("/projects/chat/")) {
    return CHAT_WORKSPACE_DISPLAY_NAME;
  }

  if (pathname.startsWith("/projects/")) {
    return "Chat";
  }

  if (pathname === "/trajectory" || pathname.startsWith("/sessions/")) {
    return "Trajectory";
  }

  if (pathname === "/usage") {
    return "Usage";
  }

  if (pathname === "/packages") {
    return "Packages";
  }

  if (pathname === "/preflight") {
    return "Preflight";
  }

  if (pathname === "/design") {
    return "Design";
  }

  return "Settings";
}

function SidebarNavDot({ label }: { label: string }) {
  return (
    <span
      aria-label={label}
      className="size-2 rounded-full bg-primary"
      role="img"
    />
  );
}

function SidebarSessionGlyph({
  active,
  unread,
}: {
  active: boolean;
  unread: boolean;
}) {
  if (active) {
    return (
      <DotMatrix aria-label="Active run" className="text-primary" />
    );
  }

  if (unread) {
    return <SidebarNavDot label="Unread result" />;
  }

  return null;
}

function SessionGlyphSlot({
  active,
  unread,
}: {
  active: boolean;
  unread: boolean;
}) {
  return (
    <span className="pigui-session-glyph" data-testid="session-glyph">
      <SidebarSessionGlyph active={active} unread={unread} />
    </span>
  );
}

function UnsentFollowUpIndicator() {
  return (
    <span
      aria-label="Unsent follow-up"
      className="inline-flex size-4 items-center justify-center text-primary"
      role="img"
    >
      <Pencil aria-hidden="true" className="size-3" />
    </span>
  );
}

function ProjectExpansionIndicator({
  expanded,
  icon,
}: {
  expanded: boolean;
  icon?: typeof FolderClosed;
}) {
  const StateIcon = icon ?? (expanded ? FolderOpenState : FolderClosed);

  return (
    <span
      aria-hidden="true"
      className="pigui-project-expansion-indicator"
      data-expanded={expanded ? "true" : "false"}
    >
      <StateIcon className="pigui-project-expansion-indicator__state" />
      <ChevronRight className="pigui-project-expansion-indicator__chevron" />
    </span>
  );
}

function SidebarSessionRows({
  sessions,
  sessionsHydrated,
  selectedSessionId,
  groupRouteActive,
  draftViewActive,
  sessionProjectId,
  onOpenSession,
  onOpenTrajectory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: {
  sessions: SessionProjectionListItem[];
  sessionsHydrated: boolean;
  selectedSessionId: string | null;
  groupRouteActive: boolean;
  draftViewActive: boolean;
  sessionProjectId: string;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onOpenTrajectory: (piSessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  return (
    <>
      {sessions.length === 0 ? (
        <SideNavItem
          icon={<SessionGlyphSlot active={false} unread={false} />}
          isDisabled
          label={sessionsHydrated ? "No chats" : "Loading chats"}
        />
      ) : null}
      {sessions.map((session) => {
        const hasSessionUnsentFollowUp = hasFollowUpDraft(session.id);

        return (
          // Same overlay-sibling pattern as the project row: the actions
          // menu cannot live inside the SideNavItem <button>.
          <div
            key={session.id}
            className="pigui-sidenav-row-with-actions pigui-sidenav-session-row"
            data-testid="session-row-with-actions"
          >
            <SideNavItem
              icon={<SessionGlyphSlot active={session.active} unread={session.unread} />}
              isSelected={
                !draftViewActive && groupRouteActive && session.id === selectedSessionId
              }
              label={session.title}
              endContent={
                <HStack
                  className="pigui-sidenav-session-meta"
                  gap={1}
                  vAlign="center"
                >
                  {hasSessionUnsentFollowUp ? <UnsentFollowUpIndicator /> : null}
                  <span className="text-muted text-[10px] leading-none">
                    {formatSessionListTime(session.updatedAt)}
                  </span>
                </HStack>
              }
              onClick={() => onOpenSession(session.id, sessionProjectId)}
            />
            <HStack
              className="pigui-sidenav-row-actions pigui-sidenav-hover-actions"
              gap={0.5}
              vAlign="center"
            >
              <SessionActionsMenu
                session={session}
                onOpenTrajectory={onOpenTrajectory}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
              />
            </HStack>
          </div>
        );
      })}
    </>
  );
}

function SidebarSessionGroupBody({
  rowTestId,
  expanded,
  onToggle,
  icon,
  label,
  sessions,
  sessionsHydrated,
  selectedSessionId,
  groupRouteActive,
  draftViewActive,
  sessionProjectId,
  onOpenSession,
  onOpenTrajectory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  hasUnsentFollowUp,
  trailingActions,
  missingDirectoryPath,
}: {
  rowTestId: string;
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  sessions: SessionProjectionListItem[];
  sessionsHydrated: boolean;
  selectedSessionId: string | null;
  groupRouteActive: boolean;
  draftViewActive: boolean;
  sessionProjectId: string;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onOpenTrajectory: (piSessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  hasUnsentFollowUp: boolean;
  trailingActions: ReactNode;
  /** Set when the group's project root no longer exists on disk. */
  missingDirectoryPath?: string;
}) {
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="pigui-sidenav-row-with-actions"
      data-directory-missing={missingDirectoryPath ? "true" : undefined}
      data-testid={rowTestId}
    >
      {missingDirectoryPath ? (
        // Anchored to the header button only, so hovering the nested
        // session rows does not raise it.
        <Tooltip
          anchorRef={headerRef}
          content={`Project directory not found: ${missingDirectoryPath}`}
        />
      ) : null}
      <SideNavItem
        ref={headerRef}
        collapsible={{
          isCollapsed: !expanded,
          onCollapsedChange: onToggle,
        }}
        icon={icon}
        label={label}
        // A <button> row cannot contain the interactive actions
        // (astryx-migration issue 01); this only reserves their width
        // so the label truncates before the overlay.
        endContent={<span aria-hidden="true" className="pigui-sidenav-actions-spacer" />}
      >
        <SidebarSessionRows
          sessions={sessions}
          sessionsHydrated={sessionsHydrated}
          selectedSessionId={selectedSessionId}
          groupRouteActive={groupRouteActive}
          draftViewActive={draftViewActive}
          sessionProjectId={sessionProjectId}
          onOpenSession={onOpenSession}
          onOpenTrajectory={onOpenTrajectory}
          onRenameSession={onRenameSession}
          onArchiveSession={onArchiveSession}
          onDeleteSession={onDeleteSession}
        />
      </SideNavItem>
      <HStack className="pigui-sidenav-row-actions" gap={0.5} vAlign="center">
        {!expanded && hasUnsentFollowUp ? <UnsentFollowUpIndicator /> : null}
        <HStack className="pigui-sidenav-hover-actions" gap={0.5} vAlign="center">
          {trailingActions}
        </HStack>
      </HStack>
    </div>
  );
}

function projectRoute(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/sessions`;
}

function projectIdFromRoute(pathname: string, projects: ProjectRegistryEntry[]) {
  const match = /^\/projects\/(.+)\/sessions$/.exec(pathname);

  if (!match) {
    return null;
  }

  const projectId = decodeURIComponent(match[1]);

  if (isChatProjectId(projectId)) {
    return projectId;
  }

  return projects.some((project) => project.id === projectId) ? projectId : null;
}

function readProjectExpansionState(): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(projectExpansionStorageKey);

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, boolean>;

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => {
        const [projectId, expanded] = entry;

        return typeof projectId === "string" && typeof expanded === "boolean";
      }),
    );
  } catch {
    return {};
  }
}

function writeProjectExpansionState(expandedProjects: Record<string, boolean>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(projectExpansionStorageKey, JSON.stringify(expandedProjects));
}

/** Keep clicks on row-embedded actions from also toggling/activating the row. */
function stopRowActivation(event: ReactMouseEvent) {
  event.stopPropagation();
}

function AddProjectButton({
  onAddProject,
}: {
  onAddProject: (path: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);

  const chooseProject = async () => {
    if (choosing) {
      return;
    }

    setChoosing(true);
    try {
      const selectedPath = await selectProjectDirectory();
      const candidate = selectedPath?.trim();

      if (candidate) {
        onAddProject(candidate);
      }
    } finally {
      setChoosing(false);
    }
  };

  return (
    <IconButton
      icon={<Plus aria-hidden="true" />}
      isDisabled={choosing}
      label="Add Project"
      tooltip="Add Project"
      size="sm"
      variant="ghost"
      onClick={() => void chooseProject()}
    />
  );
}

function ProjectActionsMenu({
  project,
  onRenameProject,
  onRevealProject,
  onRemoveProject,
}: {
  project: ProjectRegistryEntry;
  onRenameProject: (projectId: string) => void;
  onRevealProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
}) {
  return (
    <MoreMenu
      icon={<MoreHorizontal aria-hidden="true" />}
      label={`Project actions for ${project.displayName}`}
      size="sm"
      items={[
        {
          label: "Rename Project",
          icon: <Pencil aria-hidden="true" />,
          onClick: () => onRenameProject(project.id),
        },
        {
          label: "Reveal in Finder",
          icon: <FolderOpen aria-hidden="true" />,
          onClick: () => onRevealProject(project.id),
        },
        // Destructive action separated from safe actions; Astryx MoreMenu has
        // no destructive item variant yet, so a divider carries the intent.
        { type: "divider" },
        {
          label: "Remove Project...",
          icon: <Trash2 aria-hidden="true" />,
          onClick: () => onRemoveProject(project.id),
        },
      ]}
    />
  );
}

function SessionActionsMenu({
  session,
  onOpenTrajectory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: {
  session: SessionProjectionListItem;
  onOpenTrajectory: (piSessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  const piSessionId = session.projection.piSessionId;

  return (
    // DropdownMenu instead of MoreMenu: MoreMenu hard-wires its label into a
    // trigger tooltip, and the hover-revealed row button should carry none.
    <DropdownMenu
      hasChevron={false}
      button={{
        icon: <MoreHorizontal aria-hidden="true" />,
        isIconOnly: true,
        label: `Session actions for ${session.title}`,
        size: "sm",
        variant: "ghost",
      }}
      items={[
        // Trajectory replays the Pi session file, so the entry only exists
        // once the Session has one (a draft or still-creating Session has none).
        ...(piSessionId
          ? [
              {
                label: "Open Trajectory",
                icon: <AnimatedHistory aria-hidden="true" size={16} />,
                onClick: () => onOpenTrajectory(piSessionId),
              },
            ]
          : []),
        {
          label: "Rename Session",
          icon: <Pencil aria-hidden="true" size={16} />,
          onClick: () => onRenameSession(session.id),
        },
        // Archive/delete are backend-rejected while a session is active, so
        // the menu drops them instead of offering actions that only error.
        ...(session.active
          ? []
          : [
              {
                label: "Archive Session",
                icon: <Archive aria-hidden="true" size={16} />,
                onClick: () => onArchiveSession(session.id),
              },
              { type: "divider" } as const,
              {
                label: "Delete Session...",
                icon: <Trash2 aria-hidden="true" size={16} />,
                onClick: () => onDeleteSession(session.id),
              },
            ]),
      ]}
    />
  );
}

function useSidebarSectionExpansion(section: "chats" | "projects") {
  const storageKey = `pigui.sidebarSection.${section}.expanded.v1`;
  const [expanded, setExpanded] = useState(() =>
    typeof window === "undefined" || window.localStorage.getItem(storageKey) !== "false",
  );
  const contentId = useId();
  const toggle = () => {
    const next = !expanded;
    window.localStorage.setItem(storageKey, String(next));
    setExpanded(next);
  };

  return { expanded, contentId, toggle };
}

// Codex-style section header: the title is the collapse toggle and the
// creation action only surfaces on hover/focus (see .pigui-sidenav-hover-actions).
// SideNavSection keeps its own title visually hidden so the group still has
// an accessible name; this row is what the user actually sees.
function SidebarSectionHeader({
  title,
  expanded,
  contentId,
  onToggle,
  actions,
}: {
  title: string;
  expanded: boolean;
  contentId: string;
  onToggle: () => void;
  actions: ReactNode;
}) {
  return (
    <div className="pigui-sidenav-section-header">
      <button
        type="button"
        className="pigui-sidenav-section-toggle"
        aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="pigui-sidenav-section-toggle__title">{title}</span>
        <ChevronRight
          aria-hidden="true"
          className="pigui-sidenav-section-toggle__chevron"
          data-expanded={expanded ? "true" : "false"}
        />
      </button>
      <HStack className="pigui-sidenav-hover-actions" gap={0.5} vAlign="center">
        {actions}
      </HStack>
    </div>
  );
}

function ChatNavigation({
  draftViewActive,
  pathname,
  selectedSessionId,
  sessions,
  sessionsHydrated,
  onOpenSession,
  onNewChat,
  onOpenTrajectory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: {
  draftViewActive: boolean;
  pathname: string;
  selectedSessionId: string | null;
  sessions: SessionProjectionListItem[];
  sessionsHydrated: boolean;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onNewChat: () => void;
  onOpenTrajectory: (piSessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  const chatSessions = sessions.filter((session) =>
    isChatProjectId(session.projection.projectId),
  );
  const chatRouteActive = /^\/projects\/chat(?:\/|$)/.test(pathname);
  const { expanded, contentId, toggle } = useSidebarSectionExpansion("chats");
  const [followUpDraftVersion, setFollowUpDraftVersion] = useState(0);

  useEffect(
    () =>
      subscribeFollowUpDrafts(() => {
        setFollowUpDraftVersion((version) => version + 1);
      }),
    [],
  );
  void followUpDraftVersion;

  return (
    <SideNavSection data-testid="sidebar-chats" isHeaderHidden title="Chats">
      <SidebarSectionHeader
        title="Chats"
        expanded={expanded}
        contentId={contentId}
        onToggle={toggle}
        actions={
          <IconButton icon={<Plus aria-hidden="true" />} label="New Chat without a project"
            tooltip="New Chat" size="sm" variant="ghost" onClick={onNewChat} />
        }
      />
      <VStack id={contentId} gap={0.5}>
        {expanded ? (
          <SidebarSessionRows
            sessions={chatSessions}
            sessionsHydrated={sessionsHydrated}
            selectedSessionId={selectedSessionId}
            groupRouteActive={chatRouteActive}
            draftViewActive={draftViewActive}
            sessionProjectId={CHAT_PROJECT_ID}
            onOpenSession={onOpenSession}
            onOpenTrajectory={onOpenTrajectory}
            onRenameSession={onRenameSession}
            onArchiveSession={onArchiveSession}
            onDeleteSession={onDeleteSession}
          />
        ) : null}
      </VStack>
    </SideNavSection>
  );
}

/**
 * Asks the backend which registry roots still exist. Unknown or failed
 * checks count as present, so a row is only dimmed on a positive "missing".
 */
function useProjectDirectoryExistence(projects: ProjectRegistryEntry[]) {
  const [existence, setExistence] = useState<Record<string, boolean>>({});
  const rootsKey = projects.map((project) => project.path).join("\n");

  const refresh = useCallback(() => {
    let cancelled = false;
    const roots = rootsKey ? rootsKey.split("\n") : [];

    if (roots.length > 0) {
      checkProjectDirectories(roots)
        .then((result) => {
          if (!cancelled) setExistence(result && typeof result === "object" ? result : {});
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [rootsKey]);

  useEffect(refresh, [refresh]);
  useRefreshOnWindowFocus(refresh);

  return existence;
}

function ProjectNavigation({
  draftViewActive,
  pathname,
  projects,
  selectedSessionId,
  sessions,
  sessionsHydrated,
  expandedProjects,
  onAddProject,
  onToggleProject,
  onOpenSession,
  onNewProjectSession,
  onRenameProject,
  onRevealProject,
  onRemoveProject,
  onOpenTrajectory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: {
  draftViewActive: boolean;
  pathname: string;
  projects: ProjectRegistryEntry[];
  selectedSessionId: string | null;
  sessions: SessionProjectionListItem[];
  sessionsHydrated: boolean;
  expandedProjects: Record<string, boolean>;
  onAddProject: (path: string) => void;
  onToggleProject: (projectId: string) => void;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onNewProjectSession: (projectId: string) => void;
  onRenameProject: (projectId: string) => void;
  onRevealProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onOpenTrajectory: (piSessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  const projectActive = pathname.startsWith("/projects/");
  const { expanded: sectionExpanded, contentId, toggle } = useSidebarSectionExpansion("projects");
  const [followUpDraftVersion, setFollowUpDraftVersion] = useState(0);
  const projectDirectories = useProjectDirectoryExistence(projects);

  useEffect(
    () =>
      subscribeFollowUpDrafts(() => {
        setFollowUpDraftVersion((version) => version + 1);
      }),
    [],
  );

  return (
    <SideNavSection data-testid="sidebar-projects" isHeaderHidden title="Projects">
      <SidebarSectionHeader
        title="Projects"
        expanded={sectionExpanded}
        contentId={contentId}
        onToggle={toggle}
        actions={<AddProjectButton onAddProject={onAddProject} />}
      />
      <VStack id={contentId} gap={0.5}>
        {sectionExpanded ? projects.map((project) => {
          const projectSessions = sessions.filter(
            (session) => session.projection.projectId === project.id,
          );
          const expanded = expandedProjects[project.id] ?? true;
          const hasProjectUnsentFollowUp = projectSessions.some((session) =>
            hasFollowUpDraft(session.id),
          );

          void followUpDraftVersion;

          return (
            <SidebarSessionGroupBody
              key={project.id}
              rowTestId="project-row-with-actions"
              expanded={expanded}
              onToggle={() => onToggleProject(project.id)}
              icon={<ProjectExpansionIndicator expanded={expanded} />}
              label={project.displayName}
              sessions={projectSessions}
              sessionsHydrated={sessionsHydrated}
              selectedSessionId={selectedSessionId}
              groupRouteActive={projectActive}
              draftViewActive={draftViewActive}
              sessionProjectId={project.id}
              onOpenSession={onOpenSession}
              onOpenTrajectory={onOpenTrajectory}
              onRenameSession={onRenameSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              hasUnsentFollowUp={hasProjectUnsentFollowUp}
              missingDirectoryPath={
                projectDirectories[project.path] === false ? project.path : undefined
              }
              trailingActions={
                <>
                  <IconButton
                    icon={<Plus aria-hidden="true" />}
                    label={`New Chat for ${project.displayName}`}
                    size="sm"
                    variant="ghost"
                    onClick={() => onNewProjectSession(project.id)}
                  />
                  <ProjectActionsMenu
                    project={project}
                    onRenameProject={onRenameProject}
                    onRevealProject={onRevealProject}
                    onRemoveProject={onRemoveProject}
                  />
                </>
              }
            />
          );
        }) : null}
      </VStack>
    </SideNavSection>
  );
}

function TrajectoryUsageNavigation({
  draftViewActive,
  pathname,
  onNavigate,
  onNewSession,
}: {
  draftViewActive: boolean;
  pathname: string;
  onNavigate: (to: string) => void;
  onNewSession: () => void;
}) {
  return (
    <SideNavSection isHeaderHidden title="Trajectory and usage navigation">
      <SideNavItem
        icon={<AnimatedNewChat aria-hidden="true" className="size-4" />}
        isSelected={draftViewActive}
        label="New Chat"
        onClick={onNewSession}
      />
      {trajectoryUsageNavigationItems.map((item) => {
        const Icon = item.icon;
        const active = item.isActive(pathname);

        return (
          <SideNavItem
            key={item.to}
            icon={<Icon aria-hidden="true" className="size-4" />}
            isSelected={active}
            label={item.label}
            onClick={() => onNavigate(item.to)}
          />
        );
      })}
    </SideNavSection>
  );
}

function SystemNavigation({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: (to: string) => void;
}) {
  const updateStatus = useUpdateStatus();
  const updateReady = updateStatus?.state === "ready";

  return (
    <SideNavSection data-testid="sidebar-system" isHeaderHidden title="System navigation">
      {systemNavigationItems.map((item) => {
        const Icon = item.icon;
        const active = item.isActive(pathname);

        return (
          <SideNavItem
            key={item.to}
            icon={<Icon aria-hidden="true" className="size-4" />}
            isSelected={active}
            label={item.label}
            endContent={
              item.to === "/settings" && updateReady ? (
                <SidebarNavDot label="Update ready" />
              ) : undefined
            }
            onClick={() => onNavigate(item.to)}
          />
        );
      })}
    </SideNavSection>
  );
}

function HeaderChrome({
  chromeRef,
  title,
  toolbarActions,
  headerContent,
  sidebarOpen,
  mainLeft,
  showSidebarToggle = true,
  onToggleSidebar,
}: {
  chromeRef: RefObject<HTMLDivElement | null>;
  title: string;
  toolbarActions?: ReactNode;
  headerContent?: ReactNode;
  sidebarOpen: boolean;
  mainLeft: string;
  showSidebarToggle?: boolean;
  onToggleSidebar?: () => void;
}) {
  const chromeStyle = {
    "--pigui-chrome-safe-left": chromeSafeLeft,
    "--pigui-header-height": titlebarHeight,
    "--pigui-main-left": mainLeft,
    "--pigui-traffic-width": trafficWidth,
    height: titlebarHeight,
  } as CSSProperties;
  const titleTrackStyle = {
    left: "var(--pigui-chrome-safe-left)",
  } as CSSProperties;
  const titleStyle = {
    // The traffic-light safe area consumes chat width when the sidebar is closed.
    maxWidth:
      "max(0px, calc(var(--spacing-4) * 20 - max(0px, var(--pigui-chrome-safe-left) - var(--pigui-main-left))))",
    transform:
      "translateX(calc(max(var(--pigui-main-left), var(--pigui-chrome-safe-left)) - var(--pigui-chrome-safe-left)))",
  } as CSSProperties;

  return (
    <div
      ref={chromeRef}
      className="pigui-header-chrome"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-testid="header-chrome"
      style={chromeStyle}
    >
      <div className="pigui-header-chrome__left" data-testid="header-chrome-left">
        <div
          aria-hidden="true"
          className="h-full shrink-0"
          data-window-drag-region
          data-testid="mac-traffic-space"
          style={{ width: trafficWidth }}
        />
        {showSidebarToggle ? (
          <button
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            className="inline-flex shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted/10"
            data-slot="sidebar-trigger"
            style={titlebarControlStyle}
            type="button"
            onClick={onToggleSidebar}
          >
            <AnimatedSidebar aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <div
          aria-hidden="true"
          className="h-full min-w-0 flex-1"
          data-window-drag-region
        />
      </div>
      {headerContent ? (
        <HStack className="pigui-header-chrome__pane-headers" gap={0}>
          {headerContent}
        </HStack>
      ) : (
      <div
        className="pigui-header-chrome__title-track"
        data-testid="header-chrome-title-track"
        style={titleTrackStyle}
      >
        <div
          className="pigui-header-chrome__title flex h-7 min-w-0 shrink-0 select-none items-center"
          data-testid="header-chrome-title"
          style={titleStyle}
        >
          <h1
            className="select-none truncate text-sm font-normal leading-7 tracking-normal text-foreground"
            title={title}
          >
            {title}
          </h1>
        </div>
        <div
          aria-hidden="true"
          className="pigui-header-chrome__drag h-full min-w-0 flex-1 select-none"
          data-slot="navbar-spacer"
          data-window-drag-region
        />
        {toolbarActions ? (
          <div
            className="pigui-header-chrome__actions flex h-full shrink-0 items-center gap-1"
            data-testid="navbar-actions"
          >
            {toolbarActions}
          </div>
        ) : null}
      </div>
      )}
    </div>
  );
}

export function AppFrame({
  children,
  showSidebar = true,
  toolbarActions,
  headerContent,
  sessionProjections,
  sessionsHydrated,
  selectedSessionId,
  onSelectedSessionIdChange,
}: AppFrameProps) {
  const router = useRouter();
  const { openSettings } = useSettingsDialog();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const draftViewActive = useRouterState({
    select: (state) => {
      const search = state.location.search as { view?: string };

      return pathname.startsWith("/projects/") && search.view === "draft";
    },
  });
  const activeTab = getActiveTab(pathname);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [measuredSidebarWidth, setMeasuredSidebarWidth] = useState(sidebarDefaultSize);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const headerChromeRef = useRef<HTMLDivElement | null>(null);
  const sidebarAnimatingRef = useRef(false);
  const sidebarOpenRef = useRef(sidebarOpen);
  const sidebarAnimationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionProjectionsStore = useSessionProjectionsOptional();
  const [localSessionProjections] = useState(() =>
    shouldUseBrowserDevelopmentData()
      ? defaultSidebarProjectSessionProjections
      : [],
  );
  const projects = useVisibleProjectRegistry();
  const [expandedProjects, setExpandedProjects] = useState(() =>
    readProjectExpansionState(),
  );
  // Prefer explicit page props; otherwise use app-wide hydrated store (Trajectory/Usage/Setup).
  const effectiveSessionProjections =
    sessionProjections ??
    sessionProjectionsStore?.sessionProjections ??
    localSessionProjections;
  // Without the app-wide store (unit tests / isolated frames), empty means empty.
  const effectiveSessionsHydrated =
    sessionsHydrated ??
    sessionProjectionsStore?.sessionsHydrated ??
    true;
  const sessions = useMemo(
    () => getSessionProjectionListItems(effectiveSessionProjections),
    [effectiveSessionProjections],
  );
  const [localSelectedSessionId, setLocalSelectedSessionId] = useState<string | null>(
    () =>
      getSessionProjectionListItems(
        sessionProjections ??
          (shouldUseBrowserDevelopmentData()
            ? defaultSidebarProjectSessionProjections
            : []),
      )[0]?.id ?? null,
  );
  const effectiveSelectedSessionId =
    selectedSessionId === undefined ? localSelectedSessionId : selectedSessionId;
  const sessionTitle = pathname.startsWith("/projects/")
    ? sessions.find((session) => session.id === effectiveSelectedSessionId)?.title
    : undefined;
  const updateSelectedSessionId = onSelectedSessionIdChange ?? setLocalSelectedSessionId;
  const headerMainLeft = measuredSidebarWidth;
  const handleSidebarOpenChange = (open: boolean) => {
    if (sidebarAnimationTimeoutRef.current) {
      clearTimeout(sidebarAnimationTimeoutRef.current);
    }

    sidebarAnimatingRef.current = true;
    sidebarOpenRef.current = open;
    setSidebarAnimating(true);
    setSidebarOpen(open);
    sidebarAnimationTimeoutRef.current = setTimeout(() => {
      sidebarAnimatingRef.current = false;
      setSidebarAnimating(false);
      sidebarAnimationTimeoutRef.current = null;
    }, sidebarAnimationMs);
  };

  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  useEffect(() => {
    sidebarAnimatingRef.current = sidebarAnimating;
  }, [sidebarAnimating]);

  useEffect(
    () => () => {
      if (sidebarAnimationTimeoutRef.current) {
        clearTimeout(sidebarAnimationTimeoutRef.current);
      }
    },
    [],
  );

  const updateExpandedProjects = (
    updater: (expandedProjects: Record<string, boolean>) => Record<string, boolean>,
  ) => {
    setExpandedProjects((currentExpandedProjects) => {
      const nextExpandedProjects = updater(currentExpandedProjects);

      writeProjectExpansionState(nextExpandedProjects);

      return nextExpandedProjects;
    });
  };

  useEffect(() => {
    if (!effectiveSelectedSessionId) {
      return;
    }

    const selectedProjection = effectiveSessionProjections.find(
      (projection) => projection.id === effectiveSelectedSessionId,
    );

    if (!selectedProjection) {
      return;
    }

    updateExpandedProjects((currentExpandedProjects) => {
      if (currentExpandedProjects[selectedProjection.projectId] === true) {
        return currentExpandedProjects;
      }

      return {
        ...currentExpandedProjects,
        [selectedProjection.projectId]: true,
      };
    });
  }, [effectiveSelectedSessionId, effectiveSessionProjections]);

  useLayoutEffect(() => {
    const root = layoutRef.current;
    if (!root) {
      return;
    }

    const sidebarPanel = root.querySelector<HTMLElement>(
      '[data-testid="app-layout-sidebar"]',
    );
    if (!sidebarPanel || typeof ResizeObserver === "undefined") {
      // Offcanvas closed state: the sidenav is not rendered at all.
      headerChromeRef.current?.style.setProperty("--pigui-main-left", "0px");
      return;
    }

    const updateSidebarWidth = () => {
      const width = sidebarPanel.getBoundingClientRect().width;

      if (!Number.isFinite(width) || width < 0) {
        return;
      }

      if (width === 0 && sidebarOpenRef.current && !sidebarAnimatingRef.current) {
        return;
      }

      const currentWidth = `${Math.round(width)}px`;

      // Keep the fixed header on the sidebar's live geometry so their motion cannot diverge.
      headerChromeRef.current?.style.setProperty("--pigui-main-left", currentWidth);

      if (width === 0 || sidebarAnimatingRef.current || !sidebarOpenRef.current) {
        return;
      }

      setMeasuredSidebarWidth(currentWidth);
    };

    updateSidebarWidth();

    const observer = new ResizeObserver(updateSidebarWidth);
    observer.observe(sidebarPanel);

    return () => {
      observer.disconnect();
    };
    // Re-observe on open/close: SideNav remounts its root when the resizable
    // wrapper is added/removed, which would leave a stale observed node.
  }, [sidebarOpen]);

  const openSessionDraft = (
    targetProjectId: string | null,
    routeProjectId = targetProjectId,
  ) => {
    ensureSessionDraft(targetProjectId);
    const navigationProjectId =
      routeProjectId ??
      projectIdFromRoute(pathname, projects) ??
      projects[0]?.id ??
      CHAT_PROJECT_ID;

    if (!navigationProjectId) {
      return;
    }

    void router.navigate({
      to: projectRoute(navigationProjectId) as never,
      search: { view: "draft" } as never,
    });
  };
  const handleNavigate = (to: string) => {
    if (to === "/settings") {
      openSettings();
      return;
    }
    void router.navigate({ to: to as never });
  };
  const handleNewSession = () => openSessionDraft(CHAT_PROJECT_ID, CHAT_PROJECT_ID);
  const handleNewChat = handleNewSession;
  const handleNewProjectSession = (projectId: string) => {
    updateExpandedProjects((currentExpandedProjects) => ({
      ...currentExpandedProjects,
      [projectId]: true,
    }));
    openSessionDraft(projectId, projectId);
  };
  const handleAddProject = (path: string) => {
    const result = addProjectToRegistry(path);

    updateExpandedProjects((currentExpandedProjects) => ({
      ...currentExpandedProjects,
      [result.project.id]: true,
    }));
    openSessionDraft(result.project.id, result.project.id);
  };
  const handleRenameProject = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      return;
    }

    const nextDisplayName = window.prompt("Rename Project", project.displayName);

    if (nextDisplayName === null) {
      return;
    }

    renameProjectInRegistry(project.id, nextDisplayName);
  };
  const handleRevealProject = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      return;
    }

    void revealProjectInFinder(project.path);
  };
  const handleRemoveProject = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      return;
    }

    const confirmed = window.confirm(
      [
        `Remove ${project.displayName} from Pace?`,
        "",
        "Local files and historical Sessions will not be deleted.",
        "If this Project is the current draft target, the draft text will be kept and the target cleared.",
      ].join("\n"),
    );

    if (!confirmed) {
      return;
    }

    if (getSessionDraft()?.projectId === projectId) {
      setSessionDraftTarget(null);
    }

    removeProjectFromRegistry(projectId);
    updateExpandedProjects((currentExpandedProjects) => {
      const { [projectId]: _removedProject, ...nextExpandedProjects } =
        currentExpandedProjects;

      return nextExpandedProjects;
    });

    const selectedProjection = effectiveSelectedSessionId
      ? effectiveSessionProjections.find(
          (projection) => projection.id === effectiveSelectedSessionId,
        )
      : null;

    if (selectedProjection?.projectId !== projectId) {
      return;
    }

    updateSelectedSessionId(null);
    ensureSessionDraft(null);
    void router.navigate({
      to: projectRoute(projectId) as never,
      search: { view: "draft" } as never,
    });
  };
  // After archive/delete removes the selected session from the sidebar,
  // fall back to the project's draft view (same tail as handleRemoveProject).
  const clearRemovedSessionSelection = (sessionId: string, projectId: string) => {
    if (effectiveSelectedSessionId !== sessionId) {
      return;
    }

    updateSelectedSessionId(null);
    ensureSessionDraft(projectId);
    void router.navigate({
      to: projectRoute(projectId) as never,
      search: { view: "draft" } as never,
    });
  };
  const handleRenameSession = async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      return;
    }

    const nextTitle = window.prompt("Rename Session", session.title);

    if (nextTitle === null) {
      return;
    }

    const trimmedTitle = nextTitle.trim();

    if (!trimmedTitle || trimmedTitle === session.title) {
      return;
    }

    try {
      await renameSessionProjection(sessionId, trimmedTitle);
      // Patch the title in place instead of rehydrating from the persisted
      // record: a full replace would drop live runtime state mid-session.
      sessionProjectionsStore?.store.rename(sessionId, { title: trimmedTitle });
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Pace could not rename the Session.",
      );
    }
  };
  const handleArchiveSession = async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      return;
    }

    try {
      const archived = await archiveSessionProjection(sessionId);

      // Archive on the live projection instead of replacing it with the
      // persisted record: `archivedAt` alone hides it from the sidebar and
      // makes the Live Session View read-only, and the store releases the
      // Session's runtime subscription.
      sessionProjectionsStore?.store.apply(sessionId, {
        type: "session-archived",
        occurredAt: archived.archivedAt ?? archived.updatedAt,
      });
      clearRemovedSessionSelection(sessionId, session.projection.projectId);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Pace could not archive the Session.",
      );
    }
  };
  const handleDeleteSession = async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      return;
    }

    const confirmed = window.confirm(
      [
        `Delete ${session.title}?`,
        "",
        "This removes the Session from Pace permanently.",
        "Pi's own session files on disk are not deleted.",
      ].join("\n"),
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteSessionProjection(sessionId);
      sessionProjectionsStore?.store.remove(sessionId);
      clearRemovedSessionSelection(sessionId, session.projection.projectId);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Pace could not delete the Session.",
      );
    }
  };
  const handleToggleProject = (projectId: string) => {
    updateExpandedProjects((currentExpandedProjects) => ({
      ...currentExpandedProjects,
      [projectId]: !(currentExpandedProjects[projectId] ?? true),
    }));
  };
  const handleOpenSession = (sessionId: string, projectId: string) => {
    updateSelectedSessionId(sessionId);
    updateExpandedProjects((currentExpandedProjects) => ({
      ...currentExpandedProjects,
      [projectId]: true,
    }));
    void router.navigate({
      to: projectRoute(projectId) as never,
    });
  };

  const frameContent = (
    <>
      <HeaderChrome
        chromeRef={headerChromeRef}
        mainLeft={showSidebar ? headerMainLeft : "0px"}
        showSidebarToggle={showSidebar}
        sidebarOpen={showSidebar ? sidebarOpen : false}
        title={draftViewActive ? "New Chat" : sessionTitle || activeTab}
        toolbarActions={toolbarActions}
        headerContent={headerContent}
        onToggleSidebar={() => handleSidebarOpenChange(!sidebarOpen)}
      />
      <div
        className="flex h-full min-h-0 min-w-0 flex-col"
        data-testid="app-frame-content"
      >
        <div aria-hidden="true" className="h-10 shrink-0" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );

  // Titlebar-only shell (first-run preflight): keep chrome, omit navigation sidebar.
  if (!showSidebar) {
    return (
      <div
        className="pigui-app-layout flex h-dvh min-h-0 flex-col bg-background text-foreground"
        data-testid="app-frame-titlebar-only"
      >
        {frameContent}
      </div>
    );
  }

  return (
    <AppShell
      ref={layoutRef}
      className="pigui-app-layout text-foreground"
      contentPadding={0}
      data-sidebar-animating={sidebarAnimating ? "true" : undefined}
      mobileNav={false}
      variant="elevated"
      sideNav={
        // Offcanvas on purpose: an Agentic Developer Environment has no use
        // for Astryx's 48px icon rail, so closed means fully removed.
        !sidebarOpen ? undefined : (
        <SideNav
          className="pigui-app-sidenav"
          data-state="expanded"
          data-testid="app-layout-sidebar"
          resizable={{ defaultWidth: 260, minWidth: 240, maxWidth: 320, autoSaveId: "pigui-app-shell" }}
          header={
            <div
              aria-hidden="true"
              data-testid="sidebar-titlebar-spacer"
              style={sidebarTitlebarSpacerStyle}
            />
          }
          footer={<SystemNavigation pathname={pathname} onNavigate={handleNavigate} />}
        >
          <TrajectoryUsageNavigation
            draftViewActive={draftViewActive}
            pathname={pathname}
            onNavigate={handleNavigate}
            onNewSession={handleNewSession}
          />
          <ChatNavigation
            draftViewActive={draftViewActive}
            pathname={pathname}
            selectedSessionId={effectiveSelectedSessionId}
            sessions={sessions}
            sessionsHydrated={effectiveSessionsHydrated}
            onOpenSession={handleOpenSession}
            onNewChat={handleNewChat}
            onOpenTrajectory={(piSessionId) =>
              void router.navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: piSessionId },
              })
            }
            onRenameSession={(sessionId) => void handleRenameSession(sessionId)}
            onArchiveSession={(sessionId) => void handleArchiveSession(sessionId)}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          />
          <ProjectNavigation
            draftViewActive={draftViewActive}
            pathname={pathname}
            projects={projects}
            selectedSessionId={effectiveSelectedSessionId}
            sessions={sessions}
            sessionsHydrated={effectiveSessionsHydrated}
            expandedProjects={expandedProjects}
            onAddProject={handleAddProject}
            onToggleProject={handleToggleProject}
            onOpenSession={handleOpenSession}
            onNewProjectSession={handleNewProjectSession}
            onRenameProject={handleRenameProject}
            onRevealProject={handleRevealProject}
            onRemoveProject={handleRemoveProject}
            onOpenTrajectory={(piSessionId) =>
              void router.navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: piSessionId },
              })
            }
            onRenameSession={(sessionId) => void handleRenameSession(sessionId)}
            onArchiveSession={(sessionId) => void handleArchiveSession(sessionId)}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          />
        </SideNav>
        )
      }
    >
      {frameContent}
    </AppShell>
  );
}
