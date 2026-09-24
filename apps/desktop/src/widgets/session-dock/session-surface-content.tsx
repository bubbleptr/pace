import { type SessionChangeTarget } from "@/entities/session/session-change-link";
import { type SessionProjection } from "@/entities/session/session-projection";
import { type SessionChangesView } from "@/entities/session/use-session-changes";
import type { TerminalInstanceInfo } from "@/entities/terminal/terminal-client";
import { type SessionSurfaceId } from "@/shared/ui/session-dock/surface-registry";
import { SessionBrowserPanel } from "./session-browser-panel";
import { SessionChangesPanel } from "./session-changes-panel";
import { SessionFilesPanel } from "./session-files-panel";
import { SessionTerminalPanel } from "./session-terminal-panel";

/** Renders the active surface inside the shared dock panel. */
export function SessionSurfaceContent({
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
