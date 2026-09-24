import { type PiRuntimeBridge, type PiSessionState } from "@/entities/runtime/pi-runtime-bridge";
import { type SessionProjection } from "@/entities/session/session-projection";
import type { AgentWorkspaceFixture } from "./live-session-column";

type RestorablePiRuntimeBridge = PiRuntimeBridge & {
  restoreSessionState(state: PiSessionState): Promise<PiSessionState>;
};

function isRestorablePiRuntimeBridge(
  bridge: PiRuntimeBridge,
): bridge is RestorablePiRuntimeBridge {
  return (
    "restoreSessionState" in bridge &&
    typeof bridge.restoreSessionState === "function"
  );
}

function runtimeStateStatusFromProjection(
  projection: SessionProjection,
): PiSessionState["status"] {
  switch (projection.status) {
    case "failed":
      return "failed";
    case "completed":
    case "archived":
      return "completed";
    case "waiting":
      return "idle";
    case "creating":
    case "running":
      return "running";
  }
}

export function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Pi could not stop the active run.";
}

export async function restoreProjectionRuntimeState(input: {
  bridge: PiRuntimeBridge;
  projection: SessionProjection;
  workspace: AgentWorkspaceFixture;
}) {
  const { bridge, projection, workspace } = input;

  if (
    !projection.piSessionId ||
    !projection.runtimeId ||
    !isRestorablePiRuntimeBridge(bridge)
  ) {
    return;
  }

  await bridge.restoreSessionState({
    piSessionId: projection.piSessionId,
    runtimeId: projection.runtimeId,
    projectId: projection.projectId,
    cwd: projection.checkout?.runtimeCwd ?? workspace.checkout.runtimeCwd,
    status: runtimeStateStatusFromProjection(projection),
    events: projection.runtimeEvents,
    summary: projection.summary,
    updatedAt: projection.updatedAt,
  });
}
