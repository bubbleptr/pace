import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  SessionDirectoryEntry,
  SessionDirectoryEntryKind,
  SessionDirectoryListing,
  SessionFileContent,
  SessionFileResolution,
} from "@pace/core";

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_RESOLVE_FILES = 100;

export type SessionFilesReaderOptions = {
  maxEntries?: number;
  maxFileBytes?: number;
};

export type ListSessionDirectoryInput = {
  sessionId: string;
  diffRoot: string;
  /** Diff-root-relative path; "" lists the root. */
  path: string;
};

export type ReadSessionFileInput = {
  sessionId: string;
  diffRoot: string;
  path: string;
};

export type ResolveSessionFilesInput = {
  sessionId: string;
  diffRoot: string;
  paths: string[];
};

export type SessionFilesReader = {
  listDirectory(input: ListSessionDirectoryInput): Promise<SessionDirectoryListing>;
  readFile(input: ReadSessionFileInput): Promise<SessionFileContent>;
  resolveFiles(input: ResolveSessionFilesInput): Promise<SessionFileResolution>;
};

function isInside(parent: string, child: string) {
  const path = relative(parent, child);

  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function assertSafeRelativePath(path: string) {
  if (
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Session file path "${path}" is invalid.`);
  }
}

function toPosixPath(path: string) {
  return path.split(sep).join("/");
}

/**
 * Resolves a renderer-supplied relative path to a real filesystem path that
 * is guaranteed to sit under the (real) diff root. The lexical check catches
 * `..` tricks; the realpath check catches symlinks that point outside the
 * checkout, which a lexical check cannot see.
 */
async function resolveInsideRoot(diffRoot: string, path: string) {
  assertSafeRelativePath(path);
  try {
    const root = await realpath(diffRoot);
    const lexical = resolve(root, path);

    if (!isInside(root, lexical) || relative(root, lexical).split(sep)[0] === ".git") {
      throw new Error(`Session file path "${path}" is outside the diff root.`);
    }

    const target = await realpath(lexical);

    if (!isInside(root, target)) {
      throw new Error(`Session file path "${path}" is outside the diff root.`);
    }

    return { root, target, relativePath: toPosixPath(relative(root, lexical)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Session path "${path}" does not exist.`);
    }
    throw error;
  }
}

function entryKind(dirent: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): SessionDirectoryEntryKind {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

function compareEntries(a: SessionDirectoryEntry, b: SessionDirectoryEntry) {
  if (a.kind !== b.kind) {
    if (a.kind === "directory") return -1;
    if (b.kind === "directory") return 1;
  }

  return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.name.localeCompare(b.name, "en");
}

function looksBinary(bytes: Buffer) {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function createNodeSessionFilesReader(
  options: SessionFilesReaderOptions = {},
  filesystem: { stat: (path: string) => Promise<Stats> } = { stat },
): SessionFilesReader {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    async listDirectory(input) {
      const { root, target, relativePath } = await resolveInsideRoot(
        input.diffRoot,
        input.path,
      );
      const targetStat = await lstat(target);

      if (!targetStat.isDirectory()) {
        throw new Error(`Session path "${input.path}" is not a directory.`);
      }

      const dirents = await readdir(target, { withFileTypes: true });
      const entries: SessionDirectoryEntry[] = dirents
        .filter((dirent) => dirent.name !== ".git")
        .map((dirent) => ({
          name: dirent.name,
          path: relativePath ? `${relativePath}/${dirent.name}` : dirent.name,
          kind: entryKind(dirent),
          size: null,
        }));
      entries.sort(compareEntries);
      const keptEntries = await Promise.all(entries.slice(0, maxEntries).map(async (entry) => ({
        ...entry,
        size: entry.kind === "file"
          ? await filesystem.stat(join(target, entry.name)).then((info) => info.size, () => null)
          : null,
      })));

      return {
        sessionId: input.sessionId,
        path: relativePath,
        rootName: basename(root),
        entries: keptEntries,
        truncated: entries.length > maxEntries,
      };
    },

    async readFile(input) {
      const { target, relativePath } = await resolveInsideRoot(
        input.diffRoot,
        input.path,
      );
      const targetStat = await filesystem.stat(target);

      if (!targetStat.isFile()) {
        throw new Error(`Session path "${input.path}" is not a file.`);
      }

      const size = targetStat.size;
      const handle = await open(target, "r");
      let bytes: Buffer;

      try {
        const buffer = Buffer.alloc(maxFileBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }

      const base = { sessionId: input.sessionId, path: relativePath, size };

      if (looksBinary(bytes)) {
        return { ...base, content: "", truncated: false, binary: true };
      }

      if (bytes.length <= maxFileBytes) {
        return {
          ...base,
          content: bytes.toString("utf8"),
          truncated: false,
          binary: false,
        };
      }

      // Prefer complete lines; single-line previews must preserve UTF-8 characters.
      const lastNewline = bytes.subarray(0, maxFileBytes).lastIndexOf(0x0a);
      let end = lastNewline >= 0 ? lastNewline + 1 : maxFileBytes;
      if (lastNewline < 0) {
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      }
      const cut = bytes.subarray(0, end);

      return {
        ...base,
        content: cut.toString("utf8"),
        truncated: true,
        binary: false,
      };
    },

    async resolveFiles(input) {
      const files: string[] = [];

      for (const path of input.paths.slice(0, MAX_RESOLVE_FILES)) {
        try {
          const { target } = await resolveInsideRoot(input.diffRoot, path);
          if ((await filesystem.stat(target)).isFile()) files.push(path);
        } catch {
          // One bad path only excludes itself; the batch still answers.
        }
      }

      return { files };
    },
  };
}
