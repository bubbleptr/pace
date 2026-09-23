import type { RuntimeModelSelection, RuntimePromptImage } from "@pace/core";
import { CHAT_PROJECT_ID } from "@pace/core";
import { isChatProjectId } from "@/entities/project/chat-workspace";
import type { SessionDraft } from "@/entities/session/session-drafts";
import { PiRuntimeBridgeError, type PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import {
  createExecutionCheckoutManager,
  type ExecutionCheckoutManager,
} from "@/entities/checkout/execution-checkout";
import {
  createSessionProjection,
  type SessionCreationFailureStage,
  type SessionProjection,
  type SessionProjectionEvent,
} from "@/entities/session/session-projection";
import type { SessionProjectionsStore } from "@/entities/session/session-projections-store";

export type ProjectSessionCreationTarget = {
  id: string;
  repoRoot?: string;
  projectRoot: string;
};

export type CreateSessionFromDraftInput = {
  bridge: PiRuntimeBridge;
  checkoutManager?: ExecutionCheckoutManager;
  store: SessionProjectionsStore;
  draft: SessionDraft;
  project: ProjectSessionCreationTarget;
  /** Optional model chosen on the draft composer before the session exists (DF-011). */
  modelSelection?: RuntimeModelSelection;
  /** Image attachments for the first prompt; not persisted on the text draft. */
  images?: RuntimePromptImage[];
  executionMode?: "foreground" | "background";
  now?: () => string;
  idFactory?: () => string;
  onProjectionChange?: (projection: SessionProjection) => void;
};

export type CreateSessionFromDraftResult =
  | {
      ok: true;
      clearDraft: true;
      projection: SessionProjection;
    }
  | {
      ok: false;
      clearDraft: false;
      projection: SessionProjection;
    };

function defaultIdFactory() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `session-${crypto.randomUUID()}`;
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isSessionCreationFailureStage(
  stage: string,
): stage is SessionCreationFailureStage {
  return (
    stage === "preparing checkout" ||
    stage === "starting runtime" ||
    stage === "sending prompt"
  );
}

function failureDetail(error: unknown, fallbackStage: SessionCreationFailureStage) {
  if (error instanceof PiRuntimeBridgeError) {
    return {
      stage: isSessionCreationFailureStage(error.stage) ? error.stage : fallbackStage,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      stage: fallbackStage,
      message: error.message,
    };
  }

  return {
    stage: fallbackStage,
    message: String(error),
  };
}

export async function prepareChatSessionCheckout(input: {
  sessionId: string;
  bridge: PiRuntimeBridge;
  checkoutManager: ExecutionCheckoutManager;
  now?: () => string;
}) {
  const prepare = input.bridge.prepareChatWorkspace;

  if (!prepare) {
    throw new Error("Chat workspace is not available.");
  }

  const { cwd } = await prepare({ sessionId: input.sessionId });

  return input.checkoutManager.prepareCheckout({
    sessionId: input.sessionId,
    strategy: "foreground-local",
    project: {
      id: CHAT_PROJECT_ID,
      projectRoot: cwd,
    },
    now: input.now,
    skipGit: true,
  });
}

export async function createSessionFromDraft(
  input: CreateSessionFromDraftInput,
): Promise<CreateSessionFromDraftResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? defaultIdFactory;
  const checkoutManager = input.checkoutManager ?? createExecutionCheckoutManager();
  const draftProjectId = input.draft.projectId;

  if (!draftProjectId) {
    throw new Error("Session Draft target Project is required.");
  }

  let failureStage: SessionCreationFailureStage = "preparing checkout";
  let projection = input.store.insert(
    createSessionProjection({
      id: idFactory(),
      projectId: draftProjectId,
      initialPrompt:
        input.draft.prompt.trim() ||
        input.images?.[0]?.name ||
        "Attached image",
      createdAt: now(),
    }),
  );
  input.onProjectionChange?.(projection);

  const commit = (event: SessionProjectionEvent) => {
    projection = input.store.apply(projection.id, event);
    input.onProjectionChange?.(projection);
  };

  try {
    const chatCheckout = isChatProjectId(draftProjectId)
      ? await prepareChatSessionCheckout({
          sessionId: projection.id,
          bridge: input.bridge,
          checkoutManager,
          now,
        })
      : null;
    const checkout =
      chatCheckout ??
      (await checkoutManager.prepareCheckout({
        sessionId: projection.id,
        strategy:
          input.executionMode === "background" ? "background-managed" : "foreground-local",
        project: input.project,
        now,
        baseRef: input.draft.baseRef,
      }));

    commit({
      type: "checkout-selected",
      stage: "preparing checkout",
      checkout,
      occurredAt: now(),
    });

    failureStage = "starting runtime";
    const runtime = await input.bridge.startRuntime({
      sessionId: projection.id,
      projectId: draftProjectId,
      checkout,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    });
    const piState = await input.bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: draftProjectId,
      cwd: checkout.runtimeCwd,
    });

    // The store subscribes to the runtime's event streams here, so the
    // created Session keeps updating after this function returns.
    commit({
      type: "runtime-bound",
      stage: "starting runtime",
      runtimeId: runtime.runtimeId,
      piSessionId: piState.piSessionId,
      summary: piState.summary,
      modelControls: piState.modelControls,
      followUpMode: piState.followUpMode,
      occurredAt: now(),
    });

    if (input.modelSelection && input.bridge.configureModel) {
      const modelControls = await input.bridge.configureModel({
        sessionId: projection.id,
        piSessionId: piState.piSessionId,
        ...input.modelSelection,
      });

      commit({
        type: "model-controls-changed",
        modelControls,
        occurredAt: now(),
      });
    }

    failureStage = "sending prompt";
    commit({
      type: "creation-stage-changed",
      stage: "sending prompt",
      occurredAt: now(),
    });

    const submittedAt = now();
    const accepted = await input.bridge.sendInitialPrompt({
      piSessionId: piState.piSessionId,
      prompt: input.draft.prompt,
      ...(input.images?.length ? { images: input.images } : {}),
    });

    commit({
      type: "runtime-event-received",
      stage: "accepted",
      submittedAt,
      event: accepted.event,
    });

    return {
      ok: true,
      clearDraft: true,
      projection,
    };
  } catch (error) {
    const detail = failureDetail(error, failureStage);

    commit({
      type: "creation-failed",
      stage: detail.stage,
      message: detail.message,
      occurredAt: now(),
    });

    return {
      ok: false,
      clearDraft: false,
      projection,
    };
  }
}
