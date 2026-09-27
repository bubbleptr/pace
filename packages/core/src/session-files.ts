/**
 * Read-only view of a Session checkout's files for the Files surface. Paths
 * are relative to the Session's diff root — the same root the Changes surface
 * uses — so a path shown in one surface names the same file in the other.
 */
export type SessionDirectoryEntryKind = "file" | "directory" | "symlink" | "other";

export type SessionDirectoryEntry = {
  name: string;
  /** Diff-root-relative path, forward slashes, no leading `./`. */
  path: string;
  kind: SessionDirectoryEntryKind;
  /** Byte size for files; null for anything that has no meaningful size. */
  size: number | null;
};

export type SessionDirectoryListing = {
  sessionId: string;
  /** Diff-root-relative path of the listed directory; "" is the root. */
  path: string;
  /** Basename of the diff root, for the tree's root row. */
  rootName: string;
  entries: SessionDirectoryEntry[];
  /** True when the directory held more entries than the listing limit. */
  truncated: boolean;
};

export type SessionFileContent = {
  sessionId: string;
  path: string;
  size: number;
  /** UTF-8 text, empty when the file is binary. */
  content: string;
  /** True when only the first part of the file was returned. */
  truncated: boolean;
  binary: boolean;
};

/**
 * Answer to a batched existence check: the subset of requested paths that are
 * regular files inside the diff root, each echoed exactly as it was sent.
 */
export type SessionFileResolution = {
  files: string[];
};
