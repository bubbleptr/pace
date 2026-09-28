import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSessionFilesReader } from "./session-files";

const tempDirs: string[] = [];
async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "pigui-session-files-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function checkout() {
  const root = await tempDirectory();
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "# hello\n", "utf8");
  await writeFile(join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "src", "nested", "deep.txt"), "deep\n", "utf8");
  await writeFile(join(root, "Zebra.txt"), "z\n", "utf8");
  await writeFile(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
  return root;
}

describe("createNodeSessionFilesReader", () => {
  it("rejects Git metadata paths after normalization while allowing .gitignore", async () => {
    const root = await checkout();
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    const reader = createNodeSessionFilesReader();
    for (const path of [".git/config", "./.git//config"]) {
      await expect(reader.readFile({ sessionId: "s1", diffRoot: root, path }))
        .rejects.toThrow(/outside|invalid/i);
    }
    await expect(reader.listDirectory({ sessionId: "s1", diffRoot: root, path: ".git" }))
      .rejects.toThrow(/outside|invalid/i);
    await expect(reader.readFile({ sessionId: "s1", diffRoot: root, path: ".gitignore" }))
      .resolves.toMatchObject({ content: "node_modules\n" });
  });

  it("reports missing paths without exposing the host path", async () => {
    const root = await checkout();
    const reader = createNodeSessionFilesReader();
    for (const read of [reader.listDirectory, reader.readFile]) {
      await expect(read({ sessionId: "s1", diffRoot: root, path: "missing" }))
        .rejects.toThrow('Session path "missing" does not exist.');
    }
  });

  describe("listDirectory", () => {
    it("lists the root with directories first, names case-insensitively sorted, and .git hidden", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      const listing = await reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "" });

      expect(listing).toMatchObject({ sessionId: "s1", path: "", truncated: false });
      expect(listing.rootName).toBe(basename(root));
      expect(listing.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
        "directory:src",
        "file:image.png",
        "file:README.md",
        "file:Zebra.txt",
      ]);
      expect(listing.entries.find((entry) => entry.name === "README.md")?.size).toBe(8);
    });

    it("lists a nested directory by diff-root-relative path", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      const listing = await reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "src" });

      expect(listing.entries.map((entry) => entry.path)).toEqual(["src/nested", "src/app.ts"]);
    });

    it("rejects paths that leave the diff root", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      for (const path of ["..", "../", "src/../..", "/etc", "src\0"]) {
        await expect(
          reader.listDirectory({ sessionId: "s1", diffRoot: root, path }),
        ).rejects.toThrow(/outside|invalid/i);
      }
    });

    it("refuses to follow a symlink that escapes the diff root", async () => {
      const root = await checkout();
      const outside = await tempDirectory();
      await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
      await symlink(outside, join(root, "escape"));
      const reader = createNodeSessionFilesReader();

      const listing = await reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "" });
      expect(listing.entries.find((entry) => entry.name === "escape")?.kind).toBe("symlink");

      await expect(
        reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "escape" }),
      ).rejects.toThrow(/outside/i);
      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "escape/secret.txt" }),
      ).rejects.toThrow(/outside/i);
    });

    it("keeps the listing when an entry disappears before stat", async () => {
      const root = await tempDirectory();
      await writeFile(join(root, "gone.txt"), "gone");
      await writeFile(join(root, "kept.txt"), "kept");
      const statEntry = async (path: string) => {
        if (basename(path) === "gone.txt") await rm(join(root, "gone.txt"));
        return stat(path);
      };
      const reader = createNodeSessionFilesReader({}, { stat: statEntry });

      await expect(reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "" }))
        .resolves.toMatchObject({
          entries: [{ name: "gone.txt", size: null }, { name: "kept.txt", size: 4 }],
        });
    });

    it("bounds oversized directories and reports the cut", async () => {
      const root = await tempDirectory();
      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          writeFile(join(root, `file-${String(index).padStart(2, "0")}.txt`), "x", "utf8"),
        ),
      );
      const statSpy = vi.fn((path: string) => stat(path));
      const reader = createNodeSessionFilesReader({ maxEntries: 10 }, { stat: statSpy });

      const listing = await reader.listDirectory({ sessionId: "s1", diffRoot: root, path: "" });

      expect(listing.entries.map((entry) => entry.name)).toEqual([
        "file-00.txt", "file-01.txt", "file-02.txt", "file-03.txt", "file-04.txt",
        "file-05.txt", "file-06.txt", "file-07.txt", "file-08.txt", "file-09.txt",
      ]);
      expect(statSpy).toHaveBeenCalledTimes(10);
      expect(listing.truncated).toBe(true);
    });
  });

  describe("readFile", () => {
    it("returns UTF-8 text with its size", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "src/app.ts" }),
      ).resolves.toEqual({
        sessionId: "s1",
        path: "src/app.ts",
        size: 20,
        content: "export const a = 1;\n",
        truncated: false,
        binary: false,
      });
    });

    it("flags binary files instead of returning their bytes", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "image.png" }),
      ).resolves.toMatchObject({ binary: true, content: "", size: 6 });
    });

    it("truncates files past the byte limit on a line boundary", async () => {
      const root = await tempDirectory();
      await writeFile(join(root, "big.txt"), "0123456789\nabcdefghij\nklmnopqrst\n", "utf8");
      const reader = createNodeSessionFilesReader({ maxFileBytes: 25 });

      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "big.txt" }),
      ).resolves.toMatchObject({
        content: "0123456789\nabcdefghij\n",
        truncated: true,
        size: 33,
      });
    });

    it("truncates a single line at a complete UTF-8 character", async () => {
      const root = await tempDirectory();
      await writeFile(join(root, "text.txt"), "中".repeat(10));
      const reader = createNodeSessionFilesReader({ maxFileBytes: 20 });
      await expect(reader.readFile({ sessionId: "s1", diffRoot: root, path: "text.txt" }))
        .resolves.toMatchObject({ content: "中".repeat(6), truncated: true });
    });

    it.each([
      { before: "short", after: "x".repeat(30), truncated: true, content: "x".repeat(20) },
      { before: "x".repeat(30), after: "short", truncated: false, content: "short" },
      { before: "x".repeat(20), after: "x".repeat(20), truncated: false, content: "x".repeat(20) },
    ])("uses bytes read when a file changes from $before to $after", async ({ before, after, truncated, content }) => {
      const root = await tempDirectory();
      const path = join(root, "changing.txt");
      await writeFile(path, before);
      const statBeforeWrite = async (target: string) => {
        const info = await stat(target);
        await writeFile(path, after);
        return info;
      };
      const reader = createNodeSessionFilesReader({ maxFileBytes: 20 }, { stat: statBeforeWrite });
      await expect(reader.readFile({ sessionId: "s1", diffRoot: root, path: "changing.txt" }))
        .resolves.toMatchObject({ content, truncated, size: Buffer.byteLength(before) });
    });

    it("rejects directories and paths outside the diff root", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "src" }),
      ).rejects.toThrow(/not a file/i);
      await expect(
        reader.readFile({ sessionId: "s1", diffRoot: root, path: "../x" }),
      ).rejects.toThrow(/outside|invalid/i);
    });
  });

  describe("resolveFiles", () => {
    it("keeps only paths that are regular files inside the root, in input order", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.resolveFiles({
          sessionId: "s1",
          diffRoot: root,
          paths: [
            "src/app.ts",
            "src",
            "missing.ts",
            "../secret.ts",
            "/etc/hosts",
            ".git/config",
            "src/nested/deep.txt",
          ],
        }),
      ).resolves.toEqual({
        files: ["src/app.ts", "src/nested/deep.txt"],
      });
    });

    it("echoes the input spelling rather than the normalized path", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.resolveFiles({
          sessionId: "s1",
          diffRoot: root,
          paths: ["./src/app.ts", "src//nested/deep.txt"],
        }),
      ).resolves.toEqual({ files: ["./src/app.ts", "src//nested/deep.txt"] });
    });

    it("excludes a symlink that escapes the root without failing the batch", async () => {
      const root = await checkout();
      const outside = await tempDirectory();
      await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
      await symlink(outside, join(root, "escape"));
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.resolveFiles({
          sessionId: "s1",
          diffRoot: root,
          paths: ["escape/secret.txt", "README.md", "src\0.ts"],
        }),
      ).resolves.toEqual({ files: ["README.md"] });
    });

    it("considers only the first 100 paths", async () => {
      const root = await checkout();
      const reader = createNodeSessionFilesReader();

      await expect(
        reader.resolveFiles({
          sessionId: "s1",
          diffRoot: root,
          paths: ["src/app.ts", ...Array(100).fill("missing.ts"), "README.md"],
        }),
      ).resolves.toEqual({ files: ["src/app.ts"] });
    });
  });
});
