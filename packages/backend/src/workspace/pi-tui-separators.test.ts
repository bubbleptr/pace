import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTOCOMPLETE_SEPARATOR_REGEX } from "@pace/core";

// Pace copies pi-tui's autocompleteSeparatorRegex to decide when a file
// reference must serialize as @"<path>". If the installed Pi build changes
// the separator set, quoted paths would diverge from what the TUI produces.
describe("AUTOCOMPLETE_SEPARATOR_REGEX", () => {
  it("matches the separator regex shipped by the installed pi-tui", async () => {
    // import.meta.resolve respects the package's "import" exports condition;
    // pi-tui is a dependency of pi-coding-agent, so resolve it relative to
    // the agent's package root (it is not a direct dependency of ours).
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    let dir = dirname(entry);
    while (!existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error("could not locate the pi-coding-agent package root");
      }
      dir = parent;
    }
    const require = createRequire(join(dir, "package.json"));
    const tuiPkg = require.resolve("@earendil-works/pi-tui/package.json", {
      paths: [dir],
    });

    const utils = await import(
      pathToFileURL(join(dirname(tuiPkg), "dist/utils.js")).href
    );

    expect(AUTOCOMPLETE_SEPARATOR_REGEX.source).toBe(
      utils.autocompleteSeparatorRegex.source,
    );
    expect(AUTOCOMPLETE_SEPARATOR_REGEX.flags).toContain("u");
  });
});
