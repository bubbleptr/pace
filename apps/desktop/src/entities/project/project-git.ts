import { useEffect, useState } from "react";
import type { ProjectGitSummary } from "@pace/core";
import { invoke } from "@/shared/runtime";

export type { ProjectGitSummary } from "@pace/core";

export async function getProjectGitSummary(projectRoot: string) {
  return invoke<ProjectGitSummary>("get_project_git_summary", { projectRoot });
}

export async function checkoutProjectBranch(projectRoot: string, branch: string) {
  return invoke<ProjectGitSummary>("checkout_project_branch", {
    projectRoot,
    branch,
  });
}

export type ProjectGitView = {
  summary: ProjectGitSummary | null;
  checkoutBranch: (branch: string) => Promise<void>;
};

/**
 * Branch state of the Session Draft's target Project — which branch a new
 * Session would start on, and the names it can be pointed at.
 *
 * This is a Project-level read, deliberately separate from `useSessionChanges`:
 * that one may only run once a Session checkout exists (the worktree race in
 * PR #268), while the draft has no Session at all. `projectRoot` is null for
 * the Chat workspace, which has no folder to be on a branch, and nothing is
 * asked of Git then.
 */
export function useProjectGit({
  projectRoot,
  loadSummary = getProjectGitSummary,
  checkoutBranch: checkout = checkoutProjectBranch,
}: {
  projectRoot: string | null;
  loadSummary?: (projectRoot: string) => Promise<ProjectGitSummary>;
  checkoutBranch?: (
    projectRoot: string,
    branch: string,
  ) => Promise<ProjectGitSummary>;
}): ProjectGitView {
  const [summary, setSummary] = useState<ProjectGitSummary | null>(null);

  useEffect(() => {
    if (!projectRoot) {
      setSummary(null);
      return;
    }

    let cancelled = false;

    // A Project without Git, or a failed read, simply leaves the row without a
    // branch; the draft must stay usable either way.
    void loadSummary(projectRoot)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectRoot, loadSummary]);

  return {
    summary: summary?.projectRoot === projectRoot ? summary : null,
    checkoutBranch: async (branch) => {
      if (!projectRoot) {
        throw new Error("No Project folder to check out a branch in.");
      }

      setSummary(await checkout(projectRoot, branch));
    },
  };
}
