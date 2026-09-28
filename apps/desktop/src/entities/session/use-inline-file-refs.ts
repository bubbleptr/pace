import { useEffect, useState } from "react";
import { collectInlineFileCandidates } from "@/entities/session/inline-file-refs";
import {
  findSessionFileTarget,
  parseSessionChangeLink,
} from "@/entities/session/session-change-link";
import { resolveSessionFiles } from "@/entities/session/session-files";

/**
 * The Session the click delegation resolves against — the same cwd/diffRoot
 * expressions agent-workspace uses, so a link and an inline-code reference to
 * the same file always agree.
 */
export type InlineFileRefScope = {
  sessionId: string;
  cwd: string;
  diffRoot: string;
};

const EMPTY_REFS: ReadonlySet<string> = new Set();

// The backend's resolveFiles only inspects the first 100 paths
// (MAX_RESOLVE_FILES), so a bigger batch must be split across requests.
const RESOLVE_FILES_BATCH = 100;

/**
 * The inline-code spans of `markdown` that are confirmed files in the
 * Session's checkout. Resolution batches candidates into `resolve_session_files`
 * calls per (scope, markdown); nothing is requested for a null scope, no
 * candidates, or paths that can't sit inside the diff root. A failure is
 * silent: the spans simply stay plain code.
 */
export function useInlineFileRefs(
  scope: InlineFileRefScope | null,
  markdown: string,
  resolve: typeof resolveSessionFiles = resolveSessionFiles,
): ReadonlySet<string> {
  const sessionId = scope?.sessionId ?? null;
  const cwd = scope?.cwd ?? null;
  const diffRoot = scope?.diffRoot ?? null;
  const [resolved, setResolved] = useState<{
    key: string;
    refs: ReadonlySet<string>;
  } | null>(null);
  const key =
    sessionId && cwd && diffRoot
      ? `${sessionId}${cwd}${diffRoot}${markdown}`
      : null;

  useEffect(() => {
    if (!sessionId || !cwd || !diffRoot) return;
    const effectKey = `${sessionId}${cwd}${diffRoot}${markdown}`;

    // Group spans by the path they name so one resolve call covers a file
    // mentioned both bare and with a line suffix.
    const byPath = new Map<string, string[]>();
    for (const code of collectInlineFileCandidates(markdown)) {
      const link = parseSessionChangeLink(code, cwd);
      const target = link && findSessionFileTarget(link, sessionId, diffRoot);
      if (target) {
        const codes = byPath.get(target.path);
        if (codes) codes.push(code);
        else byPath.set(target.path, [code]);
      }
    }
    if (!byPath.size) return;

    let stale = false;
    const paths = [...byPath.keys()];
    const chunks: string[][] = [];
    for (let i = 0; i < paths.length; i += RESOLVE_FILES_BATCH) {
      chunks.push(paths.slice(i, i + RESOLVE_FILES_BATCH));
    }
    // The confirmation belongs to this request only — an earlier result for
    // the same key must not be served while it is in flight.
    setResolved({ key: effectKey, refs: EMPTY_REFS });
    void Promise.all(chunks.map((chunk) => resolve(sessionId, chunk)))
      .then((results) => {
        if (stale) return;
        const refs = new Set<string>();
        for (const { files } of results) {
          for (const path of files) {
            for (const code of byPath.get(path) ?? []) refs.add(code);
          }
        }
        setResolved({ key: effectKey, refs });
      })
      .catch(() => {
        if (!stale) setResolved({ key: effectKey, refs: EMPTY_REFS });
      });
    return () => {
      stale = true;
    };
  }, [sessionId, cwd, diffRoot, markdown, resolve]);

  return key && resolved?.key === key ? resolved.refs : EMPTY_REFS;
}
