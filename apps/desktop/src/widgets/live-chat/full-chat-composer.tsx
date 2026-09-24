import { ChatPromptInput as PromptInput } from "@/shared/ui/chat/chat-prompt-input";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ContextUsageMeter } from "@/shared/ui/context-usage-meter";
import { ModelSelectorControl } from "@/entities/model/model-selector/model-selector-control";
import {
  ComposerAttachmentDrawer,
  ComposerInsertMenu,
  buildPromptWithAttachments,
  insertIntoDraft,
  useComposerAttachments,
  useComposerInsertCatalog,
  useFilePicker,
} from "@/shared/ui/composer-attachments";
import { useEffect, useRef, useState } from "react";
import type { RuntimePromptImage } from "@pace/core";
import { ChatAdd, Computer, FolderLibrary, GitBranch } from "@/shared/ui/icons";
import { CHAT_WORKSPACE_DISPLAY_NAME, isChatProjectId } from "@/entities/project/chat-workspace";
import {
  ComposerLocationRow,
  ComposerStaticChip,
} from "@/entities/checkout/composer-location-row";
import {
  GitBranchPicker,
  gitBranchPickerLabelFromChanges,
} from "@/entities/checkout/git-branch-picker";
import { checkoutModeLabels } from "@/entities/checkout/checkout-strategy-picker";
import { type RuntimeModelSelection } from "@/entities/runtime/pi-runtime-bridge";
import { isContextCompacting } from "@/entities/session/session-runtime-model";
import {
  clearFollowUpDraft,
  getFollowUpDraft,
  saveFollowUpDraft,
} from "@/entities/session/follow-up-drafts";
import { subscribeComposerInjections } from "@/entities/session/composer-injections";
import { type SessionDraftCheckoutMode } from "@/entities/session/session-drafts";
import { type SessionProjection } from "@/entities/session/session-projection";
import { useSessionChanges, type SessionChangesView } from "@/entities/session/use-session-changes";
import { getLastModelSelection } from "@/entities/session/last-model-preference";
import { useModelCatalog } from "@/entities/model/use-model-catalog";
import { useVisibleModels } from "@/entities/model/visible-models";
import { QueuedMessageList } from "./queued-message-list";

