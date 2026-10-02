import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { ApprovalDecision, PendingApproval } from "../../protocol/demo.ts";
import { ApprovalsDoc } from "./state.ts";

type Waiter = { readonly request: PendingApproval; resolve(decision: ApprovalDecision): void };

/**
 * Who is waiting for a decision. A hook can neither commit nor sleep durably, so the waiting
 * itself lives here, in memory; a restarted host's hook runs again and asks again. Decisions
 * are committed to `ApprovalsDoc`, which is what makes them stand.
 */
export class ApprovalBoard {
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #decided = new Map<string, ApprovalDecision>();
  readonly #listeners = new Set<(pending: readonly PendingApproval[]) => void>();
  #harness: Harness | undefined;

  attach(harness: Harness): void {
    this.#harness = harness;
  }

  get value(): readonly PendingApproval[] {
    return [...this.#waiters.values()].map((waiters) => waiters[0]!.request);
  }

  subscribe(listener: (pending: readonly PendingApproval[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves with the decision; rejects when `context` is cancelled, for example by Esc. */
  wait(request: PendingApproval, context: Context): Promise<ApprovalDecision> {
    const decided = this.#decided.get(request.id);
    if (decided !== undefined) return Promise.resolve(decided);
    return new Promise((resolve, reject) => {
      const signal = context.abortSignal;
      const waiter: Waiter = {
        request,
        resolve: (decision) => {
          signal?.removeEventListener("abort", cancel);
          resolve(decision);
        },
      };
      const cancel = (): void => {
        this.#remove(waiter);
        reject(signal?.reason ?? new Error("Approval wait cancelled"));
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      this.#waiters.set(request.id, [...(this.#waiters.get(request.id) ?? []), waiter]);
      this.#changed();
    });
  }

  /** Commit a decision unless one exists; returns the one that stands and whether it is this one. */
  async decide(
    conversationId: ConversationId,
    id: string,
    approved: boolean,
    by: string,
  ): Promise<{ decision: ApprovalDecision; first: boolean }> {
    const harness = this.#harness;
    if (harness === undefined) throw new Error("Approvals are not attached to a Harness");
    const candidate: ApprovalDecision = { approved, by, at: Date.now() };
    const decision = await harness.commit(async (tx) => {
      const doc = await tx.doc(ApprovalsDoc, conversationId);
      if (doc.decisions[id] === undefined && !this.#waiters.has(id)) throw new Error(`No pending approval ${id}`);
      doc.decisions[id] ??= { ...candidate };
      return { ...doc.decisions[id] } as ApprovalDecision;
    }, BACKGROUND_CONTEXT);
    this.#decided.set(id, decision);
    const waiters = this.#waiters.get(id) ?? [];
    this.#waiters.delete(id);
    for (const waiter of waiters) waiter.resolve(decision);
    if (waiters.length > 0) this.#changed();
    return { decision, first: decision.by === candidate.by && decision.at === candidate.at };
  }

  #remove(waiter: Waiter): void {
    const rest = (this.#waiters.get(waiter.request.id) ?? []).filter((candidate) => candidate !== waiter);
    if (rest.length > 0) this.#waiters.set(waiter.request.id, rest);
    else this.#waiters.delete(waiter.request.id);
    this.#changed();
  }

  #changed(): void {
    const pending = this.value;
    for (const listener of this.#listeners) listener(pending);
  }
}
