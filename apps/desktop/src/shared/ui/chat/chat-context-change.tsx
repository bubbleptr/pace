import type { ComponentProps } from "react";
import { ChatSystemMessage } from "@astryxdesign/core/Chat";

const TOOL_NAME_LIMIT = 4;
const MINUS = "\u2212";

export type ChatContextChangeProps = {
  sectionsChanged?: readonly string[];
  sectionsRemoved?: readonly string[];
  toolsAdded?: readonly string[];
  toolsRemoved?: readonly string[];
} & Omit<ComponentProps<typeof ChatSystemMessage>, "children" | "variant" | "icon">;

function formatSignedTools(names: readonly string[], sign: "+" | typeof MINUS) {
  if (names.length > TOOL_NAME_LIMIT) {
    return [`${sign}${names.length} tools`];
  }

  return names.map((name) => `${sign}${name}`);
}

function formatContextChangeNotice(input: {
  sectionsChanged: readonly string[];
  sectionsRemoved: readonly string[];
  toolsAdded: readonly string[];
  toolsRemoved: readonly string[];
}) {
  const fragments: string[] = [];
  const toolBits = [
    ...formatSignedTools(input.toolsAdded, "+"),
    ...formatSignedTools(input.toolsRemoved, MINUS),
  ];

  if (toolBits.length > 0) {
    fragments.push(`Tools changed: ${toolBits.join(", ")}`);
  }
  if (input.sectionsChanged.length > 0) {
    fragments.push(`Prompt updated: ${input.sectionsChanged.join(", ")}`);
  }
  if (input.sectionsRemoved.length > 0) {
    fragments.push(`Prompt section removed: ${input.sectionsRemoved.join(", ")}`);
  }

  return fragments.length > 0 ? fragments.join(" · ") : null;
}

export function ChatContextChange({
  sectionsChanged = [],
  sectionsRemoved = [],
  toolsAdded = [],
  toolsRemoved = [],
  ...rest
}: ChatContextChangeProps) {
  const text = formatContextChangeNotice({
    sectionsChanged,
    sectionsRemoved,
    toolsAdded,
    toolsRemoved,
  });

  if (!text) {
    return null;
  }

  return (
    <ChatSystemMessage variant="default" {...rest}>
      {text}
    </ChatSystemMessage>
  );
}
