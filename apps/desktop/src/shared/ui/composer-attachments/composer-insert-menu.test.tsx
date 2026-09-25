import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Command, Sparkles } from "@/shared/ui/icons";
import { ComposerInsertMenu, type ComposerInsertCatalog } from "./composer-insert-menu";

function catalogs(): ComposerInsertCatalog[] {
  return [
    {
      id: "skills",
      label: "Skills",
      icon: <Sparkles />,
      searchLabel: "Search skills",
      emptyText: "No matching skills",
      items: [
        { id: "skill:review-pr", label: "review-pr", description: "Check a pull request for bugs" },
        { id: "skill:write-docs", label: "write-docs", description: "Write project documentation" },
      ],
    },
    {
      id: "prompts",
      label: "Prompts",
      icon: <Command />,
      searchLabel: "Search prompts",
      emptyText: "No matching prompts",
      items: [{ id: "fix", label: "fix" }],
    },
  ];
}

describe("ComposerInsertMenu", () => {
  it("lists Add files followed by each non-empty catalog", async () => {
    const onAttach = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerInsertMenu
        catalogs={[
          ...catalogs(),
          {
            id: "empty-group",
            label: "Empty",
            icon: <Command />,
            searchLabel: "Search",
            emptyText: "Nothing",
            items: [],
          },
        ]}
        onAttach={onAttach}
        onPick={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Add files",
      "Skills",
      "Prompts",
    ]);

    await user.click(screen.getByRole("menuitem", { name: "Add files" }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("keeps the first menu short even with many catalog entries", async () => {
    const user = userEvent.setup();
    render(
      <ComposerInsertMenu
        catalogs={[
          {
            id: "skills",
            label: "Skills",
            icon: <Sparkles />,
            searchLabel: "Search skills",
            emptyText: "No matching skills",
            items: Array.from({ length: 80 }, (_, i) => ({ id: `skill-${i}`, label: `skill-${i}` })),
          },
        ]}
        onAttach={() => {}}
        onPick={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("searches catalog items by label and description and reports the pick", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<ComposerInsertMenu catalogs={catalogs()} onAttach={() => {}} onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    await user.click(screen.getByRole("menuitem", { name: "Skills" }));

    const search = await screen.findByRole("combobox", { name: "Search skills" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, "no-such-skill");
    expect(await screen.findByText("No matching skills")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "pull request");
    expect(await screen.findByText("review-pr")).toBeInTheDocument();
    expect(screen.queryByText("write-docs")).not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("skills", "skill:review-pr");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Skills" })).not.toBeInTheDocument(),
    );
  });

  it("lists an async catalog without items and searches it through the backend", async () => {
    const search = vi.fn(async (query: string) =>
      query === "main"
        ? [{ id: "src/main.ts", label: "main.ts", description: "src/main.ts" }]
        : [],
    );
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerInsertMenu
        catalogs={[
          {
            id: "files",
            label: "Reference file",
            icon: <Command />,
            searchLabel: "Search files",
            emptyText: "No matching files",
            search,
          },
        ]}
        onAttach={() => {}}
        onPick={onPick}
      />,
    );

    // A search-backed catalog is always listed — its contents are unknown
    // until queried.
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    await user.click(screen.getByRole("menuitem", { name: "Reference file" }));

    const input = await screen.findByRole("combobox", { name: "Search files" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "main");

    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("files", "src/main.ts");
  });
});
