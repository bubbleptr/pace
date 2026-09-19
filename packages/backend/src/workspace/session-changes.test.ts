import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeProjectGitReader,
  createNodeSessionChangesReader,
} from "./session-changes";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "pigui-session-changes-"));
  tempDirs.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });
}

async function gitStdout(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.toString().trim();
}

async function repository() {
  const root = await tempDirectory();

  await git(root, "init");
  await git(root, "config", "user.name", "Pace Tests");
  await git(root, "config", "user.email", "pigui@example.test");
  await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
  await writeFile(join(root, "old name.txt"), "rename me\n", "utf8");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await git(root, "add", ".");
  await git(root, "commit", "-m", "test baseline");

  return root;
}

async function repositoryWithOrigin() {
  const root = await repository();
  const origin = await tempDirectory();
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  const current = await gitStdout(root, "symbolic-ref", "--short", "HEAD");
  await git(root, "push", "-u", "origin", current);

  return { root, current };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session changes reader", () => {
  it("distinguishes non-Git and clean checkouts", async () => {
    const nonGitRoot = await tempDirectory();
    const cleanRoot = await repository();
    const reader = createNodeSessionChangesReader();

    await expect(
      reader.read({
        sessionId: "non-git",
        checkoutRoot: nonGitRoot,
        diffRoot: nonGitRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId: "non-git",
        state: "non-git",
        repositoryRoot: null,
        files: [],
      }),
    );
    await expect(
      reader.read({
        sessionId: "clean",
        checkoutRoot: cleanRoot,
        diffRoot: cleanRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId: "clean",
        state: "clean",
        repositoryRoot: await realpath(cleanRoot),
        head: expect.objectContaining({ oid: expect.any(String) }),
        branches: expect.arrayContaining([
          expect.stringMatching(/^(main|master)$/),
        ]),
        files: [],
      }),
    );
  });

  it("lists every local branch, current first", async () => {
    const root = await repository();
    await git(root, "branch", "feat/composer-git");
    await git(root, "branch", "fix/spacing");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "branches",
      checkoutRoot: root,
      diffRoot: root,
    });
    const current =
      result.head?.branch ??
      (result.branches?.[0] as string | undefined);

    expect(current).toMatch(/^(main|master)$/);
    expect(result.branches?.[0]).toBe(current);
    expect(result.branches).toEqual(
      expect.arrayContaining([current, "feat/composer-git", "fix/spacing"]),
    );
    expect(result.branches).toHaveLength(3);
  });

  it("lists remote-tracking branches that have no local head, without an origin/ prefix", async () => {
    const { root, current } = await repositoryWithOrigin();
    await git(root, "push", "origin", `${current}:feat/composer-git`);
    await git(root, "fetch", "origin");
    await git(root, "branch", "fix/spacing");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "remotes",
      checkoutRoot: root,
      diffRoot: root,
    });

    expect(result.branches?.[0]).toBe(current);
    expect(result.branches).toEqual(
      expect.arrayContaining([current, "feat/composer-git", "fix/spacing"]),
    );
    expect(result.branches).not.toContain("origin/feat/composer-git");
    expect(result.branches?.filter((name) => name === "feat/composer-git")).toHaveLength(
      1,
    );
  });

  it("does not list a remote-tracking name that already exists as a local head", async () => {
    const { root, current } = await repositoryWithOrigin();
    await git(root, "branch", "feat/composer-git");
    await git(root, "push", "origin", "feat/composer-git");
    await git(root, "fetch", "origin");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "remote-dup",
      checkoutRoot: root,
      diffRoot: root,
    });

    expect(result.branches).toEqual(
      expect.arrayContaining([current, "feat/composer-git"]),
    );
    expect(result.branches?.filter((name) => name === "feat/composer-git")).toHaveLength(
      1,
    );
  });

  it("switches the Session checkout onto the named local branch", async () => {
    const root = await repository();
    await git(root, "branch", "feat/composer-git");
    const reader = createNodeSessionChangesReader();

    const result = await reader.checkoutBranch({
      sessionId: "switch",
      checkoutRoot: root,
      diffRoot: root,
      branch: "feat/composer-git",
    });

    expect(result.head?.branch).toBe("feat/composer-git");
    expect(result.head?.detached).toBe(false);
    await expect(gitStdout(root, "symbolic-ref", "--short", "HEAD")).resolves.toBe(
      "feat/composer-git",
    );
  });

  it("creates a local tracking branch when switching onto a remote-only name", async () => {
    const { root, current } = await repositoryWithOrigin();
    await git(root, "push", "origin", `${current}:feat/composer-git`);
    await git(root, "fetch", "origin");
    const reader = createNodeSessionChangesReader();

    const result = await reader.checkoutBranch({
      sessionId: "remote-switch",
      checkoutRoot: root,
      diffRoot: root,
      branch: "feat/composer-git",
    });

    expect(result.head?.branch).toBe("feat/composer-git");
    expect(result.head?.detached).toBe(false);
    await expect(gitStdout(root, "symbolic-ref", "--short", "HEAD")).resolves.toBe(
      "feat/composer-git",
    );
    await expect(
      gitStdout(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).resolves.toBe("origin/feat/composer-git");
    expect(result.branches).toEqual(
      expect.arrayContaining([current, "feat/composer-git"]),
    );
  });

  it("refuses names that are not local branches and leaves HEAD where it was", async () => {
    const root = await repository();
    const reader = createNodeSessionChangesReader();
    const before = await gitStdout(root, "symbolic-ref", "--short", "HEAD");

    await expect(
      reader.checkoutBranch({
        sessionId: "unknown",
        checkoutRoot: root,
        diffRoot: root,
        branch: "no-such-branch",
      }),
    ).rejects.toThrow(/unknown local branch/i);
    await expect(gitStdout(root, "symbolic-ref", "--short", "HEAD")).resolves.toBe(
      before,
    );
  });

  it("refuses to switch when Git would overwrite local changes", async () => {
    const root = await repository();
    const origin = await gitStdout(root, "symbolic-ref", "--short", "HEAD");
    await git(root, "checkout", "-b", "feat/composer-git");
    await writeFile(join(root, "tracked.txt"), "on feature\n", "utf8");
    await git(root, "commit", "-am", "feature edit");
    await git(root, "checkout", origin);
    await writeFile(join(root, "tracked.txt"), "dirty on origin\n", "utf8");

    await expect(
      createNodeSessionChangesReader().checkoutBranch({
        sessionId: "dirty",
        checkoutRoot: root,
        diffRoot: root,
        branch: "feat/composer-git",
      }),
    ).rejects.toThrow(/would be overwritten|local changes/i);
    await expect(gitStdout(root, "symbolic-ref", "--short", "HEAD")).resolves.toBe(
      origin,
    );
  });

  it("marks branches already checked out in another worktree as occupied", async () => {
    const root = await repository();
    const origin = await gitStdout(root, "symbolic-ref", "--short", "HEAD");
    await git(root, "branch", "feat/locked");
    const worktree = join(await tempDirectory(), "locked-wt");
    await git(root, "worktree", "add", worktree, "feat/locked");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "occupied",
      checkoutRoot: root,
      diffRoot: root,
    });

    expect(result.occupiedBranches).toEqual([
      {
        branch: "feat/locked",
        path: await realpath(worktree),
      },
    ]);
    expect(result.occupiedBranches?.some((item) => item.branch === origin)).toBe(
      false,
    );
  });

  it("refuses to switch onto a branch another worktree already holds", async () => {
    const root = await repository();
    const origin = await gitStdout(root, "symbolic-ref", "--short", "HEAD");
    await git(root, "branch", "feat/locked");
    const worktree = join(await tempDirectory(), "locked-wt");
    await git(root, "worktree", "add", worktree, "feat/locked");

    await expect(
      createNodeSessionChangesReader().checkoutBranch({
        sessionId: "occupied-switch",
        checkoutRoot: root,
        diffRoot: root,
        branch: "feat/locked",
      }),
    ).rejects.toThrow(/already checked out/i);
    await expect(gitStdout(root, "symbolic-ref", "--short", "HEAD")).resolves.toBe(
      origin,
    );
  });

  it("returns bounded patches and Git status for staged, unstaged, renamed, untracked, and binary files", async () => {
    const root = await repository();
    const reader = createNodeSessionChangesReader();

    await writeFile(join(root, "tracked.txt"), "staged\n", "utf8");
    await git(root, "add", "tracked.txt");
    await appendFile(join(root, "tracked.txt"), "unstaged\n", "utf8");
    await git(root, "mv", "old name.txt", "new name.txt");
    await writeFile(join(root, "untracked file.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 9, 8, 7]));

    const result = await reader.read({
      sessionId: "changed",
      checkoutRoot: root,
      diffRoot: root,
    });

    expect(result.state).toBe("ready");
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tracked.txt",
          kind: "modified",
          staged: true,
          unstaged: true,
          additions: 2,
          deletions: 1,
          patch: expect.stringContaining("+unstaged"),
        }),
        expect.objectContaining({
          path: "new name.txt",
          previousPath: "old name.txt",
          kind: "renamed",
          staged: true,
        }),
        expect.objectContaining({
          path: "untracked file.ts",
          kind: "untracked",
          additions: 1,
          deletions: 0,
          patch: expect.stringContaining("export const value"),
        }),
        expect.objectContaining({
          path: "binary.bin",
          binary: true,
          additions: null,
          deletions: null,
        }),
      ]),
    );
    expect(result.totals).toEqual(
      expect.objectContaining({ files: 4, binaryFiles: 1 }),
    );
  });

  it("scopes changes to the Session diff root", async () => {
    const root = await repository();
    const projectRoot = join(root, "packages", "app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "inside.ts"), "inside\n", "utf8");
    await writeFile(join(root, "outside.ts"), "outside\n", "utf8");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "scoped",
      checkoutRoot: root,
      diffRoot: projectRoot,
    });

    expect(result.files.map((file) => file.path)).toEqual(["inside.ts"]);
  });

  it("reads changes from a repository without an initial commit", async () => {
    const root = await tempDirectory();
    await git(root, "init");
    await writeFile(join(root, "first.txt"), "first change\n", "utf8");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "unborn",
      checkoutRoot: root,
      diffRoot: root,
    });

    expect(result).toEqual(
      expect.objectContaining({
        state: "ready",
        head: expect.objectContaining({ oid: null, detached: false }),
        files: [
          expect.objectContaining({
            path: "first.txt",
            kind: "untracked",
            additions: 1,
            patch: expect.stringContaining("first change"),
          }),
        ],
      }),
    );
  });

  it("omits oversized patches instead of returning invalid partial patches", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), `${"x".repeat(600_000)}\n`, "utf8");

    const result = await createNodeSessionChangesReader().read({
      sessionId: "large",
      checkoutRoot: root,
      diffRoot: root,
    });
    const file = result.files.find((candidate) => candidate.path === "tracked.txt");

    expect(result.truncated).toBe(true);
    expect(file).toEqual(
      expect.objectContaining({ patch: undefined, patchTruncated: true }),
    );
  });

  it("rejects diff roots outside the execution checkout", async () => {
    const checkoutRoot = await tempDirectory();
    const outsideRoot = await repository();

    await expect(
      createNodeSessionChangesReader().read({
        sessionId: "escaped",
        checkoutRoot,
        diffRoot: outsideRoot,
      }),
    ).rejects.toThrow("inside its execution checkout");
  });
});

describe("project git summary", () => {
  it("reads the current branch and the switchable names for a Project", async () => {
    const { root, current } = await repositoryWithOrigin();
    await git(root, "branch", "feat/location-row");

    const summary = await createNodeProjectGitReader().read({
      projectRoot: root,
    });

    expect(summary).toEqual({
      projectRoot: await realpath(root),
      branch: current,
      branches: [current, "feat/location-row"],
    });
  });

  it("says a Project outside Git has no branch rather than failing the draft", async () => {
    const root = await tempDirectory();

    await expect(
      createNodeProjectGitReader().read({ projectRoot: root }),
    ).resolves.toEqual({
      projectRoot: await realpath(root),
      branch: null,
      branches: [],
    });
  });

  it("switches the Project folder onto another branch", async () => {
    const root = await repository();
    await git(root, "branch", "feat/location-row");
    const reader = createNodeProjectGitReader();

    const summary = await reader.checkoutBranch({
      projectRoot: root,
      branch: "feat/location-row",
    });

    expect(summary.branch).toBe("feat/location-row");
    expect(await gitStdout(root, "symbolic-ref", "--short", "HEAD")).toBe(
      "feat/location-row",
    );
  });
});
