import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ProjectGitSummary,
  SessionChangedFile,
  SessionChangedFileKind,
  SessionChanges,
} from "@pace/core";

const MAX_FILES = 200;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export type ReadSessionChangesInput = {
  sessionId: string;
  checkoutRoot: string;
  diffRoot: string;
};

export type CheckoutSessionBranchInput = ReadSessionChangesInput & {
  branch: string;
};

export type SessionChangesReader = {
  read(input: ReadSessionChangesInput): Promise<SessionChanges>;
  checkoutBranch(input: CheckoutSessionBranchInput): Promise<SessionChanges>;
};

export type ReadProjectGitInput = {
  projectRoot: string;
};

export type CheckoutProjectBranchInput = ReadProjectGitInput & {
  branch: string;
};

/**
 * Branch state of a Project folder, read before any Session exists. Separate
 * from SessionChangesReader on purpose: that one answers about a Session's
 * checkout and may only run once there is one (#268), while the Session Draft
 * asks about a Project the user has merely selected.
 */
export type ProjectGitReader = {
  read(input: ReadProjectGitInput): Promise<ProjectGitSummary>;
  checkoutBranch(input: CheckoutProjectBranchInput): Promise<ProjectGitSummary>;
};

type GitResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
};

type StatusEntry = {
  repoPath: string;
  previousRepoPath?: string;
  kind: SessionChangedFileKind;
  staged: boolean;
  unstaged: boolean;
};

class GitOutputLimitError extends Error {}

function isInside(parent: string, child: string) {
  const path = relative(parent, child);

  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function assertSafeGitPath(path: string) {
  if (
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").includes("..")
  ) {
    throw new Error("Git returned an invalid changed-file path.");
  }

  const normalized = resolve("/", path);

  if (!isInside("/", normalized) || normalized === "/") {
    throw new Error("Git returned a changed-file path outside the repository.");
  }
}

function literalPathspec(path: string) {
  assertSafeGitPath(path);
  return `:(top,literal)${path}`;
}

function splitPrefix(record: string, fieldCount: number) {
  const fields: string[] = [];
  let cursor = 0;

  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(" ", cursor);

    if (separator === -1) {
      throw new Error("Git returned malformed porcelain status output.");
    }

    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }

  return { fields, remainder: record.slice(cursor) };
}

function kindFromStatus(code: string): SessionChangedFileKind {
  if (code.includes("U") || code === "AA" || code === "DD") {
    return "conflicted";
  }
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type-changed";
  return "modified";
}

function statusFlags(code: string) {
  return {
    staged: code[0] !== ".",
    unstaged: code[1] !== ".",
  };
}

function parseGitStatus(output: Buffer): StatusEntry[] {
  const records = output.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (!record || record.startsWith("# ") || record.startsWith("! ")) {
      continue;
    }

    if (record.startsWith("? ")) {
      const repoPath = record.slice(2);
      assertSafeGitPath(repoPath);
      entries.push({
        repoPath,
        kind: "untracked",
        staged: false,
        unstaged: true,
      });
      continue;
    }

    if (record.startsWith("1 ")) {
      const { fields, remainder: repoPath } = splitPrefix(record, 8);
      const code = fields[1] ?? "..";
      assertSafeGitPath(repoPath);
      entries.push({
        repoPath,
        kind: kindFromStatus(code),
        ...statusFlags(code),
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      const { fields, remainder: repoPath } = splitPrefix(record, 9);
      const previousRepoPath = records[index + 1];

      if (!previousRepoPath) {
        throw new Error("Git returned a rename without its original path.");
      }

      index += 1;
      const code = fields[1] ?? "..";
      assertSafeGitPath(repoPath);
      assertSafeGitPath(previousRepoPath);
      entries.push({
        repoPath,
        previousRepoPath,
        kind: kindFromStatus(code),
        ...statusFlags(code),
      });
      continue;
    }

    if (record.startsWith("u ")) {
      const { remainder: repoPath } = splitPrefix(record, 10);
      assertSafeGitPath(repoPath);
      entries.push({
        repoPath,
        kind: "conflicted",
        staged: true,
        unstaged: true,
      });
      continue;
    }

    throw new Error("Git returned an unsupported porcelain status record.");
  }

  return entries;
}

export async function runGit(input: {
  cwd: string;
  args: string[];
  allowExitCodes?: number[];
  maxStdoutBytes?: number;
}): Promise<GitResult> {
  const allowExitCodes = input.allowExitCodes ?? [0];
  const maxStdoutBytes = input.maxStdoutBytes ?? 1024 * 1024;

  return new Promise((resolveResult, reject) => {
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      finishWithError(
        new Error(`Git command timed out: git ${input.args[0] ?? ""}`),
      );
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        finishWithError(
          new GitOutputLimitError("Git output exceeded the configured limit."),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (
        stderr.reduce((total, item) => total + item.byteLength, 0) <
        64 * 1024
      ) {
        stderr.push(chunk);
      }
    });
    child.on("error", finishWithError);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
      };

      if (!allowExitCodes.includes(result.exitCode)) {
        const detail = result.stderr.toString("utf8").trim();
        reject(new Error(detail || `Git exited with code ${result.exitCode}.`));
        return;
      }

      resolveResult(result);
    });
  });
}

