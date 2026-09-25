// Contracts for the composer's "/" and "@" completion sources (see
// .scratch/composer-prompt-tokens/PRD.md). Read-only catalog: the renderer
// either gets the live Pi session's command set or a disk-resolved static one.

export type PromptCommandKind = "skill" | "prompt" | "extension";

export type PromptCommand = {
  kind: PromptCommandKind;
  /** Display name without any prefix: "review-pr", "fix", "deploy". */
  name: string;
  /** Exactly what follows "/" when sent to Pi: "skill:review-pr" | "fix" | "deploy". */
  invocation: string;
  description?: string;
};

export type PromptCommandCatalog = {
  /** "runtime": read from the live Pi session (includes extension commands). "static": resolved from disk, never includes extension commands. */
  source: "runtime" | "static";
  commands: PromptCommand[];
};

export type WorkspaceFileMatch = {
  /** Posix, root-relative, no leading "./"; directories WITHOUT trailing slash. */
  path: string;
  kind: "file" | "directory";
};

export type WorkspaceFileSearchResult = {
  matches: WorkspaceFileMatch[];
  truncated: boolean;
};

const PROMPT_COMMAND_KIND_ORDER: Record<PromptCommandKind, number> = {
  skill: 0,
  prompt: 1,
  extension: 2,
};

/** Contract ordering: kind first (skill → prompt → extension), then name. */
export function sortPromptCommands(commands: readonly PromptCommand[]): PromptCommand[] {
  return [...commands].sort(
    (left, right) =>
      PROMPT_COMMAND_KIND_ORDER[left.kind] - PROMPT_COMMAND_KIND_ORDER[right.kind] ||
      left.name.localeCompare(right.name),
  );
}
