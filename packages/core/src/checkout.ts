// Execution checkout port — the Git capability the utilityProcess backend
// implements and the checkout manager depends on.

export type ExecutionCheckoutGitClient = {
  isGitRepository(repoRoot: string): Promise<boolean>;
  addDetachedWorktree(input: {
    repoRoot: string;
    checkoutRoot: string;
    sessionId: string;
    /** Branch the worktree starts from; the repository's HEAD when absent. */
    baseRef?: string;
  }): Promise<void>;
};
