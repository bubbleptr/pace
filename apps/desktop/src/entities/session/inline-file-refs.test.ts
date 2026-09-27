import { describe, expect, it } from "vitest";
import {
  collectInlineFileCandidates,
  isInlineFileCandidate,
} from "@/entities/session/inline-file-refs";

describe("isInlineFileCandidate", () => {
  it.each([
    "src/a.ts",
    "a.tsx#L3",
    "package.json",
    "src/a.ts:12",
    "src/a.ts:12:4",
    "a.md#L12-L15",
    "dir/deep/file.test.tsx",
    // Looks like a call, not a path — accepted here; the existence check is
    // what keeps it from rendering as a link.
    "console.log",
  ])("accepts %s", (code) => {
    expect(isInlineFileCandidate(code)).toBe(true);
  });

  it.each([
    "",
    "0.87.1",
    "v0.0.16",
    "src/widgets",
    "@pace/core",
    "bun run test",
    "--flag",
    "-x.ts",
    "https://x/y.ts",
    "file.ts .ts",
    "src\\a.ts",
    "file.",
    "a.ts:abc",
    `${"a".repeat(257)}.tsx`,
  ])("rejects %s", (code) => {
    expect(isInlineFileCandidate(code)).toBe(false);
  });
});

describe("collectInlineFileCandidates", () => {
  it("collects single-backtick spans in first-seen order, deduped", () => {
    expect(
      collectInlineFileCandidates(
        "See `src/a.ts` and `src/b.ts`, then `src/a.ts` again.",
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("trims the span and drops ones that fail the candidate test", () => {
    expect(
      collectInlineFileCandidates("` src/a.ts ` plus `bun run test` and `x`"),
    ).toEqual(["src/a.ts"]);
  });

  it("skips fenced code blocks of either fence style", () => {
    const markdown = [
      "```ts",
      "const a = `src/in-fence.ts`;",
      "```",
      "Text `src/out.ts` here.",
      "~~~",
      "`src/in-tilde.ts`",
      "~~~",
      "`src/after.ts`",
    ].join("\n");

    expect(collectInlineFileCandidates(markdown)).toEqual([
      "src/out.ts",
      "src/after.ts",
    ]);
  });

  it("ignores a code span that crosses a line break", () => {
    expect(collectInlineFileCandidates("`src/a.ts\ncontinued`")).toEqual([]);
    // Spans on separate lines are still each collected.
    expect(
      collectInlineFileCandidates("`src/a.ts`\n`src/b.ts`"),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("treats everything after an unclosed fence as fenced", () => {
    expect(
      collectInlineFileCandidates("`a.ts`\n```\n`b.ts`"),
    ).toEqual(["a.ts"]);
  });
});
