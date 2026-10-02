import { defineDoc } from "@earendil-works/pi-durable";
import type { ApprovalDecision, PlanState, RolloutState } from "../../protocol/demo.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

/** Rewindable, so a fork starts with the plan its parent had at the fork entry. */
export const PlanDoc = defineDoc<Mutable<PlanState>>({
  kind: "demo.plan",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
});

export const RolloutDoc = defineDoc<Mutable<RolloutState>>({
  kind: "demo.rollout",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runs: {} }),
});

/** Decisions keyed by the held call's task ID. The first one committed stands. */
export const ApprovalsDoc = defineDoc<{ decisions: Record<string, Mutable<ApprovalDecision>> }>({
  kind: "demo.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ decisions: {} }),
});
