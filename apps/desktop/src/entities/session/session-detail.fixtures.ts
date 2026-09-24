import type { SessionDetail, SessionTurn } from "@pace/core";

const largeOutputLine =
  "large fixture output line with enough text to resemble a verbose file read and tool result payload";
const largeOutput = Array.from({ length: 1400 }, (_, index) => `${index}: ${largeOutputLine}`).join(
  "\n",
);

function makeUsage(index: number) {
  return {
    inputTokens: 1200 + index,
    outputTokens: 2600 + index,
    cacheReadTokens: 300,
    cacheWriteTokens: 80,
    totalTokens: 4180 + index * 2,
  };
}

function makeCost(index: number) {
  return {
    inputUsd: 0.003,
    outputUsd: 0.012 + index / 100000,
    cacheReadUsd: 0.0001,
    cacheWriteUsd: 0.0004,
    totalUsd: 0.0155 + index / 100000,
  };
}

function makeTurn(index: number): SessionTurn {
  return {
    kind: "message",
    role: index % 2 === 0 ? "assistant" : "user",
    timestamp: `2026-01-05T15:${String(index % 60).padStart(2, "0")}:00.000Z`,
    model: "gpt-5-codex",
    usage: makeUsage(index),
    cost: makeCost(index),
    parts:
      index % 2 === 0
        ? [
            {
              partType: "thinking",
              text: [
                `Plan fixture turn ${index}`,
                "Inspect the current timeline state.",
                "Keep expensive output folded.",
                "Preserve cost and token context.",
                "Render only visible rows.",
                "Measure dynamic expanded rows.",
                `Hidden thinking line ${index}`,
              ].join("\n"),
              payload: {},
            },
            {
              partType: "toolCall",
              name: "read_file",
              payload: {
                input: {
                  path: `/tmp/fixture-${index}.txt`,
                  command: `cat /tmp/fixture-${index}.txt`,
                },
              },
            },
            {
              partType: "toolResult",
              name: "read_file",
              text: `huge output sentinel ${index}\n${largeOutput}`,
              isError: false,
              durationMs: 340 + index,
              payload: {},
            },
            {
              partType: "image",
              payload: {
                url: "data:image/png;base64,iVBORw0KGgo=",
                alt: `Fixture thumbnail ${index}`,
              },
            },
          ]
        : [
            {
              partType: "text",
              text: `User asks for fixture turn ${index}`,
              payload: {},
            },
          ],
  };
}

export function makeLargeSessionDetail(turnCount = 128): SessionDetail {
  const turns = Array.from({ length: turnCount }, (_, index) => makeTurn(index));

  return {
    id: "large-session-detail-fixture",
    timestamp: "2026-01-05T15:30:00.000Z",
    project: "fixture-project",
    totalCostUsd: turns.reduce((sum, turn) => sum + (turn.cost?.totalUsd ?? 0), 0),
    totalTokens: turns.reduce((sum, turn) => sum + (turn.usage?.totalTokens ?? 0), 0),
    primaryModel: "gpt-5-codex",
    turnCount: turns.length,
    durationSeconds: 840,
    turns,
  };
}

export const largeSessionDetailApproxBytes = largeOutput.length * 64;
