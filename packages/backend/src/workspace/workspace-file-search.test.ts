import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileSearcher } from "./workspace-file-search";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pace-workspace-search-"));
  tempDirs.push(dir);
  return dir;
}

function git(root: string, args: string[]) {
  execFileSync("git", args, { cwd: root });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace file search", () => {
  it("lists git-tracked and untracked files, derives directories, and honours .gitignore", async () => {
    const root = await tempDir();
    git(root, ["init"]);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "app.ts"), "");
    await writeFile(join(root, "src", "myapp.ts"), "");
    await writeFile(join(root, "src", "app", "util.ts"), "");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "");
    await writeFile(join(root, "untracked.txt"), "");
    git(root, ["add", "app.ts", "src/myapp.ts", "src/app/util.ts", ".gitignore"]);

    const searcher = createWorkspaceFileSearcher();
    const result = await searcher.search({ root, query: "app" });

    expect(
      result.matches.map((match) => `${match.kind === "directory" ? "d" : "f"}:${match.path}`),
    ).toEqual([
      "f:app.ts", // basename prefix
      "d:src/app", // basename prefix, longer path second
      "f:src/myapp.ts", // basename contains
      "f:src/app/util.ts", // path contains
    ]);
    expect(result.truncated).toBe(false);

    const untracked = await searcher.search({ root, query: "untracked" });
    expect(untracked.matches).toEqual([{ path: "untracked.txt", kind: "file" }]);

    const ignored = await searcher.search({ root, query: "ignored.txt" });
    expect(ignored.matches).toEqual([]);
  });

  it("ranks a plain subsequence below a path substring", async () => {
    const searcher = createWorkspaceFileSearcher({
      listPaths: async () => [
        "src/app/util.ts",
        "alpha/parser.md", // contains a..p..p but never "app"
      ],
    });
    const result = await searcher.search({ root: "/anywhere", query: "app" });
    expect(result.matches.map((match) => match.path)).toEqual([
      "src/app", // basename prefix
      "src/app/util.ts", // path contains
      "alpha/parser.md", // subsequence only
    ]);
  });

  it("returns path-sorted matches for an empty query and truncates past the limit", async () => {
    const searcher = createWorkspaceFileSearcher({
      listPaths: async () => ["b/two.ts", "a/one.ts", "c/three.ts"],
    });
    const all = await searcher.search({ root: "/anywhere", query: "" });
    expect(all.matches.map((match) => match.path)).toEqual([
      "a",
      "a/one.ts",
      "b",
      "b/two.ts",
      "c",
      "c/three.ts",
    ]);
    expect(all.truncated).toBe(false);

    const limited = await searcher.search({ root: "/anywhere", query: "", limit: 2 });
    expect(limited.matches.map((match) => match.path)).toEqual(["a", "a/one.ts"]);
    expect(limited.truncated).toBe(true);
  });

  it("falls back to a bounded traversal outside git, skipping .git and node_modules", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "");

    const searcher = createWorkspaceFileSearcher();
    const result = await searcher.search({ root, query: "" });

    expect(result.matches).toEqual([
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
    ]);
  });

  it("drops escaping or .git paths reported by the file listing", async () => {
    const searcher = createWorkspaceFileSearcher({
      listPaths: async () => ["../escape.ts", ".git/config", "ok.ts"],
    });
    const result = await searcher.search({ root: "/anywhere", query: "" });
    expect(result.matches).toEqual([{ path: "ok.ts", kind: "file" }]);
  });

  it("caches the path listing per root for a short ttl", async () => {
    let now = 1_000;
    const listPaths = vi.fn(async () => ["a.ts"]);
    const searcher = createWorkspaceFileSearcher({ listPaths, now: () => now });

    await searcher.search({ root: "/repo", query: "a" });
    await searcher.search({ root: "/repo", query: "ts" });
    // A different root is cached independently.
    await searcher.search({ root: "/other", query: "a" });
    expect(listPaths).toHaveBeenCalledTimes(2);

    now += 10_001;
    await searcher.search({ root: "/repo", query: "a" });
    expect(listPaths).toHaveBeenCalledTimes(3);
  });

  it("shares one listing between concurrent searches on the same root", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listPaths = vi.fn(async () => {
      await gate;
      return ["a.ts", "b.ts"];
    });
    const searcher = createWorkspaceFileSearcher({ listPaths });

    const first = searcher.search({ root: "/repo", query: "a" });
    const second = searcher.search({ root: "/repo", query: "b" });
    release();
    await Promise.all([first, second]);

    expect(listPaths).toHaveBeenCalledTimes(1);
  });
});
