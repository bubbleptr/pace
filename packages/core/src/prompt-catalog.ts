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

/**
 * Names declared by Pi 0.87.1's `dist/core/slash-commands.js`. These are TUI
 * commands — Pi's session prompt path never sees them, so Pace must not send
 * them as prompts (the composer blocks submit instead). Not publicly exported
 * by Pi; `packages/backend/src/workspace/pi-tui-builtins.test.ts` guards
 * against drift when the Pi dependency moves.
 */
export const PI_TUI_BUILTIN_COMMANDS: readonly string[] = [
  "bug",
  "changelog",
  "clone",
  "compact",
  "copy",
  "export",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "thinking",
  "tree",
  "trust",
];

/** Contract ordering: kind first (skill → prompt → extension), then name. */
export function sortPromptCommands(commands: readonly PromptCommand[]): PromptCommand[] {
  return [...commands].sort(
    (left, right) =>
      PROMPT_COMMAND_KIND_ORDER[left.kind] - PROMPT_COMMAND_KIND_ORDER[right.kind] ||
      left.name.localeCompare(right.name),
  );
}
