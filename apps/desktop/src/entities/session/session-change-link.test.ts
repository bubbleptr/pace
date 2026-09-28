import { describe, expect, it } from "vitest";
import type { SessionChanges } from "@pace/core";
import {
  findSessionChangeTarget,
  findSessionFileTarget,
  parseSessionChangeLink,
} from "./session-change-link";

const changes: SessionChanges = {
  sessionId: "review", state: "ready", checkoutRoot: "/work/repo", repositoryRoot: "/work/repo",
  generatedAt: "2026-09-10T00:00:00Z", truncated: false, omittedFileCount: 0,
  totals: { files: 1, additions: 1, deletions: 1, binaryFiles: 0, conflictedFiles: 0 },
  files: [{ path: "src/new name.ts", previousPath: "src/old name.ts", kind: "renamed", staged: true,
    unstaged: false, additions: 1, deletions: 1, binary: false, patchTruncated: false }],
};

describe("Session change links", () => {
  it("resolves a nested project's encoded old path to the current renamed diff", () => {
    const diffRoot = "/work/repo/apps/client";
    const link = parseSessionChangeLink("./src/../src/old%20name.ts:12:4", diffRoot)!;
    expect(findSessionChangeTarget(link, changes, diffRoot)).toEqual({
      sessionId: "review", path: "src/new name.ts", line: 12,
    });
  });

  it("does not guess by basename or map another checkout into this review", () => {
    for (const href of ["new%20name.ts", "/other/repo/src/new%20name.ts", "../src/new%20name.ts"]) {
      expect(findSessionChangeTarget(parseSessionChangeLink(href, changes.checkoutRoot)!, changes)).toBeNull();
    }
    expect(findSessionChangeTarget(parseSessionChangeLink("src/new%20name.ts", changes.checkoutRoot)!, {
      ...changes, state: "clean", files: [],
    })).toBeNull();
  });

  it("leaves web URLs, document anchors and unsafe schemes out of file navigation", () => {
    for (const href of ["https://example.com/src/new%20name.ts#L12", "//example.com/src/new%20name.ts", "mailto:test@example.com", "#L12", "javascript:alert(1)", "data:text/plain,hi", "file://remote/work/repo/src/new%20name.ts", "src/%00bad.ts", "src/%broken"]) {
      expect(parseSessionChangeLink(href, changes.checkoutRoot)).toBeNull();
    }
  });
});

describe("Session file targets", () => {
  it("resolves a file inside the diff root to a checkout-relative target", () => {
    const link = parseSessionChangeLink("src/new%20name.ts", "/work/repo")!;
    expect(findSessionFileTarget(link, "review", "/work/repo")).toEqual({
      sessionId: "review",
      path: "src/new name.ts",
    });
  });

  it("resolves nested paths, a trailing-slash root, and passes the line through", () => {
    const link = parseSessionChangeLink("./src/deep/file.ts:12:4", "/work/repo")!;
    expect(findSessionFileTarget(link, "review", "/work/repo/")).toEqual({
      sessionId: "review",
      path: "src/deep/file.ts",
      line: 12,
    });
  });

  it("rejects the root itself, sibling prefixes, and paths outside the root", () => {
    for (const href of ["/work/repo", "/work/repo/", "/work/repo2/x.ts", "/other/repo/x.ts", "../outside.ts"]) {
      const link = parseSessionChangeLink(href, "/work/repo")!;
      expect(findSessionFileTarget(link, "review", "/work/repo")).toBeNull();
    }
    expect(
      findSessionFileTarget(
        parseSessionChangeLink("src/file.ts", "/work/repo")!,
        "review",
        undefined,
      ),
    ).toBeNull();
  });

  it("rejects a trailing-slash directory path — there is no file to preview", () => {
    for (const href of ["src/deep/", "/work/repo/src/deep/"]) {
      const link = parseSessionChangeLink(href, "/work/repo")!;
      expect(link.absolutePath.endsWith("/")).toBe(true);
      expect(findSessionFileTarget(link, "review", "/work/repo")).toBeNull();
    }
  });

  it("rejects .git paths, which the backend refuses to read", () => {
    for (const href of [".git", ".git/config", ".git/hooks/pre-commit"]) {
      const link = parseSessionChangeLink(href, "/work/repo")!;
      expect(findSessionFileTarget(link, "review", "/work/repo")).toBeNull();
    }
  });
});
