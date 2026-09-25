import { useMemo } from "react";
import type { WorkspaceFileMatch, WorkspaceFileSearchResult } from "@pace/core";
import { invoke } from "@/shared/runtime";
import type { PromptCommandTarget } from "@/entities/prompt-command";

/** Same shape as PromptCommandTarget: a live Session or a Project root. */
export type WorkspaceFileSearchTarget = PromptCommandTarget;

const FILE_SEARCH_LIMIT = 50;

/**
 * A stable `(query) => matches` bound to the target, or null when there is
 * no workspace to search (Chat workspace sessions included — callers pass
 * null for those). Callers feed it to the "@" trigger and the Reference
 * file palette.
 */
export function useWorkspaceFileSearch(
  target: WorkspaceFileSearchTarget | null,
): ((query: string) => Promise<WorkspaceFileMatch[]>) | null {
  const sessionId = target && "sessionId" in target ? target.sessionId : null;
  const projectRoot = target && "projectRoot" in target ? target.projectRoot : null;

  return useMemo(() => {
    if (sessionId === null && projectRoot === null) {
      return null;
    }
    const scope = sessionId !== null ? { sessionId } : { projectRoot };
    return (query: string) =>
      invoke<WorkspaceFileSearchResult>("search_workspace_files", {
        ...scope,
        query,
        limit: FILE_SEARCH_LIMIT,
      }).then((result) => result.matches);
  }, [sessionId, projectRoot]);
}
