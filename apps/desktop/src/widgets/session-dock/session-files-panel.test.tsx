import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDirectoryListing, SessionFileContent } from "@pace/core";
import { SessionFilesPanel } from "./session-files-panel";

const listSessionDirectory = vi.fn<
  (sessionId: string, path?: string) => Promise<SessionDirectoryListing>
>();
const readSessionFile = vi.fn<
  (sessionId: string, path: string) => Promise<SessionFileContent>
>();

vi.mock("@/entities/session/session-files", () => ({
  listSessionDirectory: (sessionId: string, path?: string) =>
    listSessionDirectory(sessionId, path),
  readSessionFile: (sessionId: string, path: string) =>
    readSessionFile(sessionId, path),
}));

vi.mock("@/entities/session/session-file-viewer", () => ({
  default: ({ path, contents }: { path: string; contents: string }) => (
    <div data-testid="session-file-viewer" data-path={path}>
      {contents}
    </div>
  ),
}));

function listing(
  path: string,
  entries: SessionDirectoryListing["entries"],
  truncated = false,
): SessionDirectoryListing {
  return { sessionId: "session-1", path, rootName: "repo", entries, truncated };
}

function fileContent(
  path: string,
  overrides: Partial<SessionFileContent> = {},
): SessionFileContent {
  return {
    sessionId: "session-1",
    path,
    size: 12,
    content: "export {};\n",
    truncated: false,
    binary: false,
    ...overrides,
  };
}

const rootListing = listing("", [
  { name: "src", path: "src", kind: "directory", size: null },
  { name: "README.md", path: "README.md", kind: "file", size: 12 },
  { name: "link", path: "link", kind: "symlink", size: null },
]);

function scriptListings(byPath: Record<string, SessionDirectoryListing>) {
  listSessionDirectory.mockImplementation(async (_sessionId, path = "") => {
    const result = byPath[path];
    if (!result) {
      throw new Error(`No listing scripted for "${path}"`);
    }
    return result;
  });
}