function parseNumstat(output: Buffer) {
  let additions = 0;
  let deletions = 0;
  let binary = false;

  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);

    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);

    if (added === "-" || deleted === "-") {
      binary = true;
      continue;
    }

    additions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(deleted, 10) || 0;
  }

  return {
    additions: binary ? null : additions,
    deletions: binary ? null : deletions,
    binary,
  };
}

function scopedPathspec(repositoryRoot: string, diffRoot: string) {
  const path = relative(repositoryRoot, diffRoot);

  return path ? ["--", literalPathspec(path)] : [];
}

function displayPath(repositoryRoot: string, diffRoot: string, repoPath: string) {
  const absolutePath = resolve(repositoryRoot, repoPath);

  if (!isInside(diffRoot, absolutePath)) {
    throw new Error("Git returned a changed-file path outside the Session diff root.");
  }

  return relative(diffRoot, absolutePath) || repoPath;
}

function assertLocalBranchName(branch: string) {
  if (!branch || branch.startsWith("-") || branch.includes("..") || /\s/.test(branch)) {
    throw new Error(`Unknown local branch "${branch}".`);
  }
}

async function inspectCheckout(input: {
  checkoutRoot: string;
  diffRoot: string;
}): Promise<
  | { kind: "non-git"; checkoutRoot: string }
  | { kind: "git"; checkoutRoot: string; diffRoot: string; repositoryRoot: string }
> {
  const checkoutRoot = await realpath(input.checkoutRoot);
  const diffRoot = await realpath(input.diffRoot);

  if (!isInside(checkoutRoot, diffRoot)) {
    throw new Error("Session diff root must be inside its execution checkout.");
  }

  const topLevelResult = await runGit({
    cwd: diffRoot,
    args: ["rev-parse", "--show-toplevel"],
    allowExitCodes: [0, 128],
  });

  if (topLevelResult.exitCode === 128) {
    const detail = topLevelResult.stderr.toString("utf8").trim();

    if (!/not a git repository|not a git work tree/i.test(detail)) {
      throw new Error(detail || "Git could not inspect the Session checkout.");
    }

    return { kind: "non-git", checkoutRoot };
  }

  const repositoryRoot = await realpath(
    topLevelResult.stdout.toString("utf8").trim(),
  );

  if (!isInside(checkoutRoot, repositoryRoot) || !isInside(repositoryRoot, diffRoot)) {
    throw new Error("Session Git repository must stay inside its execution checkout.");
  }

  return { kind: "git", checkoutRoot, diffRoot, repositoryRoot };
}

