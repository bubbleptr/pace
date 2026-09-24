import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentStackEntry } from "./fiber-stack";
import { matchRegion, uiRegions } from "./regions";

function componentEntry(name: string): ComponentStackEntry {
  return { name, kind: "component", file: null, line: null, library: false };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("uiRegions registry", () => {
  it("only binds terms that exist as **Term**: headings in CONTEXT.md", () => {
    // vitest runs from the repo root (the root vite.config.ts assumes it too).
    const context = readFileSync(resolve(process.cwd(), "CONTEXT.md"), "utf8");

    for (const region of uiRegions) {
      expect(context, `missing CONTEXT.md term: ${region.term}`).toContain(
        `**${region.term}**:`,
      );
    }
  });

  it("only binds component names declared under apps/desktop/src", () => {
    // Bindings are display-name strings, so a rename or a lost component would
    // otherwise leave a region silently unmatched.
    const root = resolve(process.cwd(), "apps/desktop/src");
    const source = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => readFileSync(resolve(root, file), "utf8"))
      .join("\n");

    for (const region of uiRegions) {
      for (const name of region.match.components ?? []) {
        expect(
          new RegExp(`\\b(?:function|const)\\s+${name}\\b`).test(source),
          `no declaration of component ${name} (region ${region.term})`,
        ).toBe(true);
      }
    }
  });

  it("gives every region at least one matcher", () => {
    for (const region of uiRegions) {
      const { components = [], testIds = [], selectors = [] } = region.match;
      expect(
        components.length + testIds.length + selectors.length,
        `region ${region.term} has no matcher`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("matchRegion", () => {
  it("matches a component on the fiber stack, innermost first", () => {
    const stack = [componentEntry("PiTrajectoryLedger"), componentEntry("SessionDetailView")];
    expect(matchRegion(stack, null)?.region.term).toBe("Ledger");
  });

  it("treats earlier stack entries as more specific", () => {
    const stack = [componentEntry("SessionDetailView"), componentEntry("PiTrajectoryLedger")];
    expect(matchRegion(stack, null)?.region.term).toBe("Trajectory Cockpit");
  });

  it("prefers the clicked element's own attributes over the stack", () => {
    document.body.innerHTML = `<div data-testid="session-detail-view"><p data-slot="trajectory-tally" id="t">x</p></div>`;
    const element = document.getElementById("t");

    expect(
      element && matchRegion([componentEntry("SessionDetailView")], element)?.region.term,
    ).toBe("Tally");
  });

  it("falls back to DOM ancestors when the stack has no match", () => {
    document.body.innerHTML = `<div data-testid="sidebar-projects"><span id="s">x</span></div>`;
    const element = document.getElementById("s");

    expect(element && matchRegion([], element)?.region.term).toBe("Project Sidebar");
  });

  it("returns null when nothing matches", () => {
    document.body.innerHTML = `<div><span id="n">x</span></div>`;
    expect(matchRegion([], document.getElementById("n") ?? null)).toBeNull();
  });
});

describe("additional named regions", () => {
  it.each([
    ["ModelSelectorControl", "Model"],
    ["ChatChainOfThought", "Chain of Thought"],
    ["ChatThoughtStep", "Thinking"],
    ["ChatToolStep", "Tool Call"],
    ["SessionBrowserPanel", "Surface"],
    ["TerminalView", "Surface"],
    ["CheckoutStrategyPicker", "Execution Checkout"],
    ["ChatNavigation", "Chat Workspace"],
  ])("maps %s to %s", (name, term) => {
    expect(matchRegion([componentEntry(name)], null)?.region.term).toBe(term);
  });

  it("prefers a named DOM subregion over a broad component ancestor", () => {
    document.body.innerHTML = '<div data-slot="trajectory-tally"><span id="value">12</span></div>';
    const host: ComponentStackEntry = {
      name: "div", kind: "element", file: null, line: null, library: false,
      fiber: { type: "div", child: null, sibling: null, return: null,
        stateNode: document.querySelector('[data-slot="trajectory-tally"]') },
    };
    expect(matchRegion([host, componentEntry("SessionDetailView")], document.getElementById("value"))?.region.term).toBe("Tally");
  });
});
