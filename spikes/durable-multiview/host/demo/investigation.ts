// The investigation tools, loaded by path so the host can reinstall them while it runs
// (`Demo.reload()`): edit FORMAT below and the next call prints the other way. Imports
// packages only, so a copy of this file anywhere in the spike loads the same.
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";

const FORMAT = "plain" as "plain" | "table";

type Row = readonly [string, string, string];

const LOGS: readonly Row[] = [
  ["09:12:41", "deploy", "v2.3.0 rolled out to us-east, eu-west, ap-south"],
  ["09:14:03", "eu-west", "ERROR api: connection pool exhausted (max=20, waiting=183)"],
  ["09:14:05", "eu-west", "ERROR checkout: upstream timeout after 30s"],
  ["09:14:20", "us-east", "WARN api: pool wait p99 2.1s"],
  ["09:15:02", "deploy", "health check failed, release v2.3.0 marked FAILED"],
];

const METRICS: readonly Row[] = [
  ["error rate", "0.2% -> 14.8%", "since 09:14 in eu-west"],
  ["db connections", "20/20", "saturated in every region"],
  ["p99 latency", "180ms -> 30s", "checkout path"],
  ["cpu", "41%", "unchanged"],
];

const COMMITS: readonly Row[] = [
  ["a1b2c3d", "deps", "bump pg driver 8.11 -> 9.0 (pool default 100 -> 20)"],
  ["e4f5a6b", "checkout", "retry upstream calls 3x"],
  ["c7d8e9f", "docs", "update release notes"],
];

function render(header: Row, rows: readonly Row[]): string[] {
  if (FORMAT === "table") return [`| ${header.join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
  return rows.map((row) => row.join("  "));
}

/** Streams the rows one by one, so a crash or a reload can land mid-call. */
async function stream(api: ToolExecutionApi, lines: readonly string[], paceMs: number, context: Context): Promise<void> {
  for (const line of lines) {
    await sleep(paceMs, undefined, context.abortSignal === undefined ? {} : { signal: context.abortSignal });
    api.output(`${line}\n`);
  }
}

export function createInvestigation(options: { readonly paceMs: number }): Extension {
  const tool = (name: string, description: string, header: Row, rows: readonly Row[]) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({ query: Type.String({ description: "What to look for" }) }),
      // Read-only, so a rerun after a crash just reads again.
      replay: "safe",
      execute: async (_args, api, context) => {
        await stream(api, render(header, rows), options.paceMs, context);
        return {};
      },
    });
  return defineExtension({
    name: "investigation",
    tools: [
      tool("search_logs", "Search the production logs of the v2.3 release.", ["time", "source", "message"], LOGS),
      tool("query_metrics", "Query production metrics around the v2.3 release.", ["metric", "change", "where"], METRICS),
      tool("list_commits", "List the commits that went into v2.3.", ["sha", "area", "message"], COMMITS),
    ],
  });
}
