import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { listSessions } from "@/entities/session/sessions";
import { RefreshCw } from "@/shared/ui/icons";
import { AppFrame } from "@/widgets/app-frame";
import { NoProvidersEmptyState } from "@/entities/session/no-providers-empty-state";
import { useProviderAuthStatus } from "@/entities/session/use-provider-auth-status";
import { SessionDetailPage } from "@/pages/session-detail";
import { SessionListPanel } from "@/pages/session-list";

/**
 * Messaging-archetype frame: the session list is a fixed-width sidebar
 * finder, the replay is the fluid reading pane. Fixed budget instead of a
 * resizable split — the finder's width is set by its content density, and
 * extra viewport space belongs to the reading pane.
 */
function TrajectoryEmptyState() {
  return (
    <HStack className="h-full min-h-0 px-6" hAlign="center" vAlign="center">
      <EmptyState
        isCompact
        title="Select a session"
        description="Choose a session from the left to explore its timeline, tool calls, and usage."
      />
    </HStack>
  );
}

export function TrajectoryWorkspace({
  selectedSessionId,
  children,
}: {
  selectedSessionId?: string;
  children: React.ReactNode;
}) {
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: listSessions });
  const selectedSession = sessions.data?.find((session) => session.id === selectedSessionId);
  const title = selectedSession?.title;
  const sessionTitle = title?.kind === "text" ? title.sentence
    : title?.kind === "command" ? `${title.name}${title.args ? ` ${title.args}` : ""}`
    : title?.kind === "skill" ? title.name
    : title?.text || "Untitled session";

  return (
    <AppFrame
      headerContent={
        <>
          <HStack
            className="h-full w-80 min-w-0 shrink-0 border-r border-b border-separator px-4"
            gap={2}
            vAlign="center"
            data-testid="trajectory-list-header"
          >
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Trajectory</h1>
            <IconButton
              className="pigui-pressable shrink-0"
              icon={<RefreshCw className={`size-4 ${sessions.isFetching ? "motion-safe:animate-spin" : ""}`} />}
              isDisabled={sessions.isFetching}
              label="Refresh sessions"
              size="sm"
              variant="ghost"
              onClick={() => sessions.refetch()}
            />
          </HStack>
          <HStack
            className="h-full min-w-0 flex-1 border-b border-separator px-5"
            gap={3}
            vAlign="center"
            data-testid="trajectory-detail-header"
          >
            {selectedSession ? (
              <>
                <h2 className="min-w-0 truncate text-sm font-medium" title={sessionTitle}>
                  {sessionTitle}
                </h2>
                <p className="min-w-0 truncate text-xs text-muted">{selectedSession.project}</p>
              </>
            ) : (
              <p className="truncate text-sm text-muted">Session replay</p>
            )}
          </HStack>
        </>
      }
    >
      <article
        className="h-full min-h-0 overflow-hidden"
        data-testid="trajectory-workspace"
      >
        <div className="flex h-full min-h-0 w-full" data-testid="trajectory-split-view">
          <div
            className="h-full w-80 min-h-0 shrink-0 border-r border-separator"
            data-testid="trajectory-list-pane"
          >
            <SessionListPanel selectedSessionId={selectedSessionId} />
          </div>
          <div
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="trajectory-detail-pane"
          >
            {children}
          </div>
        </div>
      </article>
    </AppFrame>
  );
}

export function TrajectoryIndexPage() {
  const { loading, configured } = useProviderAuthStatus();

  return (
    <TrajectoryWorkspace>
      {!loading && !configured ? (
        <NoProvidersEmptyState testId="trajectory-no-providers-empty-state" />
      ) : (
        <TrajectoryEmptyState />
      )}
    </TrajectoryWorkspace>
  );
}

export function TrajectorySessionPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });

  return (
    <TrajectoryWorkspace selectedSessionId={sessionId}>
      <SessionDetailPage />
    </TrajectoryWorkspace>
  );
}
