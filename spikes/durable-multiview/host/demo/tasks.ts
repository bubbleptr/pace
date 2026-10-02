import { type ConversationId, defineExtension, defineTask, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { RolloutDoc } from "./state.ts";

/** The region whose health check always fails, so every rollback shows failFast and compensation. */
export const FAILING_REGION = "eu-west";
export const REGIONS = ["us-east", FAILING_REGION, "ap-south"] as const;

async function setRegion(tx: Tx, conversationId: ConversationId, rollout: string, region: string, status: string): Promise<void> {
  const doc = await tx.doc(RolloutDoc, conversationId);
  doc.runs[rollout] = { ...doc.runs[rollout], [region]: status };
}

type RegionInput = { rollout: string; region: string; version: string; stepMs: number };
type RegionState = { phase: "drain" } | { phase: "verify"; until: number } | { phase: "finish"; until: number };

/** Drain, health-check, and switch one region. Aborted, it restores the traffic it drained. */
export const RegionRollback = defineTask<RegionInput, RegionState, { region: string }>({
  name: "demo.region-rollback",
  version: 1,
  initial: () => ({ phase: "drain" }),
  phases: {
    drain: async (task, runtime, context) => {
      const { rollout, region, stepMs } = task.input;
      // The failing check takes longer, so its siblings are mid-switch when it fails.
      const until = runtime.now() + (region === FAILING_REGION ? stepMs * 1.5 : stepMs);
      await runtime.commit(async (tx) => {
        await setRegion(tx, task.conversationId, rollout, region, "draining");
        return { status: "running", checkpoint: { phase: "verify", until } };
      }, context);
    },
    verify: async (task, runtime, context) => {
      const { rollout, region, version, stepMs } = task.input;
      await runtime.sleep(task.state.checkpoint.until, context);
      if (region === FAILING_REGION) {
        await runtime.commit(async (tx) => {
          await setRegion(tx, task.conversationId, rollout, region, "failed: health check");
          return { status: "terminal", outcome: { status: "failed", error: { message: `${region}: health check failed on ${version}` } } };
        }, context);
        return;
      }
      await runtime.commit(async (tx) => {
        await setRegion(tx, task.conversationId, rollout, region, `switching to ${version}`);
        return { status: "running", checkpoint: { phase: "finish", until: runtime.now() + stepMs * 2 } };
      }, context);
    },
    finish: async (task, runtime, context) => {
      const { rollout, region, version } = task.input;
      await runtime.sleep(task.state.checkpoint.until, context);
      await runtime.commit(async (tx) => {
        await setRegion(tx, task.conversationId, rollout, region, `rolled back to ${version}`);
        return { status: "terminal", outcome: { status: "completed", result: { region } } };
      }, context);
    },
  },
  // Runs once the region's own work is done; the compensation is this region's to undo.
  abort: async (task, runtime, context) => {
    const { rollout, region, stepMs } = task.input;
    await runtime.commit(async (tx) => {
      await setRegion(tx, task.conversationId, rollout, region, "compensating: restoring traffic");
      return undefined;
    }, context);
    await runtime.sleep(runtime.now() + stepMs, context);
    await runtime.commit(async (tx) => {
      await setRegion(tx, task.conversationId, rollout, region, "compensated: traffic restored");
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

export type RollbackReport = { version: string; regions: { region: string; outcome: string; error?: string }[] };
type RollbackState = { phase: "start" } | { phase: "report"; regions: TaskId<{ region: string }>[] };

/** Rolls every region back in parallel; the first failed region aborts the others. */
export const Rollback = defineTask<{ version: string; stepMs: number }, RollbackState, RollbackReport>({
  name: "demo.rollback",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const regions: TaskId<{ region: string }>[] = [];
        for (const region of REGIONS) {
          const input = { rollout: String(task.id), region, version: task.input.version, stepMs: task.input.stepMs };
          regions.push(await tx.createTask(RegionRollback, input, { ownership: { kind: "task", taskId: task.id } }));
        }
        return { status: "waiting", checkpoint: { phase: "report", regions }, on: regions, policy: "failFast" };
      }, context);
    },
    report: async (task, runtime, context) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.regions, context);
      const regions = outcomes.map((outcome, index) => ({
        region: REGIONS[index]!,
        outcome: outcome.status,
        ...(outcome.status === "failed" ? { error: outcome.error.message } : {}),
      }));
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { version: task.input.version, regions } } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

type ReminderInput = { until: number; note: string };

/**
 * A background check: Esc on its conversation does not reach it. It sleeps to an absolute time
 * kept in its input, so a restart neither loses nor restarts the wait.
 */
export const Reminder = defineTask<ReminderInput, { phase: "wait" }, null>({
  name: "demo.reminder",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleep(task.input.until, context);
      const conversation = (await runtime.conversation(task.conversationId, context))!;
      // The request ID makes a rerun after a crash find the follow-up it already posted.
      await conversation.submit(
        { type: "input", content: `Reminder: ${task.input.note}`, whenBusy: "followUp", requestId: `reminder:${task.id}` },
        context,
      );
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** Task code is looked up by name in the registry, whichever conversation selects what. */
export const DemoTasks = defineExtension({ name: "demo-tasks", tasks: [RegionRollback, Rollback, Reminder] });
