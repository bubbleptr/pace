import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { useProjectGit } from "./project-git";

describe("useProjectGit", () => {
  it("warns with the Project root and the error when the read fails, leaving no summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const loadSummary = vi.fn(async () => {
      throw new Error("git exited with 128");
    });

    const { result } = renderHook(() =>
      useProjectGit({ projectRoot: "/work/pace", loadSummary }),
    );

    await waitFor(() => expect(warn).toHaveBeenCalled());
    const message = warn.mock.calls[0]?.map(String).join(" ");
    expect(message).toContain("/work/pace");
    expect(message).toContain("git exited with 128");
    expect(result.current.summary).toBeNull();
  });
});
