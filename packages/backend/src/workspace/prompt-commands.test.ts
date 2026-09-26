import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { sortPromptCommands } from "@pace/core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStaticPromptCommands } from "./prompt-commands";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pace-prompt-commands-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string, description: string) {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function listRelativePaths(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      paths.push(relative(dir, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return paths;
}

describe("resolveStaticPromptCommands", () => {
  it("lists user and project skills plus prompt templates with Pi invocations", async () => {
    const root = await tempDir();
    const agentDir = await tempDir();
    await writeSkill(join(agentDir, "skills"), "review-pr", "Review a pull request");
    await writeSkill(join(root, ".pi", "skills"), "lint-fix", "Fix lint errors");
    await mkdir(join(root, ".pi", "prompts"), { recursive: true });
    await writeFile(
      join(root, ".pi", "prompts", "fix.md"),
      "---\ndescription: Fix a failing test\n---\n\nFix the test.\n",
    );

    const catalog = await resolveStaticPromptCommands({ root, agentDir });

    // Pi also auto-discovers ~/.agents/skills, so assert membership and the
    // contract ordering rather than an exact environment-dependent list.
    expect(catalog.source).toBe("static");
    const byName = new Map(catalog.commands.map((command) => [command.name, command]));
    expect(byName.get("lint-fix")).toEqual({
      kind: "skill",
      name: "lint-fix",
      invocation: "skill:lint-fix",
      description: "Fix lint errors",
    });
    expect(byName.get("review-pr")).toEqual({
      kind: "skill",
      name: "review-pr",
      invocation: "skill:review-pr",
      description: "Review a pull request",
    });
    expect(catalog.commands.filter((command) => command.kind === "prompt")).toEqual([
      {
        kind: "prompt",
        name: "fix",
        invocation: "fix",
        description: "Fix a failing test",
      },
    ]);
    expect(catalog.commands).toEqual(sortPromptCommands(catalog.commands));
  });

  it("omits skills disabled in settings", async () => {
    const root = await tempDir();
    const agentDir = await tempDir();
    await writeSkill(join(root, ".pi", "skills"), "hidden-skill", "Stays disabled");
    await writeSkill(join(root, ".pi", "skills"), "shown-skill", "Stays enabled");
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ skills: ["!hidden-skill"] }),
    );

    const catalog = await resolveStaticPromptCommands({ root, agentDir });

    const byName = new Map(catalog.commands.map((command) => [command.name, command]));
    expect(byName.has("hidden-skill")).toBe(false);
    expect(byName.get("shown-skill")).toEqual({
      kind: "skill",
      name: "shown-skill",
      invocation: "skill:shown-skill",
      description: "Stays enabled",
    });
  });

  it("never evaluates extension code while resolving", async () => {
    const root = await tempDir();
    const agentDir = await tempDir();
    // An extension that detonates on load proves the static path never
    // executes extension modules.
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(root, ".pi", "extensions", "exploding.ts"),
      "throw new Error('extension executed');\n",
    );
    await writeSkill(join(root, ".pi", "skills"), "safe-skill", "Loads fine");

    const catalog = await resolveStaticPromptCommands({ root, agentDir });

    expect(catalog.source).toBe("static");
    expect(catalog.commands.some((command) => command.kind === "extension")).toBe(false);
    expect(catalog.commands.map((command) => command.name)).toContain("safe-skill");
  });

  it("produces the same skills and prompts as DefaultResourceLoader", async () => {
    const root = await tempDir();
    const agentDir = await tempDir();
    await writeSkill(join(agentDir, "skills"), "global-skill", "Global skill");
    // Same name in two scopes: whichever resolve() orders first must win in
    // both implementations.
    await writeSkill(join(agentDir, "skills"), "dup-skill", "Global duplicate");
    await writeSkill(join(root, ".pi", "skills"), "project-skill", "Project skill");
    await writeSkill(join(root, ".pi", "skills"), "dup-skill", "Project duplicate");
    await writeSkill(join(root, ".pi", "skills"), "disabled-skill", "Stays disabled");
    await mkdir(join(root, ".pi", "prompts"), { recursive: true });
    await writeFile(
      join(root, ".pi", "prompts", "front-desc.md"),
      "---\ndescription: From frontmatter\n---\n\nBody line that must not win.\n",
    );
    await writeFile(
      join(root, ".pi", "prompts", "first-line.md"),
      "Describe me from the body.\n\nMore body.\n",
    );
    await writeFile(
      join(root, ".pi", "prompts", "long-line.md"),
      `${"a".repeat(80)}\n`,
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ skills: ["!disabled-skill"] }),
    );

    const catalog = await resolveStaticPromptCommands({ root, agentDir });

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir),
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const toComparable = (commands: typeof catalog.commands) =>
      commands
        .map((command) => ({
          kind: command.kind,
          name: command.name,
          description: command.description,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expected = [
      ...loader.getSkills().skills.map((skill) => ({
        kind: "skill",
        name: skill.name,
        description: skill.description || undefined,
      })),
      ...loader.getPrompts().prompts.map((prompt) => ({
        kind: "prompt",
        name: prompt.name,
        description: prompt.description || undefined,
      })),
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(toComparable(catalog.commands)).toEqual(expected);
    // Guard the fixture itself: every scenario the drift check relies on is
    // actually present on the reference side.
    const expectedNames = new Set(expected.map((entry) => `${entry.kind}:${entry.name}`));
    for (const name of [
      "skill:global-skill",
      "skill:project-skill",
      "skill:dup-skill",
      "prompt:front-desc",
      "prompt:first-line",
      "prompt:long-line",
    ]) {
      expect(expectedNames).toContain(name);
    }
    expect(expectedNames.has("skill:disabled-skill")).toBe(false);
  });

  it("skips configured packages that are not installed instead of installing them", async () => {
    const root = await tempDir();
    const agentDir = await tempDir();
    // A package that can never resolve: resolution must skip it, not install.
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@pace-test/definitely-missing@1.0.0"] }),
    );
    await writeSkill(join(agentDir, "skills"), "still-listed", "Keeps working");

    const catalog = await resolveStaticPromptCommands({ root, agentDir });

    expect(catalog.source).toBe("static");
    expect(catalog.commands.map((command) => command.name)).toContain("still-listed");
    const written = [
      ...(await listRelativePaths(root)),
      ...(await listRelativePaths(agentDir)),
    ];
    expect(written.filter((path) => path.includes("definitely-missing"))).toEqual([]);
  });
});
