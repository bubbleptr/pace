import { Fragment } from "react";
import {
  ChatTokenizedText,
  type ChatComposerToken,
} from "@astryxdesign/core/Chat";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Text } from "@astryxdesign/core/Text";
import { AUTOCOMPLETE_SEPARATOR_REGEX, type PromptCommand } from "@pace/core";
import { leadingCommandMatch } from "@/entities/prompt-command";
import { fileToken } from "@/entities/workspace-file";

type PromptPart = { text: string; token?: ChatComposerToken };

// Astryx 0.3.0 treats token values as regex patterns without reliably escaping
// route filenames such as [id].tsx. Each segment is already matched here, so
// a regex-safe placeholder lets Astryx render the original token's chrome.
const TOKEN_PLACEHOLDER = "\uFFFC";

function promptParts(text: string, commands: readonly PromptCommand[]): PromptPart[] {
  // Match Pi's complete skill envelope; ordinary prose mentioning a tag is
  // still user content, and the persisted message must remain untouched.
  const skill = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (skill) {
    const name = skill[1]!;
    const args = skill[2]?.trim();
    text = `/skill:${name}${args ? ` ${args}` : ""}`;
    commands = [{ kind: "skill", name, invocation: `skill:${name}` }, ...commands];
  }

  const parts: PromptPart[] = [];
  const command = leadingCommandMatch(text, commands);
  let cursor = 0;
  if (command) {
    parts.push({ text: command.token.value, token: command.token });
    cursor = command.token.value.length;
  }

  const references = new RegExp(
    `(?:^|\\s)@(?:"([^"]+)"|((?:(?!${AUTOCOMPLETE_SEPARATOR_REGEX.source})[^"])+))`,
    "gu",
  );
  const fileTextOffset = cursor;
  for (const match of text.slice(fileTextOffset).matchAll(references)) {
    const start = fileTextOffset + match.index + match[0].indexOf("@");
    const value = match[0].slice(match[0].indexOf("@"));
    const path = match[1] ?? match[2]!;
    const directory = path.endsWith("/");
    const token = fileToken({
      path: directory ? path.slice(0, -1) : path,
      kind: directory ? "directory" : "file",
    });
    parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: value, token });
    cursor = start + value.length;
  }
  parts.push({ text: text.slice(cursor) });
  return parts;
}

export function UserPromptContent({
  text,
  commands = [],
}: {
  text: string;
  commands?: readonly PromptCommand[];
}) {
  // The bubble stacks direct children vertically; one text container keeps
  // token spans in the same line flow as the surrounding prose.
  return (
    <Text style={{ whiteSpace: "pre-wrap" }}>
      {promptParts(text, commands).map((part, index) => (
        <Fragment key={index}>
          {part.token ? (
            <Tooltip content={part.text} hasHoverIndication={false}>
              <ChatTokenizedText tokens={[{ ...part.token, value: TOKEN_PLACEHOLDER }]}>
                {TOKEN_PLACEHOLDER}
              </ChatTokenizedText>
            </Tooltip>
          ) : part.text}
        </Fragment>
      ))}
    </Text>
  );
}
