import { describe, expect, it } from "vitest";
import type {
  AgentMessagePartSnapshot,
  AgentMessagePartType,
  AgentRunOutcome,
  AgentRuntimeEvent,
  AgentStatusCode,
} from "@pace/core";
import {
  applyAgentRuntimeEvent,
  createSessionRuntimeModel,
  type SessionRuntimeModel,
} from "./session-runtime-model";
import { deriveCotView, type CotPhase, type CotView } from "./cot-view";

// The six ADR-0020 fixture flows (plain text, thinking + text, tool chain,
// multi-turn, retry, abort) driven through the real reducer, asserting the
// ADR-0030 phase sequence, the single clock anchor and the step split at
// every beat.

const runId = "pi-session-1:run-1";
const T0 = Date.parse("2026-09-04T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Beat = { ms: number; event: AgentRuntimeEvent };

const runStart = (ms: number): Beat => ({
  ms,
  event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
});

const runEnd = (ms: number, outcome: AgentRunOutcome = "completed"): Beat => ({
  ms,
  event: { type: "run", runId, phase: "end", trigger: "prompt", outcome, surface: "hidden", origin: "sdk" },
});

const statusBeat = (ms: number, code: AgentStatusCode): Beat => ({
  ms,
  event: { type: "status", runId, code, surface: "trace", origin: "sdk" },
});

const toolStart = (ms: number, toolCallId: string, name: string): Beat => ({
  ms,
  event: {
    type: "tool",
    runId,
    turnId: `${runId}:turn-1`,
    toolCallId,
    phase: "start",
    name,
    surface: "trace",
    origin: "sdk",
  },
});

const toolEnd = (
  ms: number,
  toolCallId: string,
  name: string,
  result: unknown,
  isError = false,
): Beat => ({
  ms,
  event: {
    type: "tool",
    runId,
    turnId: `${runId}:turn-1`,
    toolCallId,
    phase: "end",
    name,
    result,
    isError,
    surface: "trace",
    origin: "sdk",
  },
});

/** One assistant Message and its Parts, addressed the way the normalizer mints ids. */
function message(turn: number, index = 1) {
  const turnId = `${runId}:turn-${turn}`;
  const messageId = `${turnId}:msg-${index}`;
  const base = { runId, turnId, messageId, role: "assistant" } as const;

  return {
    id: messageId,
    start: (ms: number): Beat => ({
      ms,
      event: { type: "message", ...base, phase: "start", surface: "chat", origin: "sdk" },
    }),
    end: (
      ms: number,
      parts: AgentMessagePartSnapshot[],
      options: { abandoned?: boolean } = {},
    ): Beat => ({
      ms,
      event: {
        type: "message",
        ...base,
        phase: "end",
        parts,
        ...(options.abandoned ? { abandoned: true } : {}),
        surface: "chat",
        origin: "sdk",
      },
    }),
    part: (slot: number, partType: AgentMessagePartType) => {
      const partId = `${messageId}:part-${slot}`;
      const surface = partType === "text" ? ("chat" as const) : ("trace" as const);
      const partBase = { type: "message_part", ...base, partId, partType, surface } as const;

      return {
        id: partId,
        start: (ms: number, toolName?: string): Beat => ({
          ms,
          event: {
            ...partBase,
            phase: "start",
            bodyMode: "snapshot",
            body: "",
            ...(toolName ? { toolName } : {}),
            origin: "sdk",
          },
        }),
        delta: (ms: number, body: string): Beat => ({
          ms,
          event: { ...partBase, phase: "update", bodyMode: "delta", body, origin: "sdk" },
        }),
        end: (ms: number, body: string, toolCallId?: string): Beat => ({
          ms,
          event: {
            ...partBase,
            phase: "end",
            bodyMode: "snapshot",
            body,
            ...(toolCallId ? { toolCallId } : {}),
            origin: "sdk",
          },
        }),
        snapshot: (body: string, toolCallId?: string): AgentMessagePartSnapshot => ({
          partId,
          partType,
          body,
          ...(toolCallId ? { toolCallId } : {}),
        }),
      };
    },
  };
}

type Replay = {
  model: SessionRuntimeModel;
  /** Phase sequence with repeats collapsed — the state machine's trace. */
  phases: CotPhase[];
  final: CotView;
  viewAt: (ms: number) => CotView;
};

function replay(
  beats: Beat[],
  options: { streamingAllowed?: boolean; nowMs?: number } = {},
): Replay {
  let model = createSessionRuntimeModel();
  const views = new Map<number, CotView>();
  const phases: CotPhase[] = [];
  let last: CotView | undefined;

  beats.forEach((beat, index) => {
    model = applyAgentRuntimeEvent(model, {
      event: beat.event,
      seq: index + 1,
      timestamp: at(beat.ms),
    });

    const view = deriveCotView(model, runId, {
      streamingAllowed: options.streamingAllowed ?? true,
      nowMs: options.nowMs ?? T0 + beat.ms,
    });

    views.set(beat.ms, view);
    if (view.phase !== phases[phases.length - 1]) {
      phases.push(view.phase);
    }
    last = view;
  });

  if (!last) {
    throw new Error("replay needs at least one beat");
  }

  return {
    model,
    phases,
    final: last,
    viewAt: (ms) => {
      const view = views.get(ms);
      if (!view) {
        throw new Error(`no view recorded at ${ms}ms`);
      }
      return view;
    },
  };
}

describe("CoT view derivation", () => {
  it("attaches Nested Tool Executions to their parent call and unwraps codemode's script args", () => {
    const m1 = message(1);
    const m2 = message(2);
    const call = m1.part(0, "tool_call");
    const answer = m2.part(0, "text");

    // Nested executions arrive as tool events with parentToolCallId and no
    // tool_call part — the model never issued them.
    const nested = (
      ms: number,
      phase: "start" | "end",
      event: Partial<Extract<AgentRuntimeEvent, { type: "tool" }>> & { toolCallId: string; name: string },
    ): Beat => ({
      ms,
      event: {
        type: "tool",
        runId,
        turnId: `${runId}:turn-1`,
        phase,
        surface: "trace",
        origin: "sdk",
        ...event,
      } as AgentRuntimeEvent,
    });

    const { final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      call.start(200),
      call.end(300, '{"code":"return 1"}', "call-1"),
      m1.end(400, [call.snapshot('{"code":"return 1"}', "call-1")]),
      toolStart(500, "call-1", "codemode"),
      nested(600, "start", {
        toolCallId: "call-1/1",
        parentToolCallId: "call-1",
        name: "mcp__probe__echo",
        args: { text: "hi" },
      }),
      nested(700, "start", {
        toolCallId: "call-1/2",
        parentToolCallId: "call-1",
        name: "bash",
        args: { command: "exit 1" },
      }),
      nested(800, "end", {
        toolCallId: "call-1/1",
        parentToolCallId: "call-1",
        name: "mcp__probe__echo",
        result: { content: [{ type: "text", text: "ECHO:hi" }] },
        isError: false,
      }),
      nested(900, "end", {
        toolCallId: "call-1/2",
        parentToolCallId: "call-1",
        name: "bash",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      }),
      toolEnd(1000, "call-1", "codemode", { content: [{ type: "text", text: "1" }] }),
      m2.start(1100),
      answer.start(1200),
      answer.end(1300, "Done."),
      m2.end(1400, [answer.snapshot("Done.")]),
      runEnd(1500),
    ]);

    // While the parent runs, a started-but-unfinished nested execution is
    // input-available — it has args but no result yet.
    const liveStep = viewAt(700).steps.find((step) => step.kind === "tools");
    const liveChildren =
      liveStep?.kind === "tools" ? liveStep.tools[0].children : undefined;
    expect(liveChildren?.[0]).toMatchObject({
      toolCallId: "call-1/1",
      toolName: "mcp__probe__echo",
      state: "input-available",
      argsText: '{"text":"hi"}',
    });

    const steps = final.steps;
    const toolsSteps = steps.filter((step) => step.kind === "tools");
    expect(toolsSteps).toHaveLength(1);
    const toolsStep = toolsSteps[0] as Extract<(typeof steps)[number], { kind: "tools" }>;
    expect(toolsStep.tools).toHaveLength(1);

    const [codemode] = toolsStep.tools;
    // The detail pane shows the script, not the escaped JSON envelope.
    expect(codemode.argsText).toBe("return 1");
    expect(codemode.children?.map((child) => child.toolCallId)).toEqual([
      "call-1/1",
      "call-1/2",
    ]);
    expect(codemode.children?.[0]).toMatchObject({
      toolName: "mcp__probe__echo",
      state: "output-available",
      argsText: '{"text":"hi"}',
      output: JSON.stringify({ content: [{ type: "text", text: "ECHO:hi" }] }),
      durationMs: 200,
    });
    expect(codemode.children?.[1]).toMatchObject({
      toolName: "bash",
      state: "output-error",
      argsText: '{"command":"exit 1"}',
      output: JSON.stringify({ content: [{ type: "text", text: "boom" }] }),
      durationMs: 200,
    });
  });

  it("preserves a failed run outcome for the settled header", () => {
    let model = createSessionRuntimeModel();
    for (const [index, beat] of [runStart(0), runEnd(1400, "failed")].entries()) {
      model = applyAgentRuntimeEvent(model, { seq: index + 1, timestamp: at(beat.ms), event: beat.event });
    }
    expect(deriveCotView(model, runId, { streamingAllowed: false })).toMatchObject({ outcome: "failed" });
  });

  it("runs a text-only turn hidden → thinking → answering → settled and freezes the clock at the first answer token", () => {
    const m1 = message(1);
    const answer = m1.part(0, "text");

    const { phases, final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      answer.start(200),
      answer.delta(300, "Hello"),
      answer.end(400, "Hello"),
      m1.end(500, [answer.snapshot("Hello")]),
      runEnd(600),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "answering", "settled"]);

    // Live and settled read the same anchor → first answer token span, so the
    // number cannot jump when the run ends.
    expect(viewAt(300)).toMatchObject({
      elapsedMs: 100,
      answer: { text: "Hello", streaming: true },
    });
    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 100,
      steps: [],
      answer: { text: "Hello", streaming: false },
    });
  });

  it("keeps a thinking part as its own step and runs the clock only while it is live", () => {
    const m1 = message(1);
    const thought = m1.part(0, "thinking");
    const answer = m1.part(1, "text");

    const { phases, final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      thought.start(200),
      thought.delta(400, "Reading the repo."),
      thought.end(1200, "Reading the repo."),
      answer.start(1500),
      answer.end(1800, "Found it."),
      m1.end(1900, [thought.snapshot("Reading the repo."), answer.snapshot("Found it.")]),
      runEnd(2000),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "answering", "settled"]);

    expect(viewAt(400)).toMatchObject({
      phase: "thinking",
      elapsedMs: 300,
      steps: [{ kind: "thinking", id: thought.id, text: "Reading the repo.", live: true, durationMs: 200 }],
    });

    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 1400,
      steps: [{ kind: "thinking", text: "Reading the repo.", live: false, durationMs: 1000 }],
      answer: { text: "Found it.", streaming: false },
    });
  });

  it("reclassifies a presumed answer as Interim Output the moment a tool_call opens in the same Message", () => {
    const m1 = message(1);
    const m2 = message(2);
    const interim = m1.part(0, "text");
    const call = m1.part(1, "tool_call");
    const answer = m2.part(0, "text");
    const args = '{"path":"a.ts"}';

    const { phases, final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      interim.start(200),
      interim.delta(300, "Looking into it"),
      interim.end(400, "Looking into it"),
      call.start(500),
      call.end(700, args, "call-1"),
      m1.end(800, [interim.snapshot("Looking into it"), call.snapshot(args, "call-1")]),
      toolStart(900, "call-1", "read_file"),
      toolEnd(1500, "call-1", "read_file", "export const a = 1;"),
      m2.start(1600),
      answer.start(1700),
      answer.end(1900, "Done."),
      m2.end(2000, [answer.snapshot("Done.")]),
      runEnd(2100),
    ]);

    // answering → acting is the legitimate walk-back: the text was presumed
    // final, the tool_call proves it was not.
    expect(phases).toEqual([
      "hidden",
      "thinking",
      "answering",
      "acting",
      "thinking",
      "answering",
      "settled",
    ]);

    expect(viewAt(300).answer).toEqual({ text: "Looking into it", streaming: true });

    // Reclassified at part(start), not at message(end): the bubble is gone and
    // the text is a step in the same beat the tool_call opens.
    expect(viewAt(500).answer).toBeUndefined();
    expect(viewAt(500).steps[0]).toEqual({
      kind: "interim",
      id: interim.id,
      text: "Looking into it",
    });

    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 1600,
      answer: { text: "Done.", streaming: false },
    });
    expect(final.steps).toEqual([
      { kind: "interim", id: interim.id, text: "Looking into it" },
      {
        kind: "tools",
        id: `${m1.id}-tools-1`,
        live: false,
        tools: [
          {
            toolCallId: "call-1",
            toolName: "read_file",
            state: "output-available",
            argsText: args,
            output: "export const a = 1;",
            durationMs: 600,
          },
        ],
      },
    ]);
  });

  it("folds a burst of tool calls into one step and points at the first call that has not executed", () => {
    const m1 = message(1);
    const m2 = message(2);
    const thought = m1.part(0, "thinking");
    const callA = m1.part(1, "tool_call");
    const callB = m1.part(2, "tool_call");
    const answer = m2.part(0, "text");
    const argsA = '{"path":"a.ts"}';
    const argsB = '{"path":"b.ts"}';

    const { phases, final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      thought.start(150),
      thought.end(400, "Two files to read."),
      callA.start(500),
      callA.end(600, argsA, "call-1"),
      callB.start(650),
      callB.end(700, argsB, "call-2"),
      m1.end(750, [
        thought.snapshot("Two files to read."),
        callA.snapshot(argsA, "call-1"),
        callB.snapshot(argsB, "call-2"),
      ]),
      toolStart(800, "call-1", "read_file"),
      toolEnd(1200, "call-1", "read_file", "export const a = 1;"),
      toolStart(1250, "call-2", "read_file"),
      toolEnd(1400, "call-2", "read_file", "export const b = 2;"),
      m2.start(1500),
      answer.start(1600),
      answer.end(1800, "Both read."),
      m2.end(1900, [answer.snapshot("Both read.")]),
      runEnd(2000),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "acting", "thinking", "answering", "settled"]);

    // Pi executes in order, so the active call is the first unexecuted one —
    // it moves on as each execution lands, not when a new part arrives.
    expect(viewAt(800).steps[1]).toMatchObject({ kind: "tools", live: true, activeToolCallId: "call-1" });
    expect(viewAt(1250).steps[1]).toMatchObject({ kind: "tools", live: true, activeToolCallId: "call-2" });

    // The group settles on execution, not on losing the last-step slot: at
    // 1400ms it is still the last step, still inside the run, no longer live.
    expect(viewAt(1400)).toMatchObject({
      phase: "acting",
      steps: [{ kind: "thinking" }, { kind: "tools", live: false }],
    });

    expect(final.elapsedMs).toBe(1500);
    expect(final.steps).toEqual([
      { kind: "thinking", id: thought.id, text: "Two files to read.", live: false, durationMs: 250 },
      {
        kind: "tools",
        id: `${m1.id}-tools-1`,
        live: false,
        tools: [
          {
            toolCallId: "call-1",
            toolName: "read_file",
            state: "output-available",
            argsText: argsA,
            output: "export const a = 1;",
            durationMs: 400,
          },
          {
            toolCallId: "call-2",
            toolName: "read_file",
            state: "output-available",
            argsText: argsB,
            output: "export const b = 2;",
            durationMs: 150,
          },
        ],
      },
    ]);
  });

  it("attaches edit line stats to the tool item, and withholds them on error", () => {
    const m1 = message(1);
    const call = m1.part(0, "tool_call");
    const args = '{"path":"src/main.ts"}';
    // Pi's edit result: +2 -1 as a unified patch under details.
    const result = {
      content: [{ type: "text", text: "edited" }],
      details: {
        patch: [
          "--- a/src/main.ts",
          "+++ b/src/main.ts",
          "@@ -1,2 +1,3 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
        ].join("\n"),
      },
    };

    const runTool = (isError: boolean) =>
      replay([
        runStart(0),
        m1.start(100),
        call.start(200, "edit"),
        call.end(300, args, "call-1"),
        m1.end(400, [call.snapshot(args, "call-1")]),
        toolStart(500, "call-1", "edit"),
        toolEnd(800, "call-1", "edit", result, isError),
        runEnd(900),
      ]).final;

    expect(runTool(false).steps[0]).toMatchObject({
      kind: "tools",
      tools: [
        { state: "output-available", diffStat: { additions: 2, deletions: 1 } },
      ],
    });
    // An errored call keeps its output text but never claims line stats.
    expect(runTool(true).steps[0]).toMatchObject({
      kind: "tools",
      tools: [{ state: "output-error" }],
    });
    const errored = runTool(true).steps[0];
    expect(
      errored.kind === "tools" && errored.tools[0].diffStat,
    ).toBeFalsy();
  });

  it("drops an abandoned Message on retry and re-anchors the clock on the retried one", () => {
    const abandoned = message(1, 1);
    const retried = message(1, 2);
    const partial = abandoned.part(0, "text");
    const answer = retried.part(0, "text");

    const { phases, final, viewAt } = replay([
      runStart(0),
      abandoned.start(100),
      partial.start(200),
      partial.delta(300, "Hel"),
      statusBeat(350, "retrying"),
      abandoned.end(360, [partial.snapshot("Hel")], { abandoned: true }),
      statusBeat(380, "retry_succeeded"),
      retried.start(400),
      answer.start(500),
      answer.delta(600, "Hello"),
      answer.end(700, "Hello"),
      retried.end(800, [answer.snapshot("Hello")]),
      runEnd(900),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "answering", "thinking", "answering", "settled"]);

    // Between the abandoned Message and its replacement nothing is anchored,
    // so no clock is shown rather than one measured from discarded work.
    expect(viewAt(360)).toMatchObject({ phase: "thinking", steps: [] });
    expect(viewAt(360).elapsedMs).toBeUndefined();
    expect(viewAt(360).answer).toBeUndefined();

    // 100ms, not 400ms: the anchor is the retried Message, and the discarded
    // "Hel" never reaches the answer or the steps.
    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 100,
      steps: [],
      answer: { text: "Hello", streaming: false },
    });
  });

  it("settles an aborted run on the Message's own end when it never reached an answer", () => {
    const m1 = message(1);
    const thought = m1.part(0, "thinking");

    const { phases, final } = replay([
      runStart(0),
      m1.start(100),
      thought.start(200),
      thought.delta(400, "Working on it"),
      m1.end(1000, [thought.snapshot("Working on it")]),
      runEnd(1100, "aborted"),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "settled"]);

    // No text Part to freeze on, so the span runs to the Message's end stamp;
    // the abort itself is the error bubble's job, not the CoT's.
    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 900,
      steps: [{ kind: "thinking", text: "Working on it", live: false, durationMs: 800 }],
    });
    expect(final.answer).toBeUndefined();
  });

  it("keeps the last thing the model said as the answer when a run is aborted mid tool call", () => {
    const m1 = message(1);
    const text = m1.part(0, "text");
    const call = m1.part(1, "tool_call");

    // Stop pressed while the model was issuing a call after speaking. Live,
    // the tool_call demotes that text to Interim Output; once the run settles
    // no later Message can take the answer slot, so the text is the Final
    // Answer and keeps its bubble and ActionBar (ADR-0030 §7).
    const { phases, final, viewAt } = replay([
      runStart(0),
      m1.start(100),
      text.start(200),
      text.end(400, "Reading the two files now."),
      call.start(500),
      runEnd(600, "aborted"),
    ]);

    expect(phases).toEqual(["hidden", "thinking", "answering", "acting", "settled"]);

    expect(viewAt(500).answer).toBeUndefined();
    expect(final.answer).toEqual({ text: "Reading the two files now.", streaming: false });
    expect(final.steps.some((step) => step.kind === "interim")).toBe(false);
  });

  it("still produces a Thought step when the provider gives no thinking body", () => {
    const m1 = message(1);
    const thought = m1.part(0, "thinking");

    const { final } = replay([
      runStart(0),
      m1.start(100),
      thought.start(200),
      thought.end(1200, ""),
      m1.end(1300, [thought.snapshot("")]),
      runEnd(1400),
    ]);

    expect(final.steps).toEqual([
      { kind: "thinking", id: thought.id, text: "", live: false, durationMs: 1000 },
    ]);
  });

  it("settles on historical stamps alone when streaming is not allowed", () => {
    const m1 = message(1);
    const answer = m1.part(0, "text");

    // A replayed run, mid-stream and never ended: no wall clock may leak in.
    const { phases, final } = replay(
      [runStart(0), m1.start(100), answer.start(200), answer.delta(300, "Hello")],
      { streamingAllowed: false, nowMs: T0 + 999_999 },
    );

    expect(phases).toEqual(["settled"]);
    expect(final).toMatchObject({
      phase: "settled",
      elapsedMs: 100,
      answer: { text: "Hello", streaming: true },
    });
  });

  it("names a live tool step from the part boundary, before execution starts", () => {
    const m1 = message(1);
    const call = m1.part(0, "tool_call");
    const args = '{"path":"a.ts"}';

    // Large arguments stream for seconds; the label may not sit on "Running…"
    // until tool(start) finally names the call (ADR-0030 §4).
    const { viewAt } = replay([
      runStart(0),
      m1.start(100),
      call.start(200, "read_file"),
      call.end(600, args, "call-1"),
      toolStart(700, "call-1", "read_file"),
    ]);

    expect(viewAt(200).steps).toEqual([
      {
        kind: "tools",
        id: `${m1.id}-tools-0`,
        live: true,
        activeToolCallId: undefined,
        tools: [{ state: "input-streaming", toolName: "read_file" }],
      },
    ]);
  });

  it("exposes the clock anchor so the component, not the page, walks the clock", () => {
    const abandoned = message(1, 1);
    const retried = message(1, 2);
    const answer = retried.part(0, "text");

    // The anchor is the Run's first surviving model call and nothing else: it
    // is what the live clock counts from and what the settled span measures
    // against, so the two can never disagree (ADR-0030 §6).
    const { viewAt } = replay([
      runStart(0),
      abandoned.start(100),
      abandoned.end(200, [], { abandoned: true }),
      retried.start(400),
      answer.start(500),
      answer.end(700, "Hello"),
      retried.end(800, [answer.snapshot("Hello")]),
      runEnd(900),
    ]);

    expect(viewAt(0).anchorMs).toBeUndefined();
    expect(viewAt(200).anchorMs).toBeUndefined();
    expect(viewAt(400).anchorMs).toBe(T0 + 400);
    expect(viewAt(900)).toMatchObject({ anchorMs: T0 + 400, elapsedMs: 100 });
  });

  it("scopes the view to the requested run", () => {
    const m1 = message(1);
    const answer = m1.part(0, "text");
    const { model } = replay([
      runStart(0),
      m1.start(100),
      answer.start(200),
      answer.end(400, "Hello"),
      m1.end(500, [answer.snapshot("Hello")]),
      runEnd(600),
    ]);

    expect(
      deriveCotView(model, "pi-session-1:run-2", { streamingAllowed: true, nowMs: T0 + 700 }),
    ).toMatchObject({ phase: "hidden", steps: [] });
  });
});
