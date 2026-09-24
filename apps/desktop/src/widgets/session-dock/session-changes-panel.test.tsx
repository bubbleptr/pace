import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionChanges } from "@pace/core";
import {
  applySessionProjectionEvent,
  createSessionProjection,
} from "@/entities/session/session-projection";
import { render } from "@/test/render";
import { SessionChangesPanel } from "./session-changes-panel";

vi.mock("@/entities/session/session-diff-viewer", () => ({
  default: ({ patch, style }: { patch: string; style: string }) => (
    <div data-testid="session-diff-viewer" data-style={style}>
      {patch}
    </div>
  ),
}));

describe("Session changes action surface", () => {
  const projection = applySessionProjectionEvent(
    createSessionProjection({
      id: "session-changes",
      projectId: "pigui",
      initialPrompt: "Review the diff",
      createdAt: "2026-07-19T00:00:00.000Z",
    }),
    {
      type: "checkout-selected",
      stage: "preparing checkout",
      checkout: {
        mode: "foreground-local",
        root: "/work/Pace",
        repoRoot: "/work/Pace",
        projectRoot: "/work/Pace",
        projectRelativePath: ".",
        executionCheckoutRoot: "/work/Pace",
        diffRoot: "/work/Pace",
        runtimeCwd: "/work/Pace",
      },
      occurredAt: "2026-07-19T00:00:00.000Z",
    },
  );

  function changes(overrides: Partial<SessionChanges> = {}): SessionChanges {
    return {
      sessionId: "session-changes",
      state: "ready",
      checkoutRoot: "/work/Pace",
      repositoryRoot: "/work/Pace",
      generatedAt: "2026-07-19T00:01:00.000Z",
      files: [
        {
          path: "src/app.ts",
          kind: "modified",
          staged: false,
          unstaged: true,
          additions: 2,
          deletions: 1,
          binary: false,
          patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
          patchTruncated: false,
        },
        {
          path: "assets/logo.png",
          kind: "modified",
          staged: false,
          unstaged: true,
          additions: null,
          deletions: null,
          binary: true,
          patchTruncated: false,
        },
      ],
      totals: {
        files: 2,
        additions: 2,
        deletions: 1,
        binaryFiles: 1,
        conflictedFiles: 0,
      },
      truncated: false,
      omittedFileCount: 0,
      ...overrides,
    };
  }

  function panel(
    loaded: SessionChanges | null,
    {
      error = null,
      loading = false,
      onRefresh = () => {},
      sessionId = projection.id as string | null,
    }: {
      error?: string | null;
      loading?: boolean;
      onRefresh?: () => void;
      sessionId?: string | null;
    } = {},
  ) {
    return (
      <SessionChangesPanel
        changes={loaded}
        error={error}
        loading={loading}
        sessionId={sessionId}
        stale={projection.stale}
        onRefresh={onRefresh}
      />
    );
  }

  // ADR-0028 (2026-09-05): Changes is single-instance, so its first row is its
  // own state on the left and its actions on the right — no "Diff summary"
  // label, which the rail already says.
  it("states the working tree in the surface's first row, with refresh beside it", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const bar = () => screen.getByTestId("session-surface-bar");
    const view = render(panel(changes(), { onRefresh }));

    expect(within(bar()).getByText("2 files ·", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Diff summary")).not.toBeInTheDocument();
    await user.click(
      within(bar()).getByRole("button", { name: "Refresh Session changes" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(panel(null, { loading: true }));
    expect(within(bar()).getByText("Loading…")).toBeInTheDocument();

    view.rerender(
      panel(
        changes({
          state: "clean",
          files: [],
          totals: {
            files: 0,
            additions: 0,
            deletions: 0,
            binaryFiles: 0,
            conflictedFiles: 0,
          },
        }),
      ),
    );
    expect(within(bar()).getByText("Working tree clean")).toBeInTheDocument();

    view.rerender(panel(changes({ state: "non-git", files: [], repositoryRoot: null })));
    expect(within(bar()).getByText("Not a Git repository")).toBeInTheDocument();

    // A failed read has no state to report: the alert below carries the
    // message, and the row keeps only the action that can fix it.
    view.rerender(panel(null, { error: "Git is temporarily unavailable" }));
    expect(
      within(bar()).queryByText(/files|Working tree|Git repository|Loading/),
    ).not.toBeInTheDocument();
    expect(
      within(bar()).getByRole("button", { name: "Refresh Session changes" }),
    ).toBeInTheDocument();

    // No Session: no state and no action, so no band at all.
    view.rerender(panel(null, { sessionId: null }));
    expect(screen.queryByTestId("session-surface-bar")).not.toBeInTheDocument();
  });

  /** A second text file so the stacked layout has more than one viewer. */
  function twoTextFiles(): SessionChanges {
    const base = changes();
    return {
      ...base,
      files: [
        base.files[0]!,
        {
          path: "src/util.ts",
          kind: "added",
          staged: true,
          unstaged: false,
          additions: 4,
          deletions: 0,
          binary: false,
          patch: "diff --git a/src/util.ts b/src/util.ts\n@@ -0,0 +1 @@\n+util\n",
          patchTruncated: false,
        },
        base.files[1]!,
      ],
      totals: { ...base.totals, files: 3, additions: 6 },
    };
  }

  const sections = () => screen.getAllByTestId("session-change-section");
  const outline = () => screen.getByRole("navigation", { name: "Changed files" });

  it("keeps the outline available when review is bounded", () => {
    render(panel(changes({ truncated: true, omittedFileCount: 3 })));

    expect(screen.getByText("Review is bounded. 3 additional files were omitted.")).toBeInTheDocument();
    expect(outline()).toBeInTheDocument();
    // Physical ordering at narrow dock widths is covered by the Electron E2E.
  });

  it("shows each file's kind and stage in the outline", () => {
    render(panel(twoTextFiles()));

    const rows = within(outline()).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Modified · Working tree");
    expect(rows[1]).toHaveTextContent("Added · Staged");
  });

  it("stacks every file's diff unified, with binary notices inline", async () => {
    render(panel(twoTextFiles()));

    // Every text diff is on screen at once: nothing to select, only scroll.
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
    expect(
      screen.getByText("Binary file changed. A textual diff is not available."),
    ).toBeInTheDocument();
    expect(sections()).toHaveLength(3);
    expect(within(sections()[0]!).getByRole("button", { expanded: true })).toHaveTextContent(
      "src/app.ts",
    );

    // No layout switch: every diff is the unified layout until Settings grows one.
    expect(screen.queryByText("Split")).not.toBeInTheDocument();
    for (const viewer of screen.getAllByTestId("session-diff-viewer")) {
      expect(viewer).toHaveAttribute("data-style", "unified");
    }
  });

  it("unmounts a collapsed section's viewer and brings it back from the outline", async () => {
    const user = userEvent.setup();
    // jsdom has no scrollIntoView; src/test/setup.ts stubs it on HTMLElement.
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    onTestFinished(() => scrollIntoView.mockRestore());

    render(panel(twoTextFiles()));
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);

    await user.click(within(sections()[0]!).getByRole("button", { expanded: true }));
    expect(screen.getAllByTestId("session-diff-viewer")).toHaveLength(1);
    expect(within(sections()[0]!).getByRole("button", { expanded: false })).toBeInTheDocument();

    // The outline names every file and the count, at the density of a list.
    expect(within(outline()).getByText("3 files")).toBeInTheDocument();
    const rows = within(outline()).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("src/app.ts"),
      expect.stringContaining("src/util.ts"),
      expect.stringContaining("assets/logo.png"),
    ]);

    await user.click(rows[0]!);
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.instances[0]).toBe(sections()[0]);
    expect(sections()[0]!.contains(document.activeElement)).toBe(true);
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[1]).not.toHaveAttribute("data-current");

    await user.click(rows[2]!);
    expect(rows[2]).toHaveAttribute("data-current", "true");
    expect(sections()[2]!.contains(document.activeElement)).toBe(true);
    expect(rows[0]).not.toHaveAttribute("data-current");
  });

  it("collapses and expands every section from the surface bar", async () => {
    const user = userEvent.setup();
    const bar = () => screen.getByTestId("session-surface-bar");

    render(panel(twoTextFiles()));
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);

    // The fold toggle lives in the bar's actions.
    await user.click(within(bar()).getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByTestId("session-diff-viewer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Binary file changed. A textual diff is not available."),
    ).not.toBeInTheDocument();

    await user.click(within(bar()).getByRole("button", { name: "Expand all" }));
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
    expect(within(bar()).getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
  });

  it("keeps fold state across a refresh of the same Session and resets it for another", async () => {
    const user = userEvent.setup();

    const view = render(panel(twoTextFiles()));
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
    await user.click(within(sections()[0]!).getByRole("button", { expanded: true }));
    expect(screen.getAllByTestId("session-diff-viewer")).toHaveLength(1);

    // A refresh yields a new object with the same files: the fold survives.
    view.rerender(panel({ ...twoTextFiles(), generatedAt: "2026-07-19T00:02:00.000Z" }));
    expect(screen.getAllByTestId("session-diff-viewer")).toHaveLength(1);

    view.rerender(
      panel({ ...twoTextFiles(), sessionId: "session-other" }, { sessionId: "session-other" }),
    );
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
  });

  it("forgets a removed file's fold when it reappears after later refreshes", async () => {
    const user = userEvent.setup();
    const original = twoTextFiles();
    const view = render(panel(original));
    expect(await screen.findAllByTestId("session-diff-viewer")).toHaveLength(2);
    await user.click(within(sections()[0]!).getByRole("button", { expanded: true }));
    expect(within(sections()[0]!).queryByTestId("session-diff-viewer")).not.toBeInTheDocument();

    view.rerender(panel({ ...original, files: original.files.slice(1) }));
    expect(within(outline()).queryByRole("button", { name: /src\/app.ts/ })).not.toBeInTheDocument();

    view.rerender(panel({ ...original, generatedAt: "2026-07-19T00:03:00.000Z" }));
    expect(within(sections()[0]!).getByRole("button", { expanded: true })).toHaveTextContent("src/app.ts");
    expect(await within(sections()[0]!).findByTestId("session-diff-viewer")).toBeInTheDocument();
  });

  it("keeps conflict and patch-limit notices in their sections with the tree-limit notice below", () => {
    const original = twoTextFiles();
    render(panel({
      ...original,
      files: [
        { ...original.files[0]!, kind: "conflicted", patch: undefined },
        { ...original.files[1]!, patchTruncated: true, patch: undefined },
      ],
      truncated: true,
      omittedFileCount: 4,
    }));

    expect(within(sections()[0]!).getByText(/This file has unresolved merge conflicts/)).toBeInTheDocument();
    expect(within(sections()[1]!).getByText(/This patch exceeds the review limit/)).toBeInTheDocument();
    expect(screen.queryByTestId("session-diff-viewer")).not.toBeInTheDocument();
    expect(screen.getByText("Review is bounded. 4 additional files were omitted.")).toBeInTheDocument();
    expect(within(outline()).getAllByRole("button")).toHaveLength(2);
  });

  it("shows clean and non-Git states without treating them as failures", async () => {
    const view = render(
      panel(
        changes({
          state: "clean",
          files: [],
          totals: {
            files: 0,
            additions: 0,
            deletions: 0,
            binaryFiles: 0,
            conflictedFiles: 0,
          },
        }),
      ),
    );

    expect(
      screen.getByRole("heading", { name: "No changes yet" }),
    ).toBeInTheDocument();

    view.rerender(
      panel(changes({ state: "non-git", files: [], repositoryRoot: null })),
    );
    expect(
      screen.getByRole("heading", { name: "No Git repository" }),
    ).toBeInTheDocument();
  });

  it("exposes load errors, retry, and bounded-review warnings", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    const view = render(
      panel(null, { error: "Git is temporarily unavailable", onRefresh }),
    );

    expect(screen.getByText("Git is temporarily unavailable").closest("[role=alert]")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(
      panel(
        changes({
          truncated: true,
          omittedFileCount: 3,
          files: [
            {
              ...changes().files[0]!,
              patch: undefined,
              patchTruncated: true,
            },
          ],
        }),
      ),
    );
    expect(
      await screen.findByText(
        "This patch exceeds the review limit and was omitted. Open the checkout for the full diff.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Review is bounded. 3 additional files were omitted."),
    ).toBeInTheDocument();
  });
});
