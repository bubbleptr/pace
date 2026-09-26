import { createElement, type ComponentProps, type ComponentType } from "react";
import type {
  ChatComposerToken,
  ChatComposerTrigger,
  ChatComposerTriggerItem,
} from "@astryxdesign/core/Chat";
import type { BadgeVariant } from "@astryxdesign/core/Badge";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  PI_TUI_BUILTIN_COMMANDS,
  type PromptCommand,
  type PromptCommandKind,
} from "@pace/core";
import { Command, Puzzle, Sparkles } from "@/shared/ui/icons";
import type { ComposerInsertCatalog } from "@/shared/ui/composer-attachments/composer-insert-menu";

// skill → prompt → extension, matching the contract's catalog ordering, so a
// same-invocation collision resolves the same way the catalog is sorted.
const KIND_ORDER: Record<PromptCommandKind, number> = {
  skill: 0,
  prompt: 1,
  extension: 2,
};

const KIND_ICON: Record<
  PromptCommandKind,
  ComponentType<ComponentProps<typeof Sparkles>>
> = {
  skill: Sparkles,
  prompt: Command,
  extension: Puzzle,
};

const KIND_VARIANT: Record<PromptCommandKind, BadgeVariant> = {
  skill: "purple",
  prompt: "teal",
  extension: "blue",
};

/**
 * The chip written into the composer for a catalog command. `value` is the
 * serialized form Pi parses — "/skill:<name>" for skills, "/<invocation>"
 * for prompt templates and extension commands.
 */
export function commandToken(command: PromptCommand): ChatComposerToken {
  return {
    value: `/${command.invocation}`,
    label: command.kind === "skill" ? command.name : `/${command.name}`,
    variant: KIND_VARIANT[command.kind],
    icon: createElement(KIND_ICON[command.kind], { size: 16, "aria-hidden": true }),
  };
}

export type LeadingCommandMatch = {
  /** Characters of plain text the token replaces, including a trailing space or NBSP (never a newline). */
  length: number;
  token: ChatComposerToken;
};

/**
 * Recognize a leading "/<invocation>" in a serialized value — used to turn
 * typed or restored plain text back into a token. A match requires a word
 * boundary: end, space, NBSP, or newline ("/review" must not match
 * "/reviewer"). The returned length swallows one trailing space/NBSP so a
 * reinserted token's own NBSP doesn't create a double gap; a newline stays.
 */
export function leadingCommandMatch(
  value: string,
  commands: readonly PromptCommand[],
): LeadingCommandMatch | null {
  if (!value.startsWith("/")) {
    return null;
  }

  const ordered = [...commands].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  for (const command of ordered) {
    const head = `/${command.invocation}`;
    if (!value.startsWith(head)) {
      continue;
    }

    const next = value[head.length];
    if (next === undefined || next === "\n") {
      return { length: head.length, token: commandToken(command) };
    }
    if (next === " " || next === "\u00A0") {
      return { length: head.length + 1, token: commandToken(command) };
    }
  }

  return null;
}

/**
 * Gate for handing the "/" trigger to the input. Astryx reads the trigger
 * list captured by the *previous* render's input event, so this predicate
 * runs on the last committed value: the trigger exists only while the whole
 * input is a bare "/query". Once a command token sits at the front its
 * serialized NBSP fails the pattern, and a "/" mid-sentence ("hello /")
 * never sees the trigger either.
 */
export function slashTriggerActive(previousValue: string) {
  return previousValue === "" || /^\/\S*$/.test(previousValue);
}

/**
 * The "/" autocomplete for the composer, backed by the Pi prompt-command
 * catalog. In queue mode extension commands are hidden (Pi refuses to queue
 * them); a pre-existing extension token is still blocked at submit instead.
 */
