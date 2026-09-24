import { type ReactNode } from "react";
import { type SessionProjection } from "@/entities/session/session-projection";

export function SessionCreationFailureDetail({
  failure,
  action,
}: {
  failure: NonNullable<SessionProjection["failure"]>;
  action?: ReactNode;
}) {
  return (
    <>
      <p className="font-medium text-foreground">Session creation failed</p>
      <dl className="mt-2 grid gap-1">
        <div className="flex items-center gap-2">
          <dt className="text-muted">Stage</dt>
          <dd className="font-medium text-foreground">{failure.stage}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted">Error</dt>
          <dd className="text-foreground">{failure.message}</dd>
        </div>
      </dl>
      {action ? <div className="mt-3">{action}</div> : null}
    </>
  );
}
