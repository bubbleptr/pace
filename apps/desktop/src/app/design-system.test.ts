import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRequire = createRequire(
  join(process.cwd(), "apps/desktop/package.json"),
);

const repoRoot = process.cwd();

function sourceFilesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const childPath = join(path, entry);
    const childStat = statSync(childPath);

    if (childStat.isDirectory()) {
      return sourceFilesUnder(childPath);
    }

    return /\.(ts|tsx)$/.test(entry) ? [childPath] : [];
  });
}

function resolveLocalFontPath(fromFile: string, fontUrl: string): string {
  if (isAbsolute(fontUrl) || fontUrl.startsWith(".")) {
    return join(dirname(fromFile), fontUrl);
  }

  return desktopRequire.resolve(fontUrl);
}

describe("Design system integration", () => {
  it("uses the default theme at the document root without webfont links", () => {
    const html = readFileSync(join(repoRoot, "apps/desktop/index.html"), "utf8");

    // Assembled so this guard doesn't match its own source.
    const googleFontsHost = ["fonts", "googleapis", "com"].join(".");
    const googleFontsStaticHost = ["fonts", "gstatic", "com"].join(".");

    expect(html).not.toContain("data-theme=");
    expect(html).not.toContain(googleFontsHost);
    expect(html).not.toContain(googleFontsStaticHost);
  });

  it("overrides the Astryx font stack with Montserrat", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    expect(styles).toContain("--font-sans: var(--font-family-body);");
    expect(styles).not.toContain("Figtree");
    expect(styles).not.toContain("Inter");
    // Astryx surfaces pick up Montserrat through the theme's own tokens.
    expect(styles).toContain("--font-family-body: Montserrat");
    expect(styles).toContain("--font-family-heading: Montserrat");
  });

  it("ships Montserrat as a local woff2 so the Astryx stack resolves offline", () => {
    const stylesPath = join(repoRoot, "apps/desktop/src/app/styles.css");
    const styles = readFileSync(stylesPath, "utf8");
    const montserratFaces = [
      ...styles.matchAll(/@font-face\s*\{([\s\S]*?)\}/g),
    ].filter((match) => /font-family:\s*["']?Montserrat["']?\s*;/.test(match[1]));

    expect(montserratFaces.length).toBeGreaterThan(0);

    const woff2Urls = montserratFaces.flatMap((match) =>
      [...match[1].matchAll(/url\((['"]?)([^)'"]+\.woff2)\1\)/g)].map(
        (urlMatch) => urlMatch[2],
      ),
    );

    expect(woff2Urls.length).toBeGreaterThan(0);

    for (const fontUrl of woff2Urls) {
      expect(fontUrl).not.toMatch(/^https?:\/\//);
      expect(existsSync(resolveLocalFontPath(stylesPath, fontUrl))).toBe(true);
    }

    expect(styles).not.toContain(["fonts", "googleapis", "com"].join("."));
    expect(styles).not.toContain(["fonts", "gstatic", "com"].join("."));
  });

  it("bridges the Pace semantic tokens onto Astryx first-level tokens", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    // Bridge must re-resolve inside the Astryx theme scope, not only :root.
    expect(styles).toContain(":root,\n[data-astryx-theme] {");
    expect(styles).toContain("--foreground: var(--color-text-primary);");
    expect(styles).toContain("--muted: var(--color-text-secondary);");
    expect(styles).toContain("--separator: var(--color-border);");
    expect(styles).toContain("--primary: var(--color-accent);");
    expect(styles).toContain("--danger: var(--color-error);");
    expect(styles).toContain("--radius: var(--radius-element);");
    // Tailwind utilities are generated inline from the bridge.
    expect(styles).toContain("@theme inline {");
    expect(styles).toContain("--color-foreground: var(--foreground);");
  });

  it("applies squircle corners globally behind a support gate", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    // The single central lever for continuous-curvature corners: universal
    // because corner-shape neither inherits nor rides a custom property.
    expect(styles).toContain("@supports (corner-shape: squircle) {");
    expect(styles).toMatch(
      /@supports \(corner-shape: squircle\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*corner-shape: squircle;/,
    );
  });

  it("compensates the scalable radius tokens 1.5x for squircle", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    // theme-neutral scale ×1.5: inner 6→9, element 10→15, container 12→18,
    // page/chat 28→42. Perceived roundness matches the pre-squircle look.
    expect(styles).toContain("--radius-inner: 9px;");
    expect(styles).toContain("--radius-element: 15px;");
    expect(styles).toContain("--radius-container: 18px;");
    expect(styles).toContain("--radius-page: 42px;");
    expect(styles).toContain("--radius-chat: 42px;");
  });

  it("keeps circles and pills round under the global squircle rule", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );
    const astryx = readFileSync(
      join(
        repoRoot,
        "apps/desktop/node_modules/@astryxdesign/core/dist/astryx.css",
      ),
      "utf8",
    );

    expect(styles).toContain(".rounded-full,");

    // Astryx StyleX atomics that emit border-radius:50% / var(--radius-full).
    // Content-addressed, so an upgrade that drops one must fail here loudly
    // instead of silently squaring every circle in the app.
    for (const atomic of [
      ".x16rqkct",
      ".xy0xnkn",
      ".xjspbzw",
      ".x19415el",
      ".x1dgc8on",
      ".x1wc3881",
      ".x8agd5o",
    ]) {
      expect(styles).toContain(atomic);
      expect(astryx).toContain(atomic);
    }
  });

  it("wires Astryx base styles and theme before the app renders", () => {
    const main = readFileSync(
      join(repoRoot, "apps/desktop/src/app/main.tsx"),
      "utf8",
    );
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    // Cascade-layer order is pinned explicitly: Astryx layers must outrank
    // Tailwind preflight (base) or Astryx paddings get zeroed, while our
    // components/utilities layers stay on top for app-level overrides.
    expect(styles).toContain(
      "@layer theme, base, properties, reset, astryx-base, astryx-theme, components, utilities;",
    );
    expect(styles.indexOf("@layer theme,")).toBe(0);
    expect(main).not.toContain("@astryxdesign/core/reset.css");
    expect(styles.indexOf('@import "tailwindcss";')).toBeLessThan(
      styles.indexOf('@import "@astryxdesign/core/reset.css";'),
    );
    expect(styles.indexOf('@import "@astryxdesign/core/reset.css";')).toBeLessThan(
      styles.indexOf('@import "@astryxdesign/core/astryx.css";'),
    );
    expect(styles.indexOf('@import "@astryxdesign/core/astryx.css";')).toBeLessThan(
      styles.indexOf('@import "@astryxdesign/theme-neutral/theme.css";'),
    );
    expect(main).toContain('from "@astryxdesign/theme-neutral/built"');
    expect(main).toContain("<Theme theme={neutralTheme}>");
  });

  it("flattens side nav weight only, never the whole app layout", () => {
    const styles = readFileSync(
      join(repoRoot, "apps/desktop/src/app/styles.css"),
      "utf8",
    );

    // Sitting on the layout root this rule erased markdown bold and Tailwind
    // font-medium everywhere; the normalization belongs to the nav.
    expect(styles).toContain(".pigui-app-layout .astryx-side-nav :where(*)");
    expect(styles).not.toMatch(/\.pigui-app-layout :where\(\*\)/);
    expect(styles).not.toContain("data-pigui-session-title");
    expect(styles).toContain(".pigui-app-layout .astryx-side-nav-section span");
    expect(styles).toContain(
      '.pigui-app-layout .astryx-side-nav-item[data-selected="selected"]',
    );
    expect(styles).toContain("font-weight: var(--font-weight-normal, 400);");
    expect(styles).not.toContain("font-weight: var(--font-weight-semibold, 600);");
  });

  it("uses Hugeicons as the renderer icon source", () => {
    const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
    const sourceFiles = sourceFilesUnder(join(repoRoot, "apps/desktop/src"));
    const previousIconPackage = ["lucide", "react"].join("-");
    const filesWithLucide = sourceFiles.filter((file) =>
      readFileSync(file, "utf8").includes(previousIconPackage),
    );

    expect(filesWithLucide).toEqual([]);
    expect(packageJson).toContain('"@hugeicons/react"');
    expect(packageJson).toContain('"@hugeicons/core-free-icons"');
    expect(packageJson).not.toContain(previousIconPackage);
  });

  it("renders Hugeicons with the Pace stroke weight", () => {
    const source = readFileSync(
      join(repoRoot, "apps/desktop/src/shared/ui/icons.tsx"),
      "utf8",
    );

    expect(source).toContain("const paceIconStrokeWidth = 1.5;");
    expect(source).toContain("strokeWidth={paceIconStrokeWidth}");
    expect(source).not.toContain("strokeWidth={2}");
  });
});
