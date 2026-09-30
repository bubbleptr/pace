import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SubagentRecord } from "@pace/core";
import type { TrajectoryStep, TrajectoryTurn } from "@/entities/session/trajectory-model";
import { PiTrajectoryInspector } from "@/shared/ui/pi-trajectory-inspector";

const agentStep: TrajectoryStep = {
  id: "agent-child",
  turnIndex: 0,
  stepIndex: 0,
  kind: "tool",
  name: "Agent",
  target: "Explore",
  toolCallId: "call-agent",
};

const turn: TrajectoryTurn = {
  index: 0,
  runIndex: 0,
  role: "assistant",
  label: "Assistant",
  model: "gpt-5",
  hasError: false,
  toolCount: 1,
  steps: [agentStep],
};

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    ownerToolCallId: "call-agent",
    state: "started",
    source: "tintinweb",
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
    capabilities: { send: true, stop: true },
    sourceAgentId: "ag-1",
    ...overrides,
  };
}

function renderInspector(props: {
  childRecord?: SubagentRecord;
  childSession?: { id: string; isAvailable: boolean };
  onSendToChild?: (text: string) => void;
  onStopChild?: () => void;
}) {
  return render(
    <PiTrajectoryInspector
      childRecord={props.childRecord}
      childSession={props.childSession}
      step={agentStep}
      tab="Summary"
      turn={turn}
      onClose={() => {}}
      onOpenChildSession={() => {}}
      onSendToChild={props.onSendToChild}
      onStopChild={props.onStopChild}
      onTabChange={() => {}}
    />,
  );
}

describe("PiTrajectoryInspector nested calls", () => {
  const codemodeStep: TrajectoryStep = {
    id: "codemode",
    turnIndex: 0,
    stepIndex: 0,
    kind: "tool",
    name: "codemode",
    toolCallId: "call-1",
    nestedCalls: {
      complete: false,
      calls: [
        {
          id: "call-1/1",
          name: "mcp__probe__echo",
          argsText: '{\n  "text": "hi"\n}',
          status: "ok",
          durationMs: 42,
        },
        {
          id: "call-1/2",
          name: "bash",
          argumentsBytes: 512,
          status: "error",
          error: "exit 1",
        },
      ],
    },
  };

  it("lists the recorded calls with their status, args and errors", () => {
    const { container } = render(
      <PiTrajectoryInspector
        step={codemodeStep}
        tab="Summary"
        turn={turn}
        onClose={() => {}}
        onTabChange={() => {}}
      />,
    );

    const section = container.querySelector('[data-slot="nested-calls"]');
    expect(section).toBeInTheDocument();
    expect(section).toHaveTextContent("Nested calls (2)");
    expect(section).toHaveTextContent("probe/echo");
    expect(section).toHaveTextContent("42ms");
    expect(section).toHaveTextContent('"text": "hi"');
    expect(section).toHaveTextContent("Arguments omitted (512 bytes)");
    expect(section).toHaveTextContent("exit 1");
    expect(section).toHaveTextContent(
      "Pi kept a partial record: some calls were dropped, had arguments omitted, or had not finished.",
    );
  });

  it("renders an empty list with the partial-record note when every call was dropped", () => {
    const { container } = render(
      <PiTrajectoryInspector
        step={{ ...codemodeStep, nestedCalls: { calls: [], complete: false } }}
        tab="Summary"
        turn={turn}
        onClose={() => {}}
        onTabChange={() => {}}
      />,
    );

    const section = container.querySelector('[data-slot="nested-calls"]');
    expect(section).toBeInTheDocument();
    expect(section).toHaveTextContent("Nested calls (0)");
    expect(section).toHaveTextContent(
      "Pi kept a partial record: some calls were dropped, had arguments omitted, or had not finished.",
    );
  });

  it("omits the section when the step recorded no nested calls", () => {
    const { container } = render(
      <PiTrajectoryInspector
        step={agentStep}
        tab="Summary"
        turn={turn}
        onClose={() => {}}
        onTabChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-slot="nested-calls"]')).not.toBeInTheDocument();
  });
});

describe("PiTrajectoryInspector child controls", () => {
  it("hides send/stop when the record did not advertise them", () => {
    renderInspector({
      childRecord: record({ capabilities: undefined }),
      childSession: { id: "child-1", isAvailable: true },
    });
    expect(screen.getByTestId("open-child-session")).toBeInTheDocument();
    expect(screen.queryByTestId("child-session-controls")).not.toBeInTheDocument();
  });

  it("shows send and stop while the child is running", async () => {
    const user = userEvent.setup();
    const onSendToChild = vi.fn();
    const onStopChild = vi.fn();
    renderInspector({
      childRecord: record({ state: "started" }),
      onSendToChild,
      onStopChild,
    });
    expect(screen.getByTestId("send-to-child")).toBeDisabled();
    await user.type(screen.getByTestId("send-to-child-input"), "nudge");
    await user.click(screen.getByTestId("send-to-child"));
    expect(onSendToChild).toHaveBeenCalledWith("nudge");
    await user.click(screen.getByTestId("stop-child"));
    expect(onStopChild).toHaveBeenCalled();
  });

  it("keeps send on a settled child and hides stop", () => {
    renderInspector({
      childRecord: record({ state: "completed" }),
      onSendToChild: () => {},
      onStopChild: () => {},
    });
    expect(screen.getByTestId("send-to-child")).toBeInTheDocument();
    expect(screen.queryByTestId("stop-child")).not.toBeInTheDocument();
  });

  it("hides send when only stop is advertised", () => {
    renderInspector({
      childRecord: record({ capabilities: { stop: true }, state: "started" }),
      onStopChild: () => {},
    });
    expect(screen.queryByTestId("send-to-child")).not.toBeInTheDocument();
    expect(screen.getByTestId("stop-child")).toBeInTheDocument();
  });
});
