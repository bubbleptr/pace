import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AUTOCOMPLETE_SEPARATOR_REGEX } from "@pace/core";
import type { WorkspaceFileMatch } from "@pace/core";
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import {
  fileReferenceText,
  fileToken,
  atTrigger,
} from "./workspace-file-tokens";

const file = (path: string): WorkspaceFileMatch => ({ path, kind: "file" });
const dir = (path: string): WorkspaceFileMatch => ({ path, kind: "directory" });

describe("fileReferenceText", () => {
  it("serializes a plain file path", () => {
    expect(fileReferenceText(file("apps/desktop/src/main.ts"))).toBe(
      "@apps/desktop/src/main.ts",
    );
  });

  it("appends a trailing slash to directories", () => {
    expect(fileReferenceText(dir("src/components"))).toBe("@src/components/");
  });

  it("quotes paths containing separator characters", () => {
    expect(fileReferenceText(file("docs/my notes/todo.md"))).toBe(
      '@"docs/my notes/todo.md"',
    );
  });

  it("quotes a spaced directory path and keeps the trailing slash", () => {
    expect(fileReferenceText(dir("my dir"))).toBe('@"my dir/"');
  });

  it("quotes CJK punctuation like Pi does", () => {
    expect(fileReferenceText(file("notes，draft.md"))).toBe(
      '@"notes，draft.md"',
    );
  });
});

describe("fileToken", () => {
  it("maps a file to a cyan badge labeled by basename", () => {
    const token = fileToken(file("apps/desktop/src/main.ts"));

    expect(token.value).toBe("@apps/desktop/src/main.ts");
    expect(token).toMatchObject({ variant: "cyan" });
    const { container } = render(<>{"icon" in token ? token.icon : null}</>);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("labels a directory with basename plus trailing slash", () => {
    const token = fileToken(dir("src/components"));

    expect("label" in token && token.label).toBe("components/");
    expect(token.value).toBe("@src/components/");
  });
});

describe("atTrigger searchSource", () => {
  const matches = [file("a.ts"), dir("src")];

  it("is detected as async by Astryx's search('') probe and maps matches to items", async () => {
    const search = vi.fn(async () => matches);
    const source = atTrigger(search).searchSource;

    const probe = source.search("");
    expect(probe).toBeInstanceOf(Promise);
    const items = await source.search("a");
    expect(items.map((item) => item.id)).toEqual(["a.ts", "src"]);
    expect(items[0]?.auxiliaryData).toEqual({ match: matches[0] });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("reuses the empty-query probe promise for 10 seconds", async () => {
    let now = 1_000;
    const search = vi.fn(async () => matches);
    const source = atTrigger(search, { now: () => now }).searchSource;

    await source.search("");
    await source.search("");
    expect(search).toHaveBeenCalledTimes(1);

    now += 9_999;
    await source.search("");
    expect(search).toHaveBeenCalledTimes(1);

    now += 1;
    await source.search("");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("never settles a superseded query, so stale results cannot clobber newer ones", async () => {
    const deferred: Array<() => void> = [];
    const search = vi.fn(
      () =>
        new Promise<WorkspaceFileMatch[]>((resolve) => {
          deferred.push(() => resolve(matches));
        }),
    );
    const source = atTrigger(search).searchSource;

    const first = source.search("a");
    source.cancel?.();
    const second = source.search("ab");

    let firstSettled = false;
    void Promise.resolve(first).then(() => {
      firstSettled = true;
    });
    deferred.forEach((resolve) => resolve());
    const secondItems = await second;
    await Promise.resolve();

    expect(secondItems.map((item) => item.id)).toEqual(["a.ts", "src"]);
    expect(firstSettled).toBe(false);
  });

  it("does not let a superseded failure clear the current query's results", async () => {
    let rejectFirst!: (reason: Error) => void;
    const search = vi.fn((query: string) =>
      query === "a"
        ? new Promise<WorkspaceFileMatch[]>((_, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(matches),
    );
    const source = atTrigger(search).searchSource;
    let firstSettled = false;
    void Promise.resolve(source.search("a")).then(
      () => { firstSettled = true; },
      () => { firstSettled = true; },
    );

    const items = await source.search("ab");
    rejectFirst(new Error("Previous search failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(items.map((item) => item.id)).toEqual(["a.ts", "src"]);
    expect(firstSettled).toBe(false);
  });

  it("describes the trigger chrome", () => {
    const trigger: ChatComposerTrigger = atTrigger(async () => matches);

    expect(trigger.character).toBe("@");
    expect(trigger.emptySearchResultsText).toBe("No matching files");
    expect(trigger.loadingText).toBe("Searching files…");
  });
});

describe("AUTOCOMPLETE_SEPARATOR_REGEX", () => {
  it("matches whitespace and the CJK punctuation Pi treats as separators", () => {
    expect(AUTOCOMPLETE_SEPARATOR_REGEX.test("a b")).toBe(true);
    expect(AUTOCOMPLETE_SEPARATOR_REGEX.test("a，b")).toBe(true);
    expect(AUTOCOMPLETE_SEPARATOR_REGEX.test("a/b")).toBe(false);
    expect(AUTOCOMPLETE_SEPARATOR_REGEX.test("a-b")).toBe(false);
  });
});
