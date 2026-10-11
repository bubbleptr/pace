import { useEffect, useRef } from "react";
import {
  diffSessionNotices,
  type SessionNotificationSource,
  type SessionStatusBaseline,
} from "./session-notices";

// Watches sidebar session statuses and raises a system notification when a
// run ends while the window is not in front. The baseline is updated before
// every early return so a skipped batch still records statuses — and a
// StrictMode double-effect with identical input re-diffs to zero notices.
export function useSessionNotifications(
  sessions: readonly SessionNotificationSource[],
  onOpen: (sessionId: string) => void,
): void {
  const baselineRef = useRef<SessionStatusBaseline | undefined>(undefined);
  // A click may land long after the effect ran; keep the latest callback.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const { notices, baseline } = diffSessionNotices(
      baselineRef.current,
      sessions,
    );
    baselineRef.current = baseline;

    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    // Window in front: the status change is already on screen.
    if (document.visibilityState === "visible" && document.hasFocus()) {
      return;
    }

    for (const notice of notices) {
      // tag = session id: a newer notice for the same Session replaces the old.
      const notification = new Notification(notice.title, {
        body: notice.body,
        tag: notice.sessionId,
      });
      notification.onclick = () => {
        window.focus();
        onOpenRef.current(notice.sessionId);
        notification.close();
      };
    }
  }, [sessions]);
}
