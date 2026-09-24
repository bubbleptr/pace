import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import {
  DataPaletteSection,
  DesignPageContent,
  RadiusScaleSection,
  SemanticPaletteSection,
  SpacingScaleSection,
  TypeScaleSection,
} from "@/pages/design";

const repoRoot = process.cwd();

describe("Design tokens layer", () => {
  it("renders one labeled swatch per semantic bridge token", () => {
    render(<SemanticPaletteSection />);

    const section = screen.getByRole("region", { name: "Semantic colors" });

    for (const token of [
      "--foreground",
      "--background",
      "--surface",
      "--surface-muted",
      "--muted",
      "--separator",
      "--primary",
      "--danger",
      "--success",
      "--warning",
    ]) {
      expect(within(section).getByText(token)).toBeInTheDocument();
    }
  });

  it("renders the data visualization palette", () => {
    render(<DataPaletteSection />);

    const section = screen.getByRole("region", { name: "Data colors" });

    for (const token of [
      "--pigui-data-blue",
      "--pigui-data-orange",
      "--pigui-data-amber",
      "--pigui-data-slate",
    ]) {
      expect(within(section).getByText(token)).toBeInTheDocument();
    }
  });

  it("renders the Astryx spacing scale", () => {
    render(<SpacingScaleSection />);

    const section = screen.getByRole("region", { name: "Spacing" });

    for (const token of ["--spacing-1", "--spacing-4", "--spacing-8", "--spacing-12"]) {
      expect(within(section).getByText(token)).toBeInTheDocument();
    }
  });

  it("renders the Astryx radius tokens", () => {
    render(<RadiusScaleSection />);

    const section = screen.getByRole("region", { name: "Radius" });

    for (const token of [
      "--radius-inner",
      "--radius-element",
      "--radius-container",
      "--radius-page",
      "--radius-full",
    ]) {
      expect(within(section).getByText(token)).toBeInTheDocument();
    }
  });

  it("renders the Astryx type scale with live sample text", () => {
    render(<TypeScaleSection />);

    const section = screen.getByRole("region", { name: "Typography" });

    for (const token of [
      "--font-size-xs",
      "--font-size-sm",
      "--font-size-base",
      "--font-size-lg",
      "--font-size-xl",
    ]) {
      expect(within(section).getByText(token)).toBeInTheDocument();
    }
  });
});

describe("Design page tabs", () => {
  it("shows the Tokens tab by default and hides the components layer", () => {
    render(<DesignPageContent />);

    // Astryx Tab renders as a nav-style button with aria-current, not role=tab.
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Components" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("region", { name: "Semantic colors" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Component catalog" })).not.toBeInTheDocument();
  });

  it("switches to the Components tab and back", async () => {
    const user = userEvent.setup();

    render(<DesignPageContent />);

    await user.click(screen.getByRole("button", { name: "Components" }));

    expect(screen.getByRole("navigation", { name: "Component catalog" })).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Semantic colors" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByRole("region", { name: "Semantic colors" })).toBeInTheDocument();
  });

  it("opens Components under Theme and StrictMode without crashing", async () => {
    const user = userEvent.setup();

    render(
      <StrictMode>
        <Theme theme={neutralTheme}>
          <DesignPageContent />
        </Theme>
      </StrictMode>,
    );

    await user.click(screen.getByRole("button", { name: "Components" }));

    expect(screen.getByRole("navigation", { name: "Component catalog" })).toBeInTheDocument();
    expect(screen.queryByText(/crashed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reading 'use'/i)).not.toBeInTheDocument();
  });

  // AGENTS.md hard rule: every shared/ui component registers here.
  it("registers the SessionDock surface host", async () => {
    const user = userEvent.setup();

    render(<DesignPageContent />);

    await user.click(screen.getByRole("button", { name: "Components" }));
    await user.click(screen.getByRole("button", { name: "SessionDock" }));

    expect(
      screen.getByRole("region", { name: "SessionDock" }),
    ).toBeInTheDocument();
  });
});

describe("Design page dev-only gating", () => {
  it("registers the /design route only in development builds", () => {
    const main = readFileSync(
      join(repoRoot, "apps/desktop/src/app/main.tsx"),
      "utf8",
    );

    expect(main).toContain('path: "/design"');
    // The whole route construction and a *dynamic* page import must sit
    // behind the DEV flag: a top-level createRoute()/static import keeps the
    // page referenced in production builds (Rollup cannot prove the call
    // pure), which is how the page once leaked into the prod bundle.
    expect(main).toMatch(
      /import\.meta\.env\.DEV\s*\?\s*\[\s*createRoute\(/,
    );
    expect(main).toContain('import("@/pages/design")');
    expect(main).not.toMatch(/from\s+"@\/pages\/design"/);
  });

  it("exempts /design from the preflight gate", () => {
    const main = readFileSync(
      join(repoRoot, "apps/desktop/src/app/main.tsx"),
      "utf8",
    );

    expect(main).toContain('pathname === "/design"');
  });

  it("adds a dev-only Design entry to system navigation with a Design title", () => {
    const appShell = readFileSync(
      join(repoRoot, "apps/desktop/src/widgets/app-frame/app-frame.tsx"),
      "utf8",
    );

    expect(appShell).toContain('label: "Design"');
    expect(appShell).toMatch(/import\.meta\.env\.DEV[\s\S]{0,200}\/design/);
    // Titlebar shows "Design" while on the page.
    expect(appShell).toContain('return "Design"');
  });
});