async function listLocalBranches(repositoryRoot: string) {
  const result = await runGit({
    cwd: repositoryRoot,
    args: [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=refname",
      "refs/heads",
    ],
  });

  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Short names of remote-tracking refs (origin/feat/x → feat/x), matching
// Cursor's picker. origin wins when two remotes share a name. Symbolic
// remote HEAD is not a branch the user can switch onto.
async function listRemoteTrackingBranches(repositoryRoot: string) {
  const result = await runGit({
    cwd: repositoryRoot,
    args: [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=refname",
      "refs/remotes",
    ],
  });
  const byName = new Map<string, string>();

  for (const ref of result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const remote = ref.slice(0, slash);
    const name = ref.slice(slash + 1);
    if (!name || name === "HEAD") continue;
    const existing = byName.get(name);
    if (!existing || remote === "origin") {
      byName.set(name, ref);
    }
  }

  return byName;
}

function mergeBranchNames(
  headBranch: string | null,
  localBranches: string[],
  remoteTracking: Map<string, string>,
) {
  const local = new Set(localBranches);
  const remoteOnly = [...remoteTracking.keys()].filter((name) => !local.has(name));
  const rest = [
    ...localBranches.filter((name) => name !== headBranch),
    ...remoteOnly,
  ];

  return headBranch ? [headBranch, ...rest.filter((name) => name !== headBranch)] : rest;
}

function parseWorktreeList(stdout: string) {
  const records: Array<{ path: string; branch: string | null }> = [];

  for (const block of stdout.split(/\n\n+/)) {
    let path: string | undefined;
    let branch: string | null = null;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }

    if (path) {
      records.push({ path, branch });
    }
  }

  return records;
}

async function listOccupiedBranches(repositoryRoot: string) {
  const result = await runGit({
    cwd: repositoryRoot,
    args: ["worktree", "list", "--porcelain"],
  });
  const current = await realpath(repositoryRoot);
  const occupied: Array<{ branch: string; path: string }> = [];

  for (const record of parseWorktreeList(result.stdout.toString("utf8"))) {
    if (!record.branch) {
      continue;
    }

    const path = await realpath(record.path);
    if (path === current) {
      continue;
    }

    occupied.push({ branch: record.branch, path });
  }

  return occupied;
}

function emptyResult(input: {
  sessionId: string;
  checkoutRoot: string;
  repositoryRoot: string | null;
  state: "clean" | "non-git";
  head?: SessionChanges["head"];
  branches?: string[];
  occupiedBranches?: SessionChanges["occupiedBranches"];
}): SessionChanges {
  return {
    sessionId: input.sessionId,
    state: input.state,
    checkoutRoot: input.checkoutRoot,
    repositoryRoot: input.repositoryRoot,
    generatedAt: new Date().toISOString(),
    head: input.head,
    branches: input.branches ?? [],
    occupiedBranches: input.occupiedBranches ?? [],
    files: [],
    totals: {
      files: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      conflictedFiles: 0,
    },
    truncated: false,
    omittedFileCount: 0,
  };
}

async function readPatch(input: {
  repositoryRoot: string;
  entry: StatusEntry;
  hasHead: boolean;
}) {
  const paths = [input.entry.previousRepoPath, input.entry.repoPath]
    .filter((path): path is string => Boolean(path))
    .map(literalPathspec);
  const untracked = input.entry.kind === "untracked" || !input.hasHead;
  // The renderer parses these patches with @pierre/diffs, whose header regex only
  // accepts `diff --git a/... b/...`. Git otherwise honours the user's config and
  // emits `c/`+`w/` under diff.mnemonicPrefix, `1/`+`2/` under --no-index, or no
  // prefix at all under diff.noprefix — each of which fails to parse. Pin the
  // prefixes so the patch shape never depends on developer git config.
  const prefixArgs = ["--src-prefix=a/", "--dst-prefix=b/"];
  const baseArgs = untracked
    ? [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...prefixArgs,
        "--unified=3",
        "--",
        "/dev/null",
        input.entry.repoPath,
      ]
    : [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--no-color",
        ...prefixArgs,
        "--unified=3",
        "HEAD",
        "--",
        ...paths,
      ];
  const numstatArgs = untracked
    ? [
        "diff",
        "--no-index",
        "--numstat",
        "-z",
        "--",
        "/dev/null",
        input.entry.repoPath,
      ]
    : ["diff", "--numstat", "-z", "--no-renames", "HEAD", "--", ...paths];
  const allowExitCodes = untracked ? [0, 1] : [0];
  const stats = parseNumstat(
    (
      await runGit({
        cwd: input.repositoryRoot,
        args: numstatArgs,
        allowExitCodes,
        maxStdoutBytes: 512 * 1024,
      })
    ).stdout,
  );

  try {
    const patch = (
      await runGit({
        cwd: input.repositoryRoot,
        args: baseArgs,
        allowExitCodes,
        maxStdoutBytes: MAX_PATCH_BYTES,
      })
    ).stdout.toString("utf8");

    return { ...stats, patch: patch || undefined, patchTruncated: false };
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      return { ...stats, patch: undefined, patchTruncated: true };
    }
    throw error;
  }
}

