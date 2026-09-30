import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createPaceBuiltInExtensions } from "./pi-builtin-extensions";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pace-builtin-extensions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function loadExtensionPaths(options?: { settings?: unknown }) {
  const cwd = await tempDir();
  const agentDir = await tempDir();
  if (options?.settings !== undefined) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    extensionFactories: createPaceBuiltInExtensions(),
  });
  await loader.reload();
  return loader.getExtensions().extensions.map((extension) => extension.path);
}

describe("createPaceBuiltInExtensions", () => {
  it("loads codemode, tool-search, and mcp as builtin extensions", async () => {
    const paths = await loadExtensionPaths();
    expect(paths).toContain("builtin:codemode");
    expect(paths).toContain("builtin:tool-search");
    expect(paths).toContain("builtin:mcp");
  });

  it("honors -builtin:<name> in the extensions setting", async () => {
    const paths = await loadExtensionPaths({
      settings: { extensions: ["-builtin:mcp"] },
    });
    expect(paths).not.toContain("builtin:mcp");
    expect(paths).toContain("builtin:codemode");
    expect(paths).toContain("builtin:tool-search");
  });
});
