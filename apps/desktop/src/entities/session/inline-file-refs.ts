/**
 * Inline-code file references: models often write paths as `` `src/foo.ts` ``
 * instead of Markdown links. The heuristic here only decides which code spans
 * are worth an existence check — it must never decide what is a file. Spans
 * that pass get resolved against the Session checkout (resolve_session_files)
 * and only confirmed files render as links.
 */

const MAX_CANDIDATE_LENGTH = 260;

// The same suffixes parseSessionChangeLink understands: :N, :N:M, #LN, #LN-LM.
const LINE_SUFFIX = /(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/;

// A plausible file has a dotted extension starting with a letter; this is
// what rejects versions (`0.87.1`), bare dirs (`src/widgets`) and `file.`.
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/;

export function isInlineFileCandidate(code: string): boolean {
  if (!code || code.length > MAX_CANDIDATE_LENGTH) return false;
  if (
    /\s/.test(code) ||
    code.includes("://") ||
    code.includes("\\") ||
    code.startsWith("-") ||
    code.startsWith("@")
  ) {
    return false;
  }
  const path = code.replace(LINE_SUFFIX, "");
  return FILE_EXTENSION.test(path.slice(path.lastIndexOf("/") + 1));
}

const INLINE_CODE = /`([^`\n]+)`/g;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Single-backtick spans only, on one line, with fenced blocks removed first —
 * a path inside ``` must never become a link. Deduped in first-seen order.
 */
export function collectInlineFileCandidates(markdown: string): string[] {
  const kept: string[] = [];
  let fenceChar: string | null = null;
  let fenceLength = 0;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (fenceChar === null) {
      if (fence) {
        fenceChar = fence[1]![0]!;
        fenceLength = fence[1]!.length;
        continue;
      }
      kept.push(line);
    } else if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLength) {
      fenceChar = null;
    }
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const match of kept.join("\n").matchAll(INLINE_CODE)) {
    const code = match[1]!.trim();
    if (!seen.has(code) && isInlineFileCandidate(code)) {
      seen.add(code);
      candidates.push(code);
    }
  }
  return candidates;
}