describe("SessionFilesPanel", () => {
  beforeEach(() => {
    listSessionDirectory.mockReset();
    readSessionFile.mockReset();
  });

  it("renders the root listing under the root name", async () => {
    scriptListings({ "": rootListing });

    render(<SessionFilesPanel sessionId="session-1" />);

    const tree = await screen.findByRole("tree");
    expect(within(tree).getByText("src")).toBeInTheDocument();
    expect(within(tree).getByText("README.md")).toBeInTheDocument();
    expect(within(tree).getByText("link")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("Select a file to preview it.")).toBeInTheDocument();
    expect(listSessionDirectory).toHaveBeenCalledWith("session-1", "");
  });

  it("replaces an empty checkout state with the file tree after refresh", async () => {
    const user = userEvent.setup();
    listSessionDirectory.mockResolvedValueOnce(listing("", []));
    render(<SessionFilesPanel sessionId="session-1" />);
    expect(await screen.findByRole("heading", { name: "No files yet" })).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(readSessionFile).not.toHaveBeenCalled();

    listSessionDirectory.mockResolvedValueOnce(rootListing);
    await user.click(screen.getByRole("button", { name: "Refresh Session files" }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No files yet" })).not.toBeInTheDocument();
    expect(screen.getByText("Select a file to preview it.")).toBeInTheDocument();
  });

  it("loads a directory's children when it is expanded", async () => {
    const user = userEvent.setup();
    scriptListings({
      "": rootListing,
      src: listing("src", [
        { name: "index.ts", path: "src/index.ts", kind: "file", size: 3 },
      ]),
    });

    render(<SessionFilesPanel sessionId="session-1" />);

    const directory = await screen.findByText("src");
    expect(listSessionDirectory).not.toHaveBeenCalledWith("session-1", "src");
    await user.click(directory);

    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(listSessionDirectory).toHaveBeenCalledWith("session-1", "src");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps expanded directories visible and reloads their descendants on refresh", async () => {
    const user = userEvent.setup();
    let resolveRoot!: (value: SessionDirectoryListing) => void;
    const refreshedRoot = new Promise<SessionDirectoryListing>((resolve) => {
      resolveRoot = resolve;
    });
    const src = listing("src", [
      { name: "nested", path: "src/nested", kind: "directory", size: null },
    ]);
    const nested = listing("src/nested", [
      { name: "index.ts", path: "src/nested/index.ts", kind: "file", size: 3 },
    ]);
    listSessionDirectory
      .mockResolvedValueOnce(rootListing)
      .mockResolvedValueOnce(src)
      .mockResolvedValueOnce(nested)
      .mockImplementationOnce(() => refreshedRoot)
      .mockResolvedValueOnce(src)
      .mockResolvedValueOnce(listing("src/nested", [
        { name: "updated.ts", path: "src/nested/updated.ts", kind: "file", size: 4 },
      ]));

    render(<SessionFilesPanel sessionId="session-1" />);
    await user.click(await screen.findByText("src"));
    await user.click(await screen.findByText("nested"));
    await screen.findByText("index.ts");
    const tree = screen.getByRole("tree");

    await user.click(screen.getByRole("button", { name: "Refresh Session files" }));
    expect(screen.getByRole("tree")).toBe(tree);
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    await act(async () => resolveRoot(rootListing));

    expect(await screen.findByText("updated.ts")).toBeInTheDocument();
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    for (const name of ["src", "nested"]) {
      expect(screen.getByText(name).closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    }
    expect(listSessionDirectory.mock.calls.map(([, path]) => path)).toEqual([
      "", "src", "src/nested", "", "src", "src/nested",
    ]);
  });

  it("keeps an empty directory expandable and shows its empty state", async () => {
    const user = userEvent.setup();
    scriptListings({ "": rootListing, src: listing("src", []) });
    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("src"));
    expect(await screen.findByRole("treeitem", { name: "Empty directory" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByText("src"));
    expect(screen.queryByText("Empty directory")).not.toBeInTheDocument();
    await user.click(screen.getByText("src"));
    expect(screen.getByText("Empty directory")).toBeInTheDocument();
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
  });

  it("shows an error row when a directory fails to load", async () => {
    const user = userEvent.setup();
    listSessionDirectory.mockImplementation(async (_sessionId, path = "") => {
      if (path === "") return rootListing;
      throw new Error("permission denied");
    });

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("src"));

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });

  it("retries a failed child listing when collapsed and expanded again", async () => {
    const user = userEvent.setup();
    listSessionDirectory
      .mockResolvedValueOnce(rootListing)
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(listing("src", [
        { name: "recovered.ts", path: "src/recovered.ts", kind: "file", size: 3 },
      ]));
    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("src"));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(listSessionDirectory).toHaveBeenCalledTimes(2);
    await user.click(screen.getByText("src"));
    expect(screen.queryByText("permission denied")).not.toBeInTheDocument();
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByText("src"));

    expect(await screen.findByText("recovered.ts")).toBeInTheDocument();
    expect(screen.queryByText("permission denied")).not.toBeInTheDocument();
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    expect(listSessionDirectory.mock.calls.map(([, path]) => path)).toEqual(["", "src", "src"]);
  });

  it("refreshes an expanded directory after its listing failed", async () => {
    const user = userEvent.setup();
    listSessionDirectory
      .mockResolvedValueOnce(rootListing)
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(rootListing)
      .mockResolvedValueOnce(listing("src", [
        { name: "recovered.ts", path: "src/recovered.ts", kind: "file", size: 3 },
      ]));
    render(<SessionFilesPanel sessionId="session-1" />);
    await user.click(await screen.findByText("src"));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");

    await user.click(screen.getByRole("button", { name: "Refresh Session files" }));

    expect(await screen.findByText("recovered.ts")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("src").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    expect(listSessionDirectory.mock.calls.map(([, path]) => path)).toEqual(["", "src", "", "src"]);
  });

  it("marks a truncated listing", async () => {
    scriptListings({ "": listing("", rootListing.entries, true) });

    render(<SessionFilesPanel sessionId="session-1" />);

    expect(await screen.findByText("Listing truncated")).toBeInTheDocument();
  });

  it("previews a file's contents when it is selected", async () => {
    const user = userEvent.setup();
    scriptListings({ "": rootListing });
    readSessionFile.mockResolvedValue(
      fileContent("README.md", { content: "# Repo\n" }),
    );

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("README.md"));

    const viewer = await screen.findByTestId("session-file-viewer");
    expect(viewer).toHaveAttribute("data-path", "README.md");
    expect(viewer).toHaveTextContent("# Repo");
    expect(readSessionFile).toHaveBeenCalledWith("session-1", "README.md");
    expect(
      screen.getByRole("treeitem", { name: "README.md" }),
    ).toHaveAttribute("aria-selected", "true");
    // The surface bar names the selected file instead of the root.
    expect(
      within(screen.getByTestId("session-surface-bar")).getByText("README.md"),
    ).toBeInTheDocument();
  });

  it("does not request a preview for symlinks", async () => {
    const user = userEvent.setup();
    scriptListings({ "": rootListing });

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("link"));

    expect(readSessionFile).not.toHaveBeenCalled();
    expect(screen.getByText("Select a file to preview it.")).toBeInTheDocument();
  });

  it("explains binary, truncated, and empty files instead of rendering them", async () => {
    const user = userEvent.setup();
    scriptListings({
      "": listing("", [
        { name: "logo.png", path: "logo.png", kind: "file", size: 900 },
        { name: "big.log", path: "big.log", kind: "file", size: 9_000_000 },
        { name: "empty.txt", path: "empty.txt", kind: "file", size: 0 },
      ]),
    });
    readSessionFile.mockImplementation(async (_sessionId, path) => {
      if (path === "logo.png") return fileContent(path, { binary: true, content: "" });
      if (path === "big.log") return fileContent(path, { truncated: true, content: "head" });
      return fileContent(path, { content: "", size: 0 });
    });

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("logo.png"));
    expect(
      await screen.findByText("Binary file. A preview is not available."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("session-file-viewer")).not.toBeInTheDocument();

    await user.click(screen.getByText("big.log"));
    expect(await screen.findByTestId("session-file-viewer")).toHaveTextContent("head");
    expect(screen.getByText(/Only the first part of this file is shown/)).toBeInTheDocument();

    await user.click(screen.getByText("empty.txt"));
    expect(await screen.findByText("This file is empty.")).toBeInTheDocument();
    expect(screen.queryByTestId("session-file-viewer")).not.toBeInTheDocument();
  });

  it("surfaces a read failure with a retry", async () => {
    const user = userEvent.setup();
    scriptListings({ "": rootListing });
    readSessionFile
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(fileContent("README.md", { content: "ok" }));

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("README.md"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("read failed");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("session-file-viewer")).toHaveTextContent("ok");
  });

  it("shows the root load failure with a retry", async () => {
    const user = userEvent.setup();
    listSessionDirectory
      .mockRejectedValueOnce(new Error("no checkout"))
      .mockResolvedValueOnce(rootListing);

    render(<SessionFilesPanel sessionId="session-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no checkout");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });

  it("re-requests the tree and the open file on refresh", async () => {
    const user = userEvent.setup();
    scriptListings({ "": rootListing });
    readSessionFile.mockResolvedValue(fileContent("README.md"));

    render(<SessionFilesPanel sessionId="session-1" />);

    await user.click(await screen.findByText("README.md"));
    await screen.findByTestId("session-file-viewer");
    expect(listSessionDirectory).toHaveBeenCalledTimes(1);
    expect(readSessionFile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Refresh Session files" }));

    await waitFor(() => {
      expect(listSessionDirectory).toHaveBeenCalledTimes(2);
      expect(readSessionFile).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId("session-file-viewer")).toBeInTheDocument();
  });
});
