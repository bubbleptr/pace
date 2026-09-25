import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptCommand, PromptCommandCatalog } from "@pace/core";
import { sortPromptCommands } from "@pace/core";

export type ResolveStaticPromptCommandsInput = {
  root: string;
  agentDir: string;
};

/**
 * Resolve the "/" catalog from disk for drafts and cold sessions. Built the
 * same way as session-process-entry so the static list matches what the live
 * runtime reports, except extensions: `noExtensions` keeps their code from
 * executing, so extension commands only exist on the runtime path.
 */
export async function resolveStaticPromptCommands(
  input: ResolveStaticPromptCommandsInput,
): Promise<PromptCommandCatalog> {
  const settingsManager = SettingsManager.create(input.root, input.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: input.root,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const commands: PromptCommand[] = [];
  for (const skill of loader.getSkills?.().skills ?? []) {
    commands.push({
      kind: "skill",
      name: skill.name,
      invocation: `skill:${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
    });
  }
  for (const template of loader.getPrompts?.().prompts ?? []) {
    commands.push({
      kind: "prompt",
      name: template.name,
      invocation: template.name,
      ...(template.description ? { description: template.description } : {}),
    });
  }

  return { source: "static", commands: sortPromptCommands(commands) };
}
