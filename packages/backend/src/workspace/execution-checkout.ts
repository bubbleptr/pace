import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { ExecutionCheckoutGitClient } from "@pace/core";
import { resolveBranchStartPoint } from "./session-changes";

const execFileAsync = promisify(execFile);

export function createNodeExecutionCheckoutGitClient(): ExecutionCheckoutGitClient {
  return {
    async isGitRepository(repoRoot) {
      try {
        const { stdout } = await execFileAsync("git", [
          "-C",
          repoRoot,
          "rev-parse",
          "--is-inside-work-tree",
        ]);

        return stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async addDetachedWorktree(input) {
      if (!input.sessionId.trim()) {
        throw new Error("session id is required to create a worktree");
      }

      const startPoint = input.baseRef
        ? await resolveBranchStartPoint(input.repoRoot, input.baseRef)
        : "HEAD";

      await mkdir(dirname(input.checkoutRoot), { recursive: true });

      try {
        await execFileAsync("git", [
          "-C",
          input.repoRoot,
          "worktree",
          "add",
          "--detach",
          input.checkoutRoot,
          startPoint,
        ]);
      } catch (error) {
        throw new Error(`git worktree add failed: ${stderrFromError(error)}`);
      }
    },
  };
}

function stderrFromError(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) {
      return stderr;
    }
  }

  return error instanceof Error ? error.message : String(error);
}
