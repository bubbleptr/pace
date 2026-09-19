export type SessionChangesState = "ready" | "clean" | "non-git";

export type SessionChangedFileKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type-changed";

export type SessionChangedFile = {
  path: string;
  previousPath?: string;
  kind: SessionChangedFileKind;
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch?: string;
  patchTruncated: boolean;
};

/**
 * Project-level Git state, read before any Session exists: what branch a new
 * Session would start on and the names it can be pointed at. The Session Draft
 * shows this in its Location row; `branch` is null for a Project outside Git
 * or on a detached HEAD, and `branches` is then empty.
 */
export type ProjectGitSummary = {
  projectRoot: string;
  branch: string | null;
  branches: string[];
};

export type SessionChanges = {
  sessionId: string;
  state: SessionChangesState;
  checkoutRoot: string;
  repositoryRoot: string | null;
  generatedAt: string;
  head?: {
    oid: string | null;
    branch: string | null;
    detached: boolean;
  };
  /**
   * Branch names shown in the composer picker: local heads (`refs/heads`) plus
   * remote-tracking names that have no local counterpart (`origin/feat/x` is
   * listed as `feat/x`). Current branch first when it is one of them.
   */
  branches?: string[];
  /**
   * Local branches already checked out in another Git worktree. The current
   * checkout's own HEAD is omitted — those names are occupied, not current.
   */
  occupiedBranches?: Array<{
    branch: string;
    path: string;
  }>;
  files: SessionChangedFile[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
    conflictedFiles: number;
  };
  truncated: boolean;
  omittedFileCount: number;
};