export function FullChatComposer({
  queueMode = false,
  isCreating = false,
  isStoppingRun = false,
  projection,
  draftBranchLabel,
  draftCheckoutMode,
  sessionChanges: providedSessionChanges,
  onPromptSubmit,
  onQueueSubmit,
  onWithdrawQueuedMessage,
  onReorderQueuedMessages,
  onStopRun,
  onSteerFromQueue,
  onModelConfigChange,
  onManageModels,
}: {
  queueMode?: boolean;
  /** Session Creation in flight: the input waits for Pi to accept the initial prompt. */
  isCreating?: boolean;
  isStoppingRun?: boolean;
  projection?: SessionProjection | null;
  /** Branch the Session Draft showed, kept until Git answers for the checkout. */
  draftBranchLabel?: string | null;
  /** Where the Draft said to run, kept until the Session has its checkout. */
  draftCheckoutMode?: SessionDraftCheckoutMode | null;
  sessionChanges?: SessionChangesView;
  onPromptSubmit?: (message: string, images?: RuntimePromptImage[]) => Promise<void> | void;
  onQueueSubmit?: (message: string, images?: RuntimePromptImage[]) => Promise<void> | void;
  onWithdrawQueuedMessage?: (queuedMessageId: string) => Promise<void> | void;
  onReorderQueuedMessages?: (orderedIds: string[]) => Promise<void> | void;
  onStopRun?: () => Promise<void> | void;
  onSteerFromQueue?: (queuedMessageId: string) => Promise<void> | void;
  onModelConfigChange?: (selection: RuntimeModelSelection) => Promise<void> | void;
  onManageModels?: () => void;
}) {
  const sessionId = projection?.id ?? null;
  // Settings owns this set (issue #102) and opens as a dialog over this page,
  // so read it live rather than once per mount.
  const visibleModels = useVisibleModels();
  // A live Session's own catalog wins; the global list fills in while it has none.
  const modelCatalog = useModelCatalog({ sessionProjection: projection });
  // Session Creation has no controls of its own yet, so the chip keeps showing
  // what the Draft was set to — the same selection this Session starts with.
  // The fallback reads the unfiltered list because it swaps in its own
  // selection; the selector filters it against that selection.
  const composerModelControls = projection?.modelControls?.models.length
    ? modelCatalog.controls ?? undefined
    : modelCatalog.catalog?.models.length
      ? {
          models: modelCatalog.catalog.models,
          selected:
            projection?.modelControls?.selected ??
            (isCreating ? getLastModelSelection() : null),
        }
      : projection?.modelControls;
  const [draft, setDraft] = useState(() =>
    sessionId ? getFollowUpDraft(sessionId)?.message ?? "" : "",
  );
  // What an injection appends to; the subscription below outlives every
  // keystroke and must not resubscribe for each one.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // Shelf drawer + footer Add-to-prompt menu. Images ride send_prompt /
  // queue_follow_up / steer_run. Decision: .scratch/composer-attachments/PRD.md
  const attachments = useComposerAttachments();
  const catalog = useComposerInsertCatalog();
  const picker = useFilePicker(attachments.addFiles);
  // Prefer the page-level read (shared with Changes / the rail badge) so Git
  // is only asked once. View-only tests that don't pass it still get a local
  // read, gated on a bound runtime — the same moment the footer exists.
  const localSessionChanges = useSessionChanges({
    sessionId,
    enabled:
      !providedSessionChanges && Boolean(sessionId && projection?.piSessionId) &&
      !isChatProjectId(projection?.projectId ?? ""),
  });
  const promptStatus = isStoppingRun || isCreating || isSubmitting
    ? "submitted"
    : queueMode
      ? "streaming"
      : composerError || attachments.error
        ? "error"
        : "ready";
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Pi could not process this input.";
  const updateDraft = (message: string) => {
    setDraft(message);

    if (!sessionId) {
      return;
    }

    if (message.trim()) {
      saveFollowUpDraft(sessionId, message);
    } else {
      clearFollowUpDraft(sessionId);
    }
  };
  const clearSubmittedDraft = () => {
    setDraft("");

    if (sessionId) {
      clearFollowUpDraft(sessionId);
    }
  };

  useEffect(() => {
    setDraft(sessionId ? getFollowUpDraft(sessionId)?.message ?? "" : "");
    setComposerError(null);
    attachments.clear();
  }, [sessionId, attachments.clear]);

  // A surface outside the chat column — today the browser's `Send to composer`
  // (#151) — handing the user something to send. It lands in the draft rather
  // than being sent, so it can be edited, queued or steered like anything the
  // user typed.
  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return subscribeComposerInjections(sessionId, (injection) => {
      const current = draftRef.current;
      const next = current.trim()
        ? `${current.trimEnd()}\n\n${injection.text}`
        : injection.text;

      // Through the ref rather than a state updater: persisting the draft is a
      // side effect, and it also has to be right for a second injection that
      // lands before React has re-rendered the first.
      draftRef.current = next;
      setDraft(next);
      saveFollowUpDraft(sessionId, next);

      if (injection.files?.length) {
        attachments.addFiles(injection.files);
      }
    });
  }, [attachments.addFiles, sessionId]);

  const submitDraft = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const built = await buildPromptWithAttachments(draft, attachments.items);

      if (!built.ok) {
        setComposerError(built.error);
        return;
      }

      if (queueMode) {
        try {
          await onQueueSubmit?.(built.prompt, built.images);
          setComposerError(null);
          attachments.clear();
          clearSubmittedDraft();
        } catch (error) {
          setComposerError(errorMessage(error));
        }

        return;
      }

      try {
        await onPromptSubmit?.(built.prompt, built.images);
        setComposerError(null);
        attachments.clear();
        clearSubmittedDraft();
      } catch (error) {
        setComposerError(errorMessage(error));
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };
  // Queue-first model: the composer always queues while a run is active, and
  // steering happens from the queued row itself as one locked mutation.
  // Decision record: .scratch/composer-redesign/PRD.md
  const steerQueuedMessage = async (queuedMessageId: string) => {
    try {
      await onSteerFromQueue?.(queuedMessageId);
      setComposerError(null);
    } catch (error) {
      setComposerError(errorMessage(error));
    }
  };
  const withdrawQueuedMessage = async (queuedMessageId: string) => {
    try {
      await onWithdrawQueuedMessage?.(queuedMessageId);
      setComposerError(null);
    } catch (error) {
      setComposerError(errorMessage(error));
    }
  };

  const sessionChangesView = providedSessionChanges ?? localSessionChanges;
  const sessionGitChanges = sessionChangesView.changes;
  const gitBranchLabel = gitBranchPickerLabelFromChanges(sessionGitChanges);

  const switchSessionBranch = async (branch: string) => {
    try {
      await sessionChangesView.checkoutBranch(branch);
      setComposerError(null);
    } catch (error) {
      setComposerError(errorMessage(error));
    }
  };

  // Context occupancy is session runtime state, so it rides the footer line
  // rather than any composer control. Only a bound runtime has a context
  // window to be a share of. Git branch status sits on the same row, left of
  // the ring, in the same ghost-Selector chrome as the draft Project picker.
  //
  // The row itself is unconditional and carries the same three slots the
  // Session Draft showed, so the handoff never adds or removes a line. Where
  // the Session runs is settled once it exists: the Location reads as a label.
  const chatProject = isChatProjectId(projection?.projectId ?? "");
  // Until Session Creation has picked the checkout there is nothing to read it
  // from, so the Draft's own choice stands in — the two say the same thing.
  const locationMode: SessionDraftCheckoutMode = projection?.checkout
    ? projection.checkout.mode === "managed-worktree"
      ? "worktree"
      : "local"
    : draftCheckoutMode ?? "local";
  const composerFooter = (
    <ComposerLocationRow
      location={
        chatProject ? (
          <ComposerStaticChip
            chrome="selector"
            icon={ChatAdd}
            label={CHAT_WORKSPACE_DISPLAY_NAME}
            testId="composer-location-label"
          />
        ) : (
          <ComposerStaticChip
            chrome="selector"
            icon={locationMode === "worktree" ? FolderLibrary : Computer}
            label={checkoutModeLabels[locationMode]}
            testId="composer-location-label"
          />
        )
      }
      branch={
        chatProject ? undefined : gitBranchLabel ? (
          <GitBranchPicker
            branch={gitBranchLabel}
            branches={sessionGitChanges?.branches ?? []}
            occupiedBranches={sessionGitChanges?.occupiedBranches ?? []}
            onBranchChange={(next) => void switchSessionBranch(next)}
          />
        ) : draftBranchLabel ? (
          // Git has not answered for this checkout yet. The branch the draft
          // showed is still the truth about where the work starts.
          <ComposerStaticChip
            chrome="button"
            icon={GitBranch}
            label={draftBranchLabel}
            testId="composer-branch-label"
          />
        ) : undefined
      }
      meter={
        <ContextUsageMeter
          isCompacting={
            projection ? isContextCompacting(projection.runtimeModel) : false
          }
          usage={projection?.piSessionId ? projection.contextUsage : null}
        />
      }
    />
  );

  return (
    <div
      className="mt-auto shrink-0 px-4 pb-3 pt-3"
      data-testid="full-chat-composer"
    >
      {projection ? (
        <QueuedMessageList
          projection={projection}
          onSteer={
            queueMode && onSteerFromQueue
              ? (queuedMessageId) => void steerQueuedMessage(queuedMessageId)
              : undefined
          }
          onWithdraw={(queuedMessageId) => void withdrawQueuedMessage(queuedMessageId)}
          onReorder={onReorderQueuedMessages}
        />
      ) : null}
      <PromptInput
        accent="brand"
        allowSubmitWhileRunning={queueMode && !isSubmitting}
        className="mx-auto w-full max-w-[44rem]"
        drawer={
          <ComposerAttachmentDrawer
            items={attachments.items}
            onRemove={attachments.remove}
          />
        }
        error={attachments.error ?? composerError}
        footer={composerFooter}
        hasAttachments={attachments.items.length > 0}
        lockInputOnRun={!queueMode || isSubmitting}
        startActions={
          <>
            {picker.input}
            <ComposerInsertMenu
              plugins={catalog.plugins}
              skills={catalog.skills}
              onAttach={picker.open}
              onInsert={(text) => updateDraft(insertIntoDraft(draft, text))}
            />
            {composerModelControls && onModelConfigChange ? (
              <ModelSelectorControl
                controls={composerModelControls}
                isDisabled={queueMode || isSubmitting || isCreating}
                visibleModels={visibleModels}
                onChange={onModelConfigChange}
                onManageModels={onManageModels}
              />
            ) : null}
          </>
        }
        placeholder={
          isCreating
            ? "Starting session…"
            : queueMode
              ? "Queue the next task…"
              : "What do you want to know?"
        }
        status={promptStatus}
        value={draft}
        onFiles={attachments.addFiles}
        onStop={onStopRun ? () => void onStopRun() : undefined}
        onSubmit={submitDraft}
        onValueChange={updateDraft}
      />
      {isSubmitting ? (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          <TextShimmer>Sending message…</TextShimmer>
        </p>
      ) : null}
    </div>
  );
}
