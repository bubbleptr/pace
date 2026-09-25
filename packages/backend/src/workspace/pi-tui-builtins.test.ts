import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_TUI_BUILTIN_COMMANDS } from "@pace/core";

// The list Pace blocks at submit time must stay in sync with the Pi build
// actually installed — drift means we either let a TUI-only command through
// or block a command the installed Pi no longer owns.
describe("PI_TUI_BUILTIN_COMMANDS", () => {
  it("matches the command names declared by the installed Pi package", () => {
    // import.meta.resolve respects the package's "import" exports condition
    // (require.resolve cannot see it — the package declares no "require" or
    // "default" entry). Walk up from the landed file to the package root.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    let dir = dirname(entry);
    while (!existsSync(join(dir, "dist/core/slash-commands.js"))) {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error("could not locate the pi-coding-agent package root");
      }
      dir = parent;
    }

    const source = readFileSync(join(dir, "dist/core/slash-commands.js"), "utf8");
    const names = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);

    expect(new Set(names)).toEqual(new Set(PI_TUI_BUILTIN_COMMANDS));
    expect(names.length).toBeGreaterThan(0);
  });
});
