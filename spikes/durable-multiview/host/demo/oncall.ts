// The on-call agent's own extension, selected by the main conversation and its forks, not by
// subagents. The subagent tool follows pi-durable's test/examples/22-subagent-foreground.ts (MIT).
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  type EntryId,
  type Extension,
  hook,
  section,
  type TaskId,
  type ToolExecutionApi,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ApprovalDecision } from "../../protocol/demo.ts";
import type { ApprovalBoard } from "./approvals.ts";
import { ApprovalsDoc, PlanDoc, RolloutDoc } from "./state.ts";
import { Reminder, Rollback, type RollbackReport } from "./tasks.ts";

export const ONCALL = "oncall";

export const AREAS = {
  logs: { tool: "search_logs", focus: "the production logs" },
  metrics: { tool: "query_metrics", focus: "the production metrics" },
  commits: { tool: "list_commits", focus: "the commits in the release" },
} as const;
type Area = keyof typeof AREAS;

const PLAYBOOK = `You are the on-call agent investigating the failed v2.3 release. Work in this order:
1. Call update_plan with three items: "Search the deploy logs", "Compare error metrics", "Review the commits in v2.3".
2. Call the subagent tool three times in one response, once per area (logs, metrics, commits), so the three run in parallel. Do not investigate yourself.
3. Call update_plan to mark the items done, then summarize the findings in a few sentences and end with a recommendation.
4. Only when the user asks for a rollback, call rollback. A human must approve it; if it is denied, say so and stop.
5. After any rollback attempt, whether it succeeded or failed, call schedule_check with seconds=60 to re-check the error rate, then report.
When a message starts with "Reminder:", re-check briefly (you may delegate to the metrics subagent) and report.`;

const childInstructions = (area: Area): string =>
  `You investigate ${AREAS[area].focus} for the failed v2.3 release. Call ${AREAS[area].tool} once, then report what matters in two sentences.`;

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  return message?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ?? "";
}

const updatePlan = defineTool({
  name: "update_plan",
  description: "Replace the investigation plan shown to everyone watching.",
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({ text: Type.String(), status: Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]) }),
    ),
  }),
  execute: async (args, api, context) => {
    // The plan changes in the same commit as anything else the call writes.
    await api.commit(async (tx) => {
      (await tx.doc(PlanDoc, api.conversationId)).items = args.items.map((item) => ({ ...item }));
    }, context);
    return { content: [{ type: "text", text: `Plan updated: ${args.items.length} items.` }] };
  },
});

const subagent = defineTool({
  name: "subagent",
  description: "Delegate one area of the investigation to a subagent and get its findings back. Call it once per area, in one response.",
  parameters: Type.Object({
    area: Type.Union([Type.Literal("logs"), Type.Literal("metrics"), Type.Literal("commits")]),
    task: Type.String({ description: "What the subagent should find out" }),
  }),
  // A rerun after a crash finds the child it created and the submission it made.
  replay: "safe",
  execute: async (args, api, context) => {
    const area = args.area as Area;
    const child = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      const tool = api.registry.tools().find((entry) => entry.tool.name === AREAS[area].tool)?.tool;
      if (tool === undefined) throw new Error(`No ${AREAS[area].tool} tool installed`);
      await configure(tx, created.id, {
        extensions: { remove: [api.registry.extension(ONCALL)!] },
        tools: [tool],
        instructions: childInstructions(area),
      });
      return created.id;
    }, context);
    await api.details({ conversationId: child }, context);
    const handle = (await api.conversation(child, context))!;
    const request = { type: "input", content: `${args.area}: ${args.task}`, requestId: `subagent:${api.taskId}` } as const;
    const settled = await (await handle.submit(request, context)).wait(context);
    if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
    return { content: [{ type: "text", text: await answerText(api, settled.answer, context) }], details: { conversationId: child } };
  },
});

