import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
