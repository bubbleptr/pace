import type { SessionStatus } from "@/entities/session/session-projection";

export type SessionNotificationSource = {
  readonly id: string;
  readonly title: string;
  readonly status: SessionStatus;
};

export type SessionNotice = {
  readonly sessionId: string;
  readonly title: string;
  readonly body: "Finished" | "Failed";
};

export type SessionStatusBaseline = ReadonlyMap<string, SessionStatus>;

// Only "running" counts as a run in flight. A "creating" Session may never
// start one: a fork lands as creating and then resyncs to the source's end
// status, which must not read as a finished run. The trade-off — a creation
// that fails before its first run no longer notifies — is accepted.
const RUNNING_STATUSES: ReadonlySet<SessionStatus> = new Set(["running"]);

// Notices fire on status *transitions*, not snapshots: a Session is only
// newsworthy when a run we already saw in flight ends. The first list ever
// seen (undefined previous) just seeds the baseline — Sessions mid-run or
// long finished at startup are not news — and a Session absent from the
// baseline can never notify, since we never saw its run.
export function diffSessionNotices(
  previous: SessionStatusBaseline | undefined,
  sessions: readonly SessionNotificationSource[],
): { notices: SessionNotice[]; baseline: SessionStatusBaseline } {
  const baseline = new Map<string, SessionStatus>();
  const notices: SessionNotice[] = [];

  for (const session of sessions) {
    baseline.set(session.id, session.status);

    if (previous === undefined) {
      continue;
    }
    const previousStatus = previous.get(session.id);
    if (previousStatus === undefined || !RUNNING_STATUSES.has(previousStatus)) {
      continue;
    }
    if (session.status === "completed" || session.status === "waiting") {
      notices.push({
        sessionId: session.id,
        title: session.title,
        body: "Finished",
      });
    } else if (session.status === "failed") {
      notices.push({
        sessionId: session.id,
        title: session.title,
        body: "Failed",
      });
    }
  }

  return { notices, baseline };
}
