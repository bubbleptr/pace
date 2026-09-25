import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFileMatch, WorkspaceFileSearchResult } from "@pace/core";
import { runGit } from "./session-changes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_WALK_ENTRIES = 20_000;

export type WorkspaceFileSearchInput = {
  root: string;
  query: string;
  limit?: number;
};

export type WorkspaceFileSearcher = {
  search(input: WorkspaceFileSearchInput): Promise<WorkspaceFileSearchResult>;
};

export type WorkspaceFileSearcherOptions = {
  /** Test seam: list root-relative posix file paths. Defaults to git ls-files with a bounded-walk fallback. */
  listPaths?: (root: string) => Promise<string[]>;
};

async function listGitPaths(root: string): Promise<string[] | null> {
  try {
    const result = await runGit({
      cwd: root,
      args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    return result.stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function listWalkedPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [""];
  while (pending.length > 0 && paths.length < MAX_WALK_ENTRIES) {
    const dir = pending.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_WALK_ENTRIES) break;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        pending.push(dir ? `${dir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        paths.push(dir ? `${dir}/${entry.name}` : entry.name);
      }
    }
  }
  return paths;
}

// The renderer never supplies paths; still, anything reported with ".." or
// ".git" segments must not leave the backend.
function isSafeRelativePath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const segments = path.split("/");
  return !segments.includes("..") && !segments.includes(".git");
}

function isSubsequence(needle: string, haystack: string) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

// Lower tier wins: basename prefix > basename contains > path contains >
// plain subsequence.
function matchTier(path: string, query: string) {
  const lower = path.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  if (basename.startsWith(query)) return 0;
  if (basename.includes(query)) return 1;
  if (lower.includes(query)) return 2;
  if (isSubsequence(query, lower)) return 3;
  return -1;
}

export function createWorkspaceFileSearcher(
  options: WorkspaceFileSearcherOptions = {},
): WorkspaceFileSearcher {
  const listPaths =
    options.listPaths ??
    (async (root: string) => (await listGitPaths(root)) ?? (await listWalkedPaths(root)));

  return {
    async search(input) {
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Math.round(input.limit ?? DEFAULT_LIMIT)),
      );
      const files = (await listPaths(input.root)).filter(isSafeRelativePath);
      const entries = new Map<string, WorkspaceFileMatch>();
      for (const file of files) {
        entries.set(file, { path: file, kind: "file" });
        let separator = file.indexOf("/");
        while (separator !== -1) {
          const dir = file.slice(0, separator);
          entries.set(dir, { path: dir, kind: "directory" });
          separator = file.indexOf("/", separator + 1);
        }
      }
      const all = [...entries.values()];
      const query = input.query.toLowerCase();
      const matches =
        query === ""
          ? all.sort((left, right) => left.path.localeCompare(right.path))
          : all
              .map((match) => ({ match, tier: matchTier(match.path, query) }))
              .filter((scored) => scored.tier >= 0)
              .sort(
                (left, right) =>
                  left.tier - right.tier ||
                  left.match.path.length - right.match.path.length ||
                  left.match.path.localeCompare(right.match.path),
              )
              .map((scored) => scored.match);
      return { matches: matches.slice(0, limit), truncated: matches.length > limit };
    },
  };
}
