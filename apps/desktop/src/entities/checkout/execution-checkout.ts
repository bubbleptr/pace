import type { ExecutionCheckout } from "@/entities/runtime/pi-runtime-bridge";
import type { ExecutionCheckoutGitClient } from "@pace/core";

export type { ExecutionCheckoutGitClient } from "@pace/core";

export type ProjectExecutionTarget = {
  id: string;
  repoRoot?: string;
  projectRoot: string;
};

type GitProjectExecutionTarget = ProjectExecutionTarget & {
  repoRoot: string;
};

export type ExecutionCheckoutStrategy = "foreground-local" | "background-managed";

export type PrepareExecutionCheckoutInput = {
  sessionId: string;
  strategy: ExecutionCheckoutStrategy;
  project: ProjectExecutionTarget;
  now?: () => string;
  /** Chat folders must not inherit a parent Git repo as their checkout. */
  skipGit?: boolean;
  /** Branch a managed worktree starts from; ignored by local checkouts. */
  baseRef?: string;
};

export type ExecutionCheckoutManager = {
  prepareCheckout(input: PrepareExecutionCheckoutInput): Promise<ExecutionCheckout>;
};

export type ExecutionCheckoutManagerOptions = {
  worktreesRoot?: string;
  gitClient?: ExecutionCheckoutGitClient;
};

export type ExecutionCheckoutLifecycleEvent = {
  occurredAt: string;
};

function trimTrailingSlash(path: string) {
  if (path === "/") {
    return path;
  }

  return path.replace(/\/+$/, "");
}

function normalizePath(path: string) {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter(Boolean);
  const normalizedParts: string[] = [];

  for (const part of parts) {
    if (part === ".") {
      continue;
    }

    if (part === "..") {
      normalizedParts.pop();
      continue;
    }

    normalizedParts.push(part);
  }

  const normalized = normalizedParts.join("/");

  if (absolute) {
    return `/${normalized}`;
  }

  return normalized || ".";
}

function joinPaths(...parts: string[]) {
  const [first = "", ...rest] = parts;
  const absolute = first.startsWith("/");
  const joined = [first, ...rest]
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/+/g, "/");

  return normalizePath(absolute && !joined.startsWith("/") ? `/${joined}` : joined);
}

function parentPath(path: string) {
  const normalized = trimTrailingSlash(normalizePath(path));
  const index = normalized.lastIndexOf("/");

  if (index <= 0) {
    return "/";
  }

  return normalized.slice(0, index);
}

function basename(path: string) {
  const normalized = trimTrailingSlash(normalizePath(path));
  const index = normalized.lastIndexOf("/");

  return index === -1 ? normalized : normalized.slice(index + 1);
}

function relativePathInside(parent: string, child: string) {
  const normalizedParent = trimTrailingSlash(normalizePath(parent));
  const normalizedChild = trimTrailingSlash(normalizePath(child));

  if (normalizedChild === normalizedParent) {
    return ".";
  }

  const prefix = `${normalizedParent}/`;

  if (!normalizedChild.startsWith(prefix)) {
    throw new Error(`Project root must be inside repo root: ${normalizedChild}`);
  }

  return normalizedChild.slice(prefix.length);
}

function checkoutRuntimeCwd(executionCheckoutRoot: string, projectRelativePath: string) {
  if (projectRelativePath === ".") {
    return executionCheckoutRoot;
  }

  return joinPaths(executionCheckoutRoot, projectRelativePath);
}

