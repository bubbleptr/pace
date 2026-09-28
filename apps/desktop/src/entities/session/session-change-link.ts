import type { SessionChanges } from "@pace/core";

export type SessionChangeLink = { absolutePath: string; line?: number };
export type SessionChangeTarget = { sessionId: string; path: string; line?: number };
export type SessionFileTarget = { sessionId: string; path: string; line?: number };

/** Resolve against the Session cwd, never the renderer's file:// or dev URL. */
export function parseSessionChangeLink(href: string, cwd: string): SessionChangeLink | null {
  if (!href || /^[#?]/.test(href) || href.startsWith("//") || href.includes("\\")) return null;
  try {
    const base = `file://${cwd.split("/").map(encodeURIComponent).join("/")}/`;
    const [path, hash = ""] = href.split("#", 2);
    const suffix = /:(\d+)(?::\d+)?$/.exec(path!);
    const url = new URL(suffix ? path!.slice(0, suffix.index) : path!, base);
    if (url.protocol !== "file:" || url.hostname || url.search) return null;
    const absolutePath = decodeURIComponent(url.pathname);
    if (absolutePath.includes("\0")) return null;
    const line = Number(/^L(\d+)(?:-L?\d+)?$/.exec(hash)?.[1] ?? suffix?.[1]);
    return { absolutePath, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
  } catch {
    return null;
  }
}

export function findSessionChangeTarget(
  link: SessionChangeLink,
  changes: SessionChanges,
  diffRoot = changes.checkoutRoot,
): SessionChangeTarget | null {
  if (changes.state !== "ready") return null;
  // Git display paths are relative to diffRoot, which can be a subproject
  // inside the execution checkout. Prefer a current path over a rename alias.
  const root = diffRoot.replace(/\/$/, "");
  const file = changes.files.find((file) => `${root}/${file.path}` === link.absolutePath)
    ?? changes.files.find((file) => file.previousPath && `${root}/${file.previousPath}` === link.absolutePath);
  return file ? { sessionId: changes.sessionId, path: file.path, line: link.line } : null;
}

/**
 * Fallback when a chat file link matches nothing in the Changes set: open the
 * file in the Files surface instead of swallowing the click. Only paths
 * strictly inside the diff root resolve — the backend reads are rooted there
 * and refuse `.git` anyway.
 */
export function findSessionFileTarget(
  link: SessionChangeLink,
  sessionId: string,
  diffRoot?: string,
): SessionFileTarget | null {
  if (!diffRoot) return null;
  const root = diffRoot.replace(/\/$/, "");
  if (!link.absolutePath.startsWith(`${root}/`)) return null;
  const path = link.absolutePath.slice(root.length + 1);
  // A trailing slash names a directory — there is no file to read, so the
  // click dead-ends instead of surfacing a "not a file" error.
  if (!path || path.endsWith("/") || path.split("/", 1)[0] === ".git") return null;
  return { sessionId, path, ...(link.line ? { line: link.line } : {}) };
}
