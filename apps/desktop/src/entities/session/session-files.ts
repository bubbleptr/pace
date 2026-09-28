import { invoke } from "@/shared/runtime";
import type {
  SessionDirectoryListing,
  SessionFileContent,
  SessionFileResolution,
} from "@pace/core";

export type {
  SessionDirectoryEntry,
  SessionDirectoryEntryKind,
  SessionDirectoryListing,
  SessionFileContent,
  SessionFileResolution,
} from "@pace/core";

/** Paths are diff-root-relative; "" lists the root itself. */
export async function listSessionDirectory(sessionId: string, path = "") {
  return invoke<SessionDirectoryListing>("list_session_directory", {
    sessionId,
    path,
  });
}

export async function readSessionFile(sessionId: string, path: string) {
  return invoke<SessionFileContent>("read_session_file", { sessionId, path });
}

/**
 * Batched existence check for diff-root-relative paths; the backend echoes
 * back only the ones that are real files.
 */
export async function resolveSessionFiles(sessionId: string, paths: string[]) {
  return invoke<SessionFileResolution>("resolve_session_files", {
    sessionId,
    paths,
  });
}