async function readHeadBranch(repositoryRoot: string) {
  const result = await runGit({
    cwd: repositoryRoot,
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    allowExitCodes: [0, 1],
  });

  return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
}

async function readBranchNames(repositoryRoot: string) {
  const headBranch = await readHeadBranch(repositoryRoot);

  return mergeBranchNames(
    headBranch,
    await listLocalBranches(repositoryRoot),
    await listRemoteTrackingBranches(repositoryRoot),
  );
}

/**
 * The commit-ish a worktree can start from for a name the branch pickers
 * list. Remote-only names are listed by their short name, which git cannot
 * resolve on its own, so they map back to their remote-tracking ref.
 */
export async function resolveBranchStartPoint(repositoryRoot: string, branch: string) {
  assertLocalBranchName(branch);

  if ((await listLocalBranches(repositoryRoot)).includes(branch)) {
    return `refs/heads/${branch}`;
  }

  const remoteRef = (await listRemoteTrackingBranches(repositoryRoot)).get(branch);

  if (!remoteRef) {
    throw new Error(`Unknown branch "${branch}".`);
  }

  return `refs/remotes/${remoteRef}`;
}

/**
 * Move a repository onto `branch`, creating a local tracking branch when the
 * name only exists on a remote. Shared by the Session composer's branch picker
 * and the Session Draft's, which run the same switch against different roots.
 */
async function switchBranch(repositoryRoot: string, branch: string) {
  assertLocalBranchName(branch);

  const localBranches = await listLocalBranches(repositoryRoot);
  const remoteTracking = await listRemoteTrackingBranches(repositoryRoot);
  const startPoint = remoteTracking.get(branch);

  if (!localBranches.includes(branch) && !startPoint) {
    throw new Error(`Unknown local branch "${branch}".`);
  }

  const occupied = (await listOccupiedBranches(repositoryRoot)).find(
    (item) => item.branch === branch,
  );

  if (occupied) {
    throw new Error(
      `Branch "${branch}" is already checked out in ${occupied.path}.`,
    );
  }

  if ((await readHeadBranch(repositoryRoot)) === branch) {
    return;
  }

  if (localBranches.includes(branch)) {
    await runGit({
      cwd: repositoryRoot,
      args: ["switch", "--no-guess", "--", branch],
    });
    return;
  }

  await runGit({
    cwd: repositoryRoot,
    args: ["switch", "-c", branch, "--track", "--", startPoint as string],
  });
}

/**
 * Git top level of a Project folder, or null when it is not in a repository.
 * Unlike a Session checkout there is no containment rule to enforce: the
 * Project root is what the user registered.
 */
async function projectRepositoryRoot(projectRoot: string) {
  const root = await realpath(projectRoot);
  const result = await runGit({
    cwd: root,
    args: ["rev-parse", "--show-toplevel"],
    allowExitCodes: [0, 128],
  });

  if (result.exitCode === 128) {
    return null;
  }

  return realpath(result.stdout.toString("utf8").trim());
}

