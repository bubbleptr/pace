import { useMemo } from "react";
import {
  getSessionProjectionListItems,
} from "@/entities/session/session-projection";
import { useSessionProjections } from "@/entities/session/use-session-projections";
import { useSessionNotifications } from "./use-session-notifications";

// Mounted once at app level (main.tsx), not inside AppFrame: every page owns
// its own AppFrame, so a widget-level mount would re-seed the status baseline
// on each navigation and silently swallow a run that ended in between.
export function SessionNotifications({
  onOpen,
}: {
  onOpen: (session: { id: string; projectId: string }) => void;
}): null {
  const { sessionProjections, store } = useSessionProjections();
  const sources = useMemo(
    () =>
      getSessionProjectionListItems(sessionProjections).map(
        ({ id, title, projection }) => ({
          id,
          title,
          status: projection.status,
        }),
      ),
    [sessionProjections],
  );

  useSessionNotifications(sources, (sessionId) => {
    const projection = store.get(sessionId);
    if (projection) {
      onOpen({ id: projection.id, projectId: projection.projectId });
    }
  });

  return null;
}
