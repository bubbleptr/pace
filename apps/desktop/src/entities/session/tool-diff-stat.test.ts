import { describe, expect, it } from "vitest";
import { toolDiffStatFromResult } from "./tool-diff-stat";

// Pi's `edit` tool result carries the change twice: `details.patch` is a
// standard single-file unified patch (the authority), `details.diff` is Pi's
// display rendering ("+221  code", "-219  code", " 217  code", "     ...").
// write returns no details at all, so it never gets stats.

describe("toolDiffStatFromResult", () => {
  it("counts a single-hunk unified patch, ignoring ---/+++ headers", () => {
    const patch = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -10,4 +10,7 @@ function main() {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "+const d = 5;",
      "+const e = 6;",
      " const f = 7;",
      " const g = 8;",
    ].join("\n");

    expect(
      toolDiffStatFromResult({ content: [], details: { patch } }),
    ).toEqual({ additions: 4, deletions: 1 });
  });

  it("sums across hunks", () => {
    const patch = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "@@ -20,3 +20,2 @@",
      " const x = 1;",
      "-const y = 2;",
      "-const z = 3;",
      "+const y = 20;",
    ].join("\n");

    expect(toolDiffStatFromResult({ details: { patch } })).toEqual({
      additions: 3,
      deletions: 3,
    });
  });

  it("counts a deleted line whose content begins with -- as a deletion", () => {
    // Inside a hunk the marker is only the first column, so `--- x` is a
    // deletion of the content `-- x`; outside a hunk `--- ` is a header.
    const patch = [
      "--- a/src/flags.ts",
      "+++ b/src/flags.ts",
      "@@ -1,2 +1,2 @@",
      " const keep = 1;",
      "--- x",
      "+const flag = true;",
    ].join("\n");

    expect(toolDiffStatFromResult({ details: { patch } })).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    const patch = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    expect(toolDiffStatFromResult({ details: { patch } })).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("treats a missing hunk count as 1", () => {
    const patch = ["@@ -5 +5 @@", "-a", "+b"].join("\n");

    expect(toolDiffStatFromResult({ details: { patch } })).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("falls back to Pi's display diff when there is no patch", () => {
    const diff = [
      " 216   export const schema = {",
      " 217   ? [",
      "-219   foo",
      "+221         validateSearch: value,",
      "+222         required: true,",
      "     ...",
      " 400   }",
    ].join("\n");

    expect(toolDiffStatFromResult({ details: { diff } })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("prefers details.patch over details.diff when both exist", () => {
    const patch = ["@@ -1,1 +1,2 @@", " const a = 1;", "+const b = 2;"].join("\n");
    const diff = ["+10   one", "+11   two", "+12   three", "-9   old"].join("\n");

    expect(toolDiffStatFromResult({ details: { patch, diff } })).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("accepts the result serialized as a JSON string", () => {
    const result = JSON.stringify({
      details: { patch: ["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n") },
    });

    expect(toolDiffStatFromResult(result)).toEqual({ additions: 1, deletions: 1 });
  });

  it("returns undefined when there is nothing countable", () => {
    const contextOnlyPatch = ["@@ -1,1 +1,1 @@", " const a = 1;"].join("\n");

    expect(toolDiffStatFromResult({ details: undefined })).toBeUndefined();
    expect(toolDiffStatFromResult({ content: [] })).toBeUndefined();
    expect(toolDiffStatFromResult({ details: {} })).toBeUndefined();
    expect(toolDiffStatFromResult({ details: { patch: contextOnlyPatch } })).toBeUndefined();
    expect(toolDiffStatFromResult({ details: { patch: 42 } })).toBeUndefined();
    expect(toolDiffStatFromResult("not json")).toBeUndefined();
    expect(toolDiffStatFromResult('"a json string"')).toBeUndefined();
    expect(toolDiffStatFromResult(42)).toBeUndefined();
    expect(toolDiffStatFromResult(null)).toBeUndefined();
    expect(toolDiffStatFromResult(undefined)).toBeUndefined();
  });
});
