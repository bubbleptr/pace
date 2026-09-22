import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { describe, expect, it } from "vitest";

describe("chord plugin spike: renderer can host the chord runtime", () => {
  it("bundles the chord root and context entries for the browser with no node: specifier", () => {
    expect(typeof window).not.toBe("undefined");
    // esbuild's startup check compares TextEncoder output with Uint8Array.
    // jsdom installs both from another realm, so the check throws before any
    // bundle exists. Run the build in a plain Node process; a node: import in
    // chord's runtime entry still fails that build.
    const entry = [
      `import { createFacetHost, defineFacet } from "@earendil-works/chord";`,
      `import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";`,
      `export { createFacetHost, defineFacet, BACKGROUND_CONTEXT };`,
    ].join("\n");
    const script = `
      import * as esbuild from "esbuild";
      const result = await esbuild.build({
        stdin: {
          contents: ${JSON.stringify(entry)},
          resolveDir: process.cwd(),
          sourcefile: "chord-renderer-entry.ts",
          loader: "ts",
        },
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
      });
      const text = result.outputFiles.map(file => file.text).join("\\n");
      process.stdout.write(JSON.stringify({
        bytes: text.length,
        nodeSpecifier: text.includes("node:"),
      }));
    `;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: join(process.cwd(), "packages/backend"),
      input: script,
      encoding: "utf8",
      env,
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const summary = JSON.parse(run.stdout) as { bytes: number; nodeSpecifier: boolean };
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.nodeSpecifier).toBe(false);
  });

  it("activates a facet host under jsdom", async () => {
    expect(typeof window).not.toBe("undefined");
    const facet = defineFacet({
      id: "pace-spike/jsdom",
      setup() {},
    });
    const host = await createFacetHost({ facets: [facet] });
    await host.dispose();
  });
});
