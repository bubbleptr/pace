import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionChanges } from "@pace/core";
import {
  createSessionProjection,
  type SessionProjection,
} from "@/entities/session/session-projection";
import { render } from "@/test/render";
import { FullChatComposer } from "./full-chat-composer";

describe("Context usage placement", () => {
  function boundProjection(
    overrides: Partial<SessionProjection> = {},
  ): SessionProjection {
    return {
      ...createSessionProjection({
        id: "session-context",
        projectId: "pig-docs",
        initialPrompt: "Watch the context window fill up",
        createdAt: "2026-08-20T08:00:00.000Z",
      }),
      status: "completed" as const,
      runtimeId: "pi-sdk:session-context",
      piSessionId: "pi-session-context",
      contextUsage: { tokens: 90_000, contextWindow: 200_000, percent: 45 },
      ...overrides,
    };
  }

  function renderComposerFooter(
    projection: SessionProjection,
    sessionChanges?: {
      changes: SessionChanges | null;
      error: string | null;
      loading: boolean;
      refresh: () => void;
      checkoutBranch: (branch: string) => Promise<void>;
    },
    { queueMode = false }: { queueMode?: boolean } = {},
  ) {
    render(
      <FullChatComposer
        projection={projection}
        queueMode={queueMode}
        sessionChanges={sessionChanges ? { ...sessionChanges, refreshing: false } : undefined}
      />,
    );

    return screen
      .getByTestId("full-chat-composer")
      .querySelector('[data-slot="prompt-input-footer"]');
  }

  function gitChanges(overrides: Partial<SessionChanges> = {}): SessionChanges {
    return {
      sessionId: "session-context",
      state: "clean",
      checkoutRoot: "/work/Pace",
      repositoryRoot: "/work/Pace",
      generatedAt: "2026-09-04T00:00:00.000Z",
      head: {
        oid: "abc1234deadbeef",
        branch: "feat/composer-git",
        detached: false,
      },
      branches: ["feat/composer-git", "main", "fix/spacing", "feat/chat-chain-of-thought-rail"],
      files: [],
      totals: {
        files: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        conflictedFiles: 0,
      },
      truncated: false,
      omittedFileCount: 0,
      ...overrides,
    };
  }

  it("meters the context window as a ring on the composer footer line", () => {
    const footer = renderComposerFooter(boundProjection());

    expect(footer?.querySelector('[data-slot="context-usage-meter"]')).toHaveAttribute(
      "aria-label",
      "Context 45% · 200K",
    );
  });

  it("keeps the footer line while a run is queueing", () => {
    const footer = renderComposerFooter(boundProjection({ status: "running" }), undefined, {
      queueMode: true,
    });

    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toBeInTheDocument();
  });

  it("meters nothing until a runtime is bound, and keeps the Location row", () => {
    const footer = renderComposerFooter(boundProjection({ piSessionId: null }));

    // The row survives Session Creation so the composer keeps its height
    // through the Draft → Live handoff; only the share is unknown until a
    // runtime has a context window to be a share of.
    expect(footer).toBeInTheDocument();
    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toHaveAttribute("aria-label", "Context usage not reported yet");
  });

  function idleSessionChanges(
    changes: SessionChanges | null,
    checkoutBranch: (branch: string) => Promise<void> = async () => {},
  ) {
    return {
      changes,
      error: null as string | null,
      loading: false,
      refresh: () => {},
      checkoutBranch,
    };
  }

  it("shows the Session git branch to the left of the context ring", () => {
    const footer = renderComposerFooter(boundProjection(), idleSessionChanges(gitChanges()));
    const trigger = footer?.querySelector(
      '[data-testid="git-branch-status-trigger"]',
    );
    const ring = footer?.querySelector('[data-slot="context-usage-meter"]');
    const icon = footer?.querySelector('[data-testid="git-branch-status-icon"]');

    expect(trigger).toHaveTextContent("feat/composer-git");
    expect(icon).toBeInTheDocument();
    expect(ring).toBeInTheDocument();
    expect(
      trigger && ring
        ? Boolean(
            trigger.compareDocumentPosition(ring) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : false,
    ).toBe(true);
  });

  it("labels a detached HEAD with the short oid", () => {
    const footer = renderComposerFooter(
      boundProjection(),
      idleSessionChanges(
        gitChanges({
          head: {
            oid: "deadbeefcafebabe",
            branch: null,
            detached: true,
          },
        }),
      ),
    );

    expect(
      footer?.querySelector('[data-testid="git-branch-status-trigger"]'),
    ).toHaveTextContent("deadbee");
  });

  it("checks out the selected local branch on the Session checkout", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn(async () => {});
    renderComposerFooter(
      boundProjection(),
      idleSessionChanges(gitChanges(), checkoutBranch),
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));
    await user.click(await screen.findByRole("option", { name: "main" }));

    expect(checkoutBranch).toHaveBeenCalledWith("main");
  });

  it("surfaces a failed checkout on the composer", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn(async () => {
      throw new Error(
        "Please commit your changes or stash them before you switch branches.",
      );
    });
    renderComposerFooter(
      boundProjection(),
      idleSessionChanges(gitChanges(), checkoutBranch),
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));
    await user.click(await screen.findByRole("option", { name: "main" }));

    expect(
      await screen.findByText(
        /stash them before you switch branches/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the git branch chip when the checkout is not a repository", () => {
    const footer = renderComposerFooter(
      boundProjection(),
      idleSessionChanges(
        gitChanges({
          state: "non-git",
          repositoryRoot: null,
          head: undefined,
        }),
      ),
    );

    expect(
      footer?.querySelector('[data-testid="git-branch-status"]'),
    ).not.toBeInTheDocument();
    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toBeInTheDocument();
  });
});
