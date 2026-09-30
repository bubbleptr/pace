#!/usr/bin/env node
// Read-only check: can a verification drive launch Pace? Does not start Electron.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function which(command) {
  const found = commandVersion("sh", ["-c", `command -v ${command}`]);
  return found && found.length > 0 ? found.split("\n")[0] : null;
}

const problems = [];
const warnings = [];

let paceVersion = null;
const packageJsonPath = path.join(repoRoot, "package.json");
if (!existsSync(packageJsonPath)) {
  problems.push(`No package.json at ${repoRoot}`);
} else {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg.name !== "pace") {
    problems.push(`Expected package name "pace", found ${JSON.stringify(pkg.name)}`);
  }
  paceVersion = pkg.version ?? null;
}

const mainPath = path.join(repoRoot, "apps", "desktop", "out", "main", "main.js");
let mainBytes = 0;
if (!existsSync(mainPath)) {
  problems.push(
    "apps/desktop/out/main/main.js is missing. From the repo root run: bun install && bun run build",
  );
} else {
  mainBytes = statSync(mainPath).size;
  if (mainBytes === 0) {
    problems.push("apps/desktop/out/main/main.js is empty. Re-run: bun run build");
  }
}

const electronBin = path.join(
  repoRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
if (!existsSync(electronBin)) {
  problems.push(
    "Electron binary is missing. From the repo root run: bun install (postinstall downloads Electron)",
  );
}

const playwrightCli = path.join(repoRoot, "node_modules", ".bin", "playwright");
if (!existsSync(playwrightCli)) {
  problems.push("Playwright is missing. From the repo root run: bun install");
}

const git = commandVersion("git", ["--version"]);
if (!git) {
  warnings.push("git is not on PATH. The Changes drive and preflight's optional Git row need it.");
}

const bun = commandVersion("bun", ["--version"]);
if (!bun && !existsSync(mainPath)) {
  problems.push("bun is not on PATH, and there is no build to drive.");
} else if (!bun) {
  warnings.push("bun is not on PATH. An existing build can still be driven.");
}

const display = process.env.DISPLAY ?? null;
const xvfb = Boolean(which("xvfb-run"));
if (process.platform === "linux" && !display && !xvfb) {
  problems.push(
    "Linux has neither DISPLAY nor xvfb-run. Install xvfb and use scripts/drive-changes.sh, or export DISPLAY.",
  );
}

const report = {
  ok: problems.length === 0,
  repoRoot,
  paceVersion,
  main: existsSync(mainPath) ? mainPath : null,
  mainBytes,
  electron: existsSync(electronBin) ? electronBin : null,
  playwright: existsSync(playwrightCli),
  git,
  bun,
  node: process.version,
  platform: process.platform,
  display,
  xvfb,
  warnings,
  problems,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