function sanitizeSessionId(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function defaultWorktreesRoot(repoRoot: string) {
  return joinPaths(parentPath(repoRoot), ".pig-worktrees", basename(repoRoot));
}

function localCheckout(input: {
  project: ProjectExecutionTarget;
  projectRelativePath: string;
  now: () => string;
}): ExecutionCheckout {
  const projectRoot = trimTrailingSlash(normalizePath(input.project.projectRoot));
  const repoRoot = input.project.repoRoot
    ? trimTrailingSlash(normalizePath(input.project.repoRoot))
    : null;
  const root = repoRoot ?? projectRoot;

  return {
    mode: "foreground-local",
    root,
    repoRoot: repoRoot ?? undefined,
    projectRoot,
    projectRelativePath: input.projectRelativePath,
    executionCheckoutRoot: root,
    diffRoot: repoRoot ?? undefined,
    runtimeCwd: projectRoot,
    sessionBound: false,
    disposable: false,
    cleanupCandidate: false,
    permanent: true,
    createdAt: input.now(),
  };
}

async function isGitRepository(
  gitClient: ExecutionCheckoutGitClient | undefined,
  repoRoot: string,
) {
  if (!gitClient) {
    return true;
  }

  try {
    return await gitClient.isGitRepository(repoRoot);
  } catch {
    return false;
  }
}

async function resolveGitProject(
  project: ProjectExecutionTarget,
  gitClient: ExecutionCheckoutGitClient | undefined,
): Promise<GitProjectExecutionTarget | null> {
  if (project.repoRoot) {
    const canUseRepoRoot = await isGitRepository(gitClient, project.repoRoot);

    return canUseRepoRoot
      ? {
          ...project,
          repoRoot: project.repoRoot,
        }
      : null;
  }

  if (!gitClient) {
    return null;
  }

  const canUseProjectRoot = await isGitRepository(gitClient, project.projectRoot);

  return canUseProjectRoot
    ? {
        ...project,
        repoRoot: project.projectRoot,
      }
    : null;
}

function managedCheckout(input: {
  project: GitProjectExecutionTarget;
  sessionId: string;
  worktreesRoot: string;
  projectRelativePath: string;
  now: () => string;
}): ExecutionCheckout {
  const repoRoot = trimTrailingSlash(normalizePath(input.project.repoRoot));
  const projectRoot = trimTrailingSlash(normalizePath(input.project.projectRoot));
  const executionCheckoutRoot = joinPaths(input.worktreesRoot, sanitizeSessionId(input.sessionId));

  return {
    mode: "managed-worktree",
    root: executionCheckoutRoot,
    repoRoot,
    projectRoot,
    projectRelativePath: input.projectRelativePath,
    executionCheckoutRoot,
    diffRoot: executionCheckoutRoot,
    runtimeCwd: checkoutRuntimeCwd(executionCheckoutRoot, input.projectRelativePath),
    sessionBound: true,
    disposable: true,
    cleanupCandidate: false,
    permanent: false,
    createdAt: input.now(),
  };
}

export function createExecutionCheckoutManager(
  options: ExecutionCheckoutManagerOptions = {},
): ExecutionCheckoutManager {
  return {
    async prepareCheckout(input) {
      const now = input.now ?? (() => new Date().toISOString());
      const project = {
        ...input.project,
        projectRoot: trimTrailingSlash(normalizePath(input.project.projectRoot)),
        repoRoot: input.project.repoRoot
          ? trimTrailingSlash(normalizePath(input.project.repoRoot))
          : undefined,
      };
      const gitProject = input.skipGit
        ? null
        : await resolveGitProject(project, options.gitClient);
      const checkoutProject = gitProject ?? {
        ...project,
        repoRoot: undefined,
      };
      const projectRelativePath = gitProject
        ? relativePathInside(gitProject.repoRoot, gitProject.projectRoot)
        : ".";

      if (input.strategy === "foreground-local") {
        return localCheckout({ project: checkoutProject, projectRelativePath, now });
      }

      if (!gitProject) {
        return localCheckout({ project: checkoutProject, projectRelativePath, now });
      }

      const canUseManagedWorktree = Boolean(options.gitClient);

      if (!canUseManagedWorktree) {
        return localCheckout({ project: checkoutProject, projectRelativePath, now });
      }

      const checkout = managedCheckout({
        project: gitProject,
        sessionId: input.sessionId,
        worktreesRoot: options.worktreesRoot ?? defaultWorktreesRoot(gitProject.repoRoot),
        projectRelativePath,
        now,
      });

      await options.gitClient?.addDetachedWorktree({
        repoRoot: gitProject.repoRoot,
        checkoutRoot: checkout.executionCheckoutRoot ?? checkout.root,
        sessionId: input.sessionId,
        baseRef: input.baseRef,
      });

      return checkout;
    },
  };
}

export function markExecutionCheckoutCleanupCandidate(
  checkout: ExecutionCheckout,
  event: ExecutionCheckoutLifecycleEvent,
): ExecutionCheckout {
  if (checkout.permanent || checkout.mode === "foreground-local") {
    return {
      ...checkout,
      cleanupCandidate: false,
    };
  }

  return {
    ...checkout,
    cleanupCandidate: true,
    cleanupMarkedAt: event.occurredAt,
  };
}

export function promoteExecutionCheckout(
  checkout: ExecutionCheckout,
  event: ExecutionCheckoutLifecycleEvent,
): ExecutionCheckout {
  return {
    ...checkout,
    disposable: false,
    cleanupCandidate: false,
    permanent: true,
    promotedAt: event.occurredAt,
  };
}
