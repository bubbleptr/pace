import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GitBranchPicker } from "./git-branch-picker";

const branches = ["feat/composer-git", "main", "fix/spacing", "feat/chat-chain-of-thought-rail"];

describe("GitBranchPicker", () => {
  it("lists local and remote-tracking branch names in the git selector", async () => {
    const user = userEvent.setup();
    render(
      <GitBranchPicker
        branch="feat/composer-git"
        branches={branches}
        occupiedBranches={[]}
        onBranchChange={() => {}}
      />,
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));

    expect(
      await screen.findByRole("option", { name: "feat/composer-git" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "main" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "fix/spacing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "feat/chat-chain-of-thought-rail" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search branches..."),
    ).toBeInTheDocument();
    // Same inset as the composer model selector popover (`gap-1 p-1`), not
    // Astryx Selector's sm item padding which sits flush against the chrome.
    expect(screen.getByTestId("git-branch-status-menu")).toHaveClass(
      "flex",
      "flex-col",
      "gap-1",
      "p-1",
    );
  });

  it("disables a branch already checked out in another worktree and explains why", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn();
    render(
      <GitBranchPicker
        branch="feat/composer-git"
        branches={branches}
        occupiedBranches={[
          {
            branch: "main",
            path: "/work/.pig-worktrees/Pace/session-other",
          },
        ]}
        onBranchChange={checkoutBranch}
      />,
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));

    const option = await screen.findByRole("option", { name: /main/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("Already checked out in session-other");

    await user.click(option);
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("does not check out the branch the Session is already on", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn();
    render(
      <GitBranchPicker
        branch="feat/composer-git"
        branches={branches}
        occupiedBranches={[]}
        onBranchChange={checkoutBranch}
      />,
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));
    await user.click(
      await screen.findByRole("option", { name: "feat/composer-git" }),
    );

    expect(checkoutBranch).not.toHaveBeenCalled();
  });
});