export function slashTrigger(
  commands: readonly PromptCommand[],
  { active, queueMode }: { active: boolean; queueMode: boolean },
): ChatComposerTrigger | null {
  if (!active) {
    return null;
  }

  const listed = queueMode
    ? commands.filter((command) => command.kind !== "extension")
    : [...commands];

  return {
    character: "/",
    searchSource: createStaticSource(
      listed.map((command) => ({
        id: `${command.kind}/${command.name}`,
        // The label is the serialized invocation — skills really do run as
        // "/skill:<name>", so showing "/review-pr" would lie about the
        // command line the user is building.
        label: `/${command.invocation}`,
        auxiliaryData: { command, description: command.description },
      })),
      {
        keywords: (item) => [
          item.auxiliaryData.command.name,
          item.auxiliaryData.command.invocation,
          item.auxiliaryData.description ?? "",
        ],
      },
    ),
    emptySearchResultsText: "No matching commands",
    renderItem: (item: ChatComposerTriggerItem) => {
      const data = item.auxiliaryData as
        | { command: PromptCommand; description?: string }
        | undefined;
      const Icon = data ? KIND_ICON[data.command.kind] : Command;
      return (
        <VStack gap={0.5} style={{ minWidth: 0, width: "100%" }}>
          <HStack align="center" gap={1.5}>
            {createElement(Icon, { size: 16, "aria-hidden": true, style: { flexShrink: 0 } })}
            <Text maxLines={1}>{item.label}</Text>
          </HStack>
          {data?.description ? (
            <Text color="secondary" maxLines={2} size="sm" type="body">
              {data.description}
            </Text>
          ) : null}
        </VStack>
      );
    },
    onSelect: (item) => {
      const data = item.auxiliaryData as { command: PromptCommand } | undefined;
      return data ? commandToken(data.command) : `/${item.label}`;
    },
  };
}

/** Catalog id → command kind, shared by the + menu's onPick lookup. */
export const INSERT_CATALOG_KIND: Record<string, PromptCommandKind> = {
  skills: "skill",
  prompts: "prompt",
  commands: "extension",
};

/**
 * The + menu's groups: Skills, Prompts, Commands (extensions). Queue mode
 * drops Commands entirely — Pi cannot queue extension commands.
 */
export function insertCatalogs(
  commands: readonly PromptCommand[],
  { queueMode }: { queueMode: boolean },
): ComposerInsertCatalog[] {
  const group = (kind: PromptCommandKind) =>
    commands
      .filter((command) => command.kind === kind)
      .map((command) => ({
        id: command.invocation,
        label: command.kind === "skill" ? command.name : `/${command.name}`,
        description: command.description,
      }));

  return [
    {
      id: "skills",
      label: "Skills",
      icon: createElement(Sparkles, { "aria-hidden": true }),
      searchLabel: "Search skills",
      emptyText: "No matching skills",
      items: group("skill"),
    },
    {
      id: "prompts",
      label: "Prompts",
      icon: createElement(Command, { "aria-hidden": true }),
      searchLabel: "Search prompts",
      emptyText: "No matching prompts",
      items: group("prompt"),
    },
    ...(queueMode
      ? []
      : ([
          {
            id: "commands",
            label: "Commands",
            icon: createElement(Puzzle, { "aria-hidden": true }),
            searchLabel: "Search commands",
            emptyText: "No matching commands",
            items: group("extension"),
          },
        ] satisfies ComposerInsertCatalog[])),
  ];
}

/**
 * Submit-time guard for slash commands. Returns an error message or null:
 * - "/<name>" matching a catalog extension command can't be queued;
 * - "/<name>" the catalog doesn't know but Pi's TUI owns is blocked —
 *   Pace never executes TUI commands;
 * - a catalog command with the same name takes precedence over the TUI list.
 */
export function validateCommandSubmit(
  value: string,
  { commands, queueMode }: { commands: readonly PromptCommand[]; queueMode: boolean },
): string | null {
  // Tokens serialize with a trailing NBSP; normalize before word-splitting
  // so a tokenized "/compact␣args" still reads as a command line.
  const normalized = value.replace(/\u00A0/g, " ").trimStart();
  const firstWord = normalized.split(/[ \n]/, 1)[0] ?? "";
  if (!firstWord.startsWith("/") || firstWord === "/") {
    return null;
  }

  const name = firstWord.slice(1);
  const match = [...commands]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .find((command) => command.invocation === name);

  if (match) {
    if (match.kind === "extension" && queueMode) {
      return "Extension commands can't be queued. Send it when Pi is idle.";
    }
    return null;
  }

  if (PI_TUI_BUILTIN_COMMANDS.includes(name)) {
    return `\`/${name}\` is a Pi terminal command; Pace doesn't run it.`;
  }

  return null;
}