function rollbackTool(stepMs: number) {
  return defineTool({
    name: "rollback",
    description: "Roll production back to an earlier version in every region. Needs a human approval.",
    parameters: Type.Object({ version: Type.String(), reason: Type.String() }),
    // A rerun after a crash waits for the rollback it started instead of starting another.
    replay: "safe",
    execute: async (args, api, context) => {
      const id = await api.commit(async (tx) => {
        const page = await tx.scanTasks({ conversationId: api.conversationId, kind: Rollback.definition.name }, 256);
        const existing = page.items.find((task) => task.owner === api.taskId);
        if (existing !== undefined) return existing.id as TaskId<RollbackReport>;
        return tx.createTask(Rollback, { version: args.version, stepMs }, { ownership: { kind: "task", taskId: api.taskId } });
      }, context);
      const settled = api.waitForTask(id, context);
      // Region progress, as the region tasks commit it, becomes the call's running output.
      let shown: Record<string, string> = {};
      let done = false;
      void settled.finally(() => (done = true)).catch(() => {});
      while (!done) {
        const regions = (await api.snapshot(RolloutDoc, api.conversationId, context))?.runs[String(id)] ?? {};
        for (const [region, status] of Object.entries(regions)) if (shown[region] !== status) api.output(`${region}: ${status}\n`);
        shown = { ...regions };
        await Promise.race([settled.catch(() => {}), sleep(Math.max(50, stepMs / 4))]);
      }
      const { state } = await settled;
      if (state.outcome.status !== "completed") throw new Error(`Rollback ${state.outcome.status}`);
      const report = state.outcome.result;
      const lines = report.regions.map((region) => `${region.region}: ${region.outcome}${region.error === undefined ? "" : ` (${region.error})`}`);
      const ok = report.regions.every((region) => region.outcome === "completed");
      return {
        content: [{ type: "text", text: `Rollback to ${report.version} ${ok ? "succeeded" : "failed; drained regions restored"}.\n${lines.join("\n")}` }],
        details: { rollbackTaskId: String(id) },
      };
    },
  });
}

const scheduleCheck = defineTool({
  name: "schedule_check",
  description: "Schedule a re-check that arrives as a message starting with \"Reminder:\" after the given delay, even if the run is stopped.",
  parameters: Type.Object({ seconds: Type.Number({ minimum: 1 }), note: Type.String() }),
  execute: async (args, api, context) => {
    // Background: Esc on this conversation aborts its ordinary work, not this.
    await api.createTask(
      Reminder,
      { until: Date.now() + args.seconds * 1000, note: args.note },
      { ownership: { kind: "conversation" }, background: true },
      context,
    );
    return { content: [{ type: "text", text: `Check scheduled in ${args.seconds}s: ${args.note}` }] };
  },
});

export function createOncall(options: { readonly approvals: ApprovalBoard; readonly stepMs: number }): Extension {
  return defineExtension({
    name: ONCALL,
    tools: [updatePlan, subagent, rollbackTool(options.stepMs), scheduleCheck],
    sections: [
      section("playbook", () => PLAYBOOK),
      section("plan", async (input, context) => {
        const plan = await input.read.snapshot(PlanDoc, input.conversationId, context);
        return plan === undefined || plan.items.length === 0 ? undefined : plan.items.map((item) => `- [${item.status}] ${item.text}`).join("\n");
      }),
    ],
    hooks: [
      hook(ToolTask, {
        // Hooks cannot sleep durably, so the decision is memoized: a rerun after a crash reads it instead of asking again.
        beforeTool: async (call, api, context) => {
          if (call.name !== "rollback") return undefined;
          const id = String(api.taskId);
          const known =
            (await api.memo<ApprovalDecision>("approval", context)) ??
            (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.decisions[id];
          const args = call.arguments as { version?: string; reason?: string };
          const decided =
            known ??
            (await options.approvals.wait(
              {
                id,
                conversationId: api.conversationId,
                tool: call.name,
                summary: `Roll back to ${args.version ?? "?"}: ${args.reason ?? ""}`,
                requestedAt: Date.now(),
              },
              context,
            ));
          const decision = await api.memo<ApprovalDecision>("approval", { ...decided }, context);
          return decision.approved ? undefined : { block: `Rollback denied by ${decision.by}.` };
        },
      }),
    ],
  });
}