export function createNodeSessionChangesReader(): SessionChangesReader {
  const reader: SessionChangesReader = {
    async checkoutBranch(input) {
      const inspected = await inspectCheckout(input);

      if (inspected.kind === "non-git") {
        throw new Error("Session checkout is not a Git repository.");
      }

      await switchBranch(inspected.repositoryRoot, input.branch);

      return reader.read(input);
    },

    async read(input) {
      const inspected = await inspectCheckout(input);

      if (inspected.kind === "non-git") {
        return emptyResult({
          sessionId: input.sessionId,
          checkoutRoot: inspected.checkoutRoot,
          repositoryRoot: null,
          state: "non-git",
        });
      }

      const { checkoutRoot, diffRoot, repositoryRoot } = inspected;

      const oidResult = await runGit({
        cwd: repositoryRoot,
        args: ["rev-parse", "--verify", "--quiet", "HEAD"],
        allowExitCodes: [0, 1],
      });
      const hasHead = oidResult.exitCode === 0;
      const branchResult = await runGit({
        cwd: repositoryRoot,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowExitCodes: [0, 1],
      });
      const head = {
        oid: hasHead ? oidResult.stdout.toString("utf8").trim() : null,
        branch:
          branchResult.exitCode === 0
            ? branchResult.stdout.toString("utf8").trim()
            : null,
        detached: hasHead && branchResult.exitCode !== 0,
      };
      const localBranches = await listLocalBranches(repositoryRoot);
      const remoteTracking = await listRemoteTrackingBranches(repositoryRoot);
      const branches = mergeBranchNames(
        head.branch,
        localBranches,
        remoteTracking,
      );
      const occupiedBranches = await listOccupiedBranches(repositoryRoot);
      const status = await runGit({
        cwd: repositoryRoot,
        args: [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          ...scopedPathspec(repositoryRoot, diffRoot),
        ],
        maxStdoutBytes: MAX_STATUS_BYTES,
      });
      const allEntries = parseGitStatus(status.stdout);

      if (!allEntries.length) {
        return emptyResult({
          sessionId: input.sessionId,
          checkoutRoot,
          repositoryRoot,
          state: "clean",
          head,
          branches,
          occupiedBranches,
        });
      }

      const entries = allEntries.slice(0, MAX_FILES);
      const files: SessionChangedFile[] = [];
      let patchBytes = 0;

      for (const entry of entries) {
        const display = displayPath(repositoryRoot, diffRoot, entry.repoPath);
        const previousDisplay = entry.previousRepoPath
          ? displayPath(repositoryRoot, diffRoot, entry.previousRepoPath)
          : undefined;
        const diff =
          entry.kind === "conflicted"
            ? {
                additions: null,
                deletions: null,
                binary: false,
                patch: undefined,
                patchTruncated: false,
              }
            : await readPatch({ repositoryRoot, entry, hasHead });
        const nextPatchBytes = diff.patch ? Buffer.byteLength(diff.patch) : 0;
        const exceedsTotalLimit = patchBytes + nextPatchBytes > MAX_TOTAL_PATCH_BYTES;

        if (!exceedsTotalLimit) patchBytes += nextPatchBytes;
        files.push({
          path: display,
          previousPath: previousDisplay,
          kind: entry.kind,
          staged: entry.staged,
          unstaged: entry.unstaged,
          additions: diff.additions,
          deletions: diff.deletions,
          binary: diff.binary,
          patch: exceedsTotalLimit ? undefined : diff.patch,
          patchTruncated: diff.patchTruncated || exceedsTotalLimit,
        });
      }

      const totals = files.reduce(
        (result, file) => ({
          files: result.files + 1,
          additions: result.additions + (file.additions ?? 0),
          deletions: result.deletions + (file.deletions ?? 0),
          binaryFiles: result.binaryFiles + Number(file.binary),
          conflictedFiles:
            result.conflictedFiles + Number(file.kind === "conflicted"),
        }),
        {
          files: 0,
          additions: 0,
          deletions: 0,
          binaryFiles: 0,
          conflictedFiles: 0,
        },
      );

      return {
        sessionId: input.sessionId,
        state: "ready",
        checkoutRoot,
        repositoryRoot,
        generatedAt: new Date().toISOString(),
        head,
        branches,
        occupiedBranches,
        files,
        totals,
        truncated:
          allEntries.length > files.length ||
          files.some((file) => file.patchTruncated),
        omittedFileCount: allEntries.length - files.length,
      };
    },
  };

  return reader;
}

export function createNodeProjectGitReader(): ProjectGitReader {
  const reader: ProjectGitReader = {
    async read(input) {
      const projectRoot = await realpath(input.projectRoot);
      const repositoryRoot = await projectRepositoryRoot(projectRoot);

      if (!repositoryRoot) {
        return { projectRoot, branch: null, branches: [] };
      }

      return {
        projectRoot,
        branch: await readHeadBranch(repositoryRoot),
        branches: await readBranchNames(repositoryRoot),
      };
    },

    async checkoutBranch(input) {
      const repositoryRoot = await projectRepositoryRoot(input.projectRoot);

      if (!repositoryRoot) {
        throw new Error("Project folder is not a Git repository.");
      }

      await switchBranch(repositoryRoot, input.branch);

      return reader.read(input);
    },
  };

  return reader;
}
