import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listSessionDirectory,
  readSessionFile,
  resolveSessionFiles,
} from "@/entities/session/session-files";
import type { PaceRendererApi } from "@/shared/runtime";

function installInvoke(invoke: ReturnType<typeof vi.fn>) {
  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: vi.fn(),
    onBrowserEvent: vi.fn(),
    onUpdateEvent: vi.fn(),
    onWindowFocusChanged: vi.fn(),
    onNavigateRequest: vi.fn(),
  };
}

describe("session file queries", () => {
  afterEach(() => {
    delete window.pace;
  });

  it("lists the diff root when no path is given", async () => {
    const invoke = vi.fn(async () => ({
      sessionId: "session-1",
      path: "",
      rootName: "repo",
      entries: [],
      truncated: false,
    }));
    installInvoke(invoke);

    await expect(listSessionDirectory("session-1")).resolves.toMatchObject({
      rootName: "repo",
    });
    expect(invoke).toHaveBeenCalledWith("list_session_directory", {
      sessionId: "session-1",
      path: "",
    });
  });

  it("reads a file by its diff-root-relative path", async () => {
    const invoke = vi.fn(async () => ({
      sessionId: "session-1",
      path: "src/index.ts",
      size: 5,
      content: "hello",
      truncated: false,
      binary: false,
    }));
    installInvoke(invoke);

    await expect(readSessionFile("session-1", "src/index.ts")).resolves.toMatchObject({
      content: "hello",
    });
    expect(invoke).toHaveBeenCalledWith("read_session_file", {
      sessionId: "session-1",
      path: "src/index.ts",
    });
  });

  it("resolves which candidate paths are real files", async () => {
    const invoke = vi.fn(async () => ({ files: ["src/index.ts"] }));
    installInvoke(invoke);

    await expect(
      resolveSessionFiles("session-1", ["src/index.ts", "src/missing.ts"]),
    ).resolves.toEqual({ files: ["src/index.ts"] });
    expect(invoke).toHaveBeenCalledWith("resolve_session_files", {
      sessionId: "session-1",
      paths: ["src/index.ts", "src/missing.ts"],
    });
  });
});
