import type { ReactNode } from "react";
import { ChevronDown, FolderClosed } from "@/shared/ui/icons";

/**
 * A Location or Branch that can no longer be chosen — a bound Session's
 * checkout, a worktree's base branch — wearing the chrome of the picker it
 * stands in for, so the row does not change type size or metrics when a
 * control becomes a label. `chrome` names that picker: ghost Selector
 * (ProjectPicker, CheckoutStrategyPicker) or ghost Button (GitBranchPicker);
 * the measurements below are theirs.
 *
 * The Selector chrome keeps the chevron's box, hidden: the Draft's Location
 * picker becomes this label at the handoff, and dropping 16px + a gap would
 * pull the Branch chip beside it leftwards. Nothing in the row may move.
 */
export function ComposerStaticChip({
  chrome,
  icon: Icon,
  label,
  testId,
}: {
  chrome: "selector" | "button";
  icon: typeof FolderClosed;
  label: string;
  testId: string;
}) {
  const selectorChrome = chrome === "selector";

  return (
    <span
      className={`inline-flex h-7 min-w-0 max-w-[16rem] items-center text-sm font-medium ${
        selectorChrome ? "gap-2 px-3 text-foreground" : "gap-1.5 px-2 text-muted"
      }`}
      data-testid={testId}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="truncate">{label}</span>
      {selectorChrome ? (
        <ChevronDown aria-hidden="true" className="invisible size-4 shrink-0" />
      ) : null}
    </span>
  );
}

/**
 * The composer's Location row, identical in the Session Draft and the Live
 * Session: where the Session runs, which branch it is on, and how much of the
 * context window it holds. Nothing here is swapped out at the handoff — the
 * draft-only Project picker lives above the composer instead.
 */
export function ComposerLocationRow({
  location,
  branch,
  meter,
}: {
  /** Absent only in a draft with no target Project: nowhere to run yet. */
  location?: ReactNode;
  branch?: ReactNode;
  meter: ReactNode;
}) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {location}
      {branch}
      <span className="ml-auto inline-flex shrink-0">{meter}</span>
    </span>
  );
}
