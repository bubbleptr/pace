import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PromptCommand, PromptCommandCatalog } from "@pace/core";
import { sortPromptCommands } from "@pace/core";

export type ResolveStaticPromptCommandsInput = {
  root: string;
  agentDir: string;
};

// Mirrors Pi 0.87.1's private loadTemplateFromFile (core/prompt-templates.js):
// the command name is the basename without ".md" and the description comes
// from frontmatter, falling back to the first non-empty body line truncated
// to 60 characters. Unreadable or unparseable files are skipped.
function readPromptTemplate(filePath: string): { name: string; description: string } | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(raw));
  } catch {
    return null;
  }
  let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim());
    if (firstLine) {
      description = firstLine.slice(0, 60);
      if (firstLine.length > 60) description += "...";
    }
  }
  return { name: basename(filePath).replace(/\.md$/, ""), description };
}

// Mirrors Pi 0.87.1's private loadTemplatesFromDir: non-recursive, ".md"
// only, and symlinks must resolve to a file.
function promptTemplateFiles(resourcePath: string): string[] {
  let stats;
  try {
    stats = statSync(resourcePath);
  } catch {
    return [];
  }
  if (stats.isFile()) {
    return resourcePath.endsWith(".md") ? [resourcePath] : [];
  }
  if (!stats.isDirectory()) return [];
  try {
    const files: string[] = [];
    for (const entry of readdirSync(resourcePath, { withFileTypes: true })) {
      const fullPath = join(resourcePath, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }
      if (isFile && entry.name.endsWith(".md")) files.push(fullPath);
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Resolve the "/" catalog from disk for drafts and cold sessions. This must
 * not go through DefaultResourceLoader: its reload() calls
 * packageManager.resolve() with no onMissing, which installs any missing —
 * or merely version-mismatched — npm/git package. A read-only completion
 * query must never trigger an install, so this walks the resolved resource
 * list directly, replicating Pi 0.87.1's loading rules instead. Settings are
 * still read through the file-backed manager (verified read-only) so trust,
 * package filters and "!name" disables behave exactly as at runtime.
 * Extension code is never touched, so extension commands only exist on the
 * runtime path.
 */
export async function resolveStaticPromptCommands(
  input: ResolveStaticPromptCommandsInput,
): Promise<PromptCommandCatalog> {
  const settingsManager = SettingsManager.create(input.root, input.agentDir);
  const packages = new DefaultPackageManager({
    cwd: input.root,
    agentDir: input.agentDir,
    settingsManager,
  });
  // "skip" turns a missing package into an empty resource list instead of an
  // install; offline mode is only a backstop inside resolve().
  const resources = await packages.resolve(async () => "skip");

  // Pi's loader keeps the first resource that claims a (kind, name) pair in
  // resolve order; the same rule holds here.
  const seen = new Set<string>();
  const commands: PromptCommand[] = [];
  const push = (command: PromptCommand) => {
    const key = `${command.kind} ${command.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    commands.push(command);
  };

  for (const resource of resources.skills) {
    if (!resource.enabled) continue;
    const { skills } = loadSkills({
      cwd: input.root,
      agentDir: input.agentDir,
      skillPaths: [resource.path],
      includeDefaults: false,
    });
    for (const skill of skills) {
      push({
        kind: "skill",
        name: skill.name,
        invocation: `skill:${skill.name}`,
        ...(skill.description ? { description: skill.description } : {}),
      });
    }
  }
  for (const resource of resources.prompts) {
    if (!resource.enabled) continue;
    for (const filePath of promptTemplateFiles(resolve(input.root, resource.path))) {
      const template = readPromptTemplate(filePath);
      if (!template) continue;
      push({
        kind: "prompt",
        name: template.name,
        invocation: template.name,
        ...(template.description ? { description: template.description } : {}),
      });
    }
  }

  return { source: "static", commands: sortPromptCommands(commands) };
}
