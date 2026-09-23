import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createNodeExecutionCheckoutGitClient } from "./execution-checkout";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function revParse(cwd: string, ref: string) {
  return execFileSync("git", ["-C", cwd, "rev-parse", ref], { encoding: "utf8" }).trim();
}

async function commitOnNewBranch(repoRoot: string, branch: string) {
  git(repoRoot, ["checkout", "-b", branch]);
  await writeFile(join(repoRoot, `${branch}.txt`), `${branch}\n`);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", branch]);
  git(repoRoot, ["checkout", "main"]);
}

async function createRepo() {
  const tempDir = mkdtempSync(join(tmpdir(), "pig-git-"));
  const repoRoot = join(tempDir, "repo");

  await mkdir(repoRoot);
  await writeFile(join(repoRoot, "README.md"), "fixture\n");
  git(tempDir, ["init", "--initial-branch=main", "repo"]);
  git(repoRoot, ["config", "user.name", "Pig Test"]);
  git(repoRoot, ["config", "user.email", "pig@example.com"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "init"]);

  return { tempDir, repoRoot };
}

describe("backend execution checkout git client", () => {
  it("detects Git repositories and creates detached worktrees", async () => {
    const { tempDir, repoRoot } = await createRepo();
    const checkoutRoot = join(tempDir, "pig-worktrees", "session-1");
    const client = createNodeExecutionCheckoutGitClient();

    await expect(client.isGitRepository(repoRoot)).resolves.toBe(true);
    await expect(client.isGitRepository(join(tempDir, "not-a-repo"))).resolves.toBe(false);
    await expect(
      client.addDetachedWorktree({
        repoRoot,
        checkoutRoot,
        sessionId: "session-1",
      }),
    ).resolves.toBeUndefined();

    const worktrees = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });

    expect(worktrees).toContain(checkoutRoot);
    expect(execFileSync("git", ["-C", checkoutRoot, "status", "--short"], {
      encoding: "utf8",
    })).toBe("");
  });

  it("cuts the worktree from HEAD when no base ref is chosen", async () => {
    const { tempDir, repoRoot } = await createRepo();
    await commitOnNewBranch(repoRoot, "feature");
    const checkoutRoot = join(tempDir, "pig-worktrees", "session-1");

    await createNodeExecutionCheckoutGitClient().addDetachedWorktree({
      repoRoot,
      checkoutRoot,
      sessionId: "session-1",
    });

    expect(revParse(checkoutRoot, "HEAD")).toBe(revParse(repoRoot, "main"));
  });

  it("cuts the worktree from the chosen base branch without moving the project", async () => {
    const { tempDir, repoRoot } = await createRepo();
    await commitOnNewBranch(repoRoot, "feature");
    const checkoutRoot = join(tempDir, "pig-worktrees", "session-1");

    await createNodeExecutionCheckoutGitClient().addDetachedWorktree({
      repoRoot,
      checkoutRoot,
      sessionId: "session-1",
      baseRef: "feature",
    });

    expect(revParse(checkoutRoot, "HEAD")).toBe(revParse(repoRoot, "feature"));
    expect(revParse(checkoutRoot, "HEAD")).not.toBe(revParse(repoRoot, "main"));
    expect(
      execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("main");
  });

  // The draft lists remote-only branches by their short name, which git
  // itself cannot resolve under --detach.
  it("resolves a remote-only base branch to its remote-tracking ref", async () => {
    const { tempDir, repoRoot } = await createRepo();
    await commitOnNewBranch(repoRoot, "remote-feat");
    const remoteCommit = revParse(repoRoot, "remote-feat");
    git(repoRoot, ["update-ref", "refs/remotes/origin/remote-feat", remoteCommit]);
    git(repoRoot, ["branch", "-D", "remote-feat"]);
    const checkoutRoot = join(tempDir, "pig-worktrees", "session-1");

    await createNodeExecutionCheckoutGitClient().addDetachedWorktree({
      repoRoot,
      checkoutRoot,
      sessionId: "session-1",
      baseRef: "remote-feat",
    });

    expect(revParse(checkoutRoot, "HEAD")).toBe(remoteCommit);
  });
});
