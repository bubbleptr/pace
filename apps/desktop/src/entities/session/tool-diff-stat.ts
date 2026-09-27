// Per-edit line stats for tool rows. Pi's `edit` result carries the change
// twice — `details.patch` as a standard unified patch (the authority) and
// `details.diff` as a display rendering — and emits no ready-made counts, so
// they are derived here. `write` results carry no details and get no stats:
// a create and an overwrite are indistinguishable in the result, so a "+N"
// there would overclaim.

export type ToolDiffStat = { additions: number; deletions: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// Pi's display diff prefixes changed lines with the sign and the line number
// ("+221  code", "-219  code"); context lines lead with a space and elisions
// are "     ...", so only a sign directly before the number counts.
const DIFF_ADDED = /^\+\s*\d+ /;
const DIFF_REMOVED = /^-\s*\d+ /;

function statFromPatch(patch: string): ToolDiffStat {
  let additions = 0;
  let deletions = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);

    if (header) {
      remainingOld = Number.parseInt(header[2] ?? "1", 10);
      remainingNew = Number.parseInt(header[4] ?? "1", 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    // Both sides exhausted means the hunk is over: lines after it — including
    // the `--- `/`+++ ` headers of a following file section — are not content.
    if (remainingOld === 0 && remainingNew === 0) {
      inHunk = false;
      continue;
    }

    const marker = line.charAt(0);

    if (marker === " ") {
      remainingOld -= 1;
      remainingNew -= 1;
    } else if (marker === "-") {
      remainingOld -= 1;
      deletions += 1;
    } else if (marker === "+") {
      remainingNew -= 1;
      additions += 1;
    }
    // `\ No newline at end of file` and anything unexpected is not content.
  }

  return { additions, deletions };
}

function statFromDisplayDiff(diff: string): ToolDiffStat {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (DIFF_ADDED.test(line)) {
      additions += 1;
    } else if (DIFF_REMOVED.test(line)) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

export function toolDiffStatFromResult(result: unknown): ToolDiffStat | undefined {
  let value = result;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const details = (value as { details?: unknown }).details;

  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const { patch, diff } = details as { patch?: unknown; diff?: unknown };
  const stat =
    typeof patch === "string"
      ? statFromPatch(patch)
      : typeof diff === "string"
        ? statFromDisplayDiff(diff)
        : undefined;

  return stat !== undefined && (stat.additions > 0 || stat.deletions > 0)
    ? stat
    : undefined;
}
