import {
  ChatPromptInput as PromptInput,
  type ChatPromptInputHandle,
} from "@/shared/ui/chat/chat-prompt-input";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ContextUsageMeter } from "@/shared/ui/context-usage-meter";
import { ModelSelectorControl } from "@/entities/model/model-selector/model-selector-control";
import {
  ComposerAttachmentDrawer,
  ComposerInsertMenu,
  buildPromptWithAttachments,
  type PromptAppendix,
  useComposerAttachments,
  useFilePicker,
} from "@/shared/ui/composer-attachments";
import {
  INSERT_CATALOG_KIND,
  commandToken,
  insertCatalogs,
  leadingCommandMatch,
  slashTrigger,
  slashTriggerActive,
  usePromptCommands,
  validateCommandSubmit,
} from "@/entities/prompt-command";
import {
  FILE_INSERT_CATALOG_ID,
  atTrigger,
  fileInsertCatalog,
  fileSearchItem,
  fileToken,
  useWorkspaceFileSearch,
} from "@/entities/workspace-file";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import type { RuntimePromptImage, WorkspaceFileMatch } from "@pace/core";
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
import { markComposerMounted } from "@/entities/session/composer-presence";
import {
  consumeBrowserComments,
  deleteBrowserComment,
  readBrowserCommentImages,
  settleBrowserComments,
} from "@/entities/browser/browser-client";
import { useBrowserComments } from "@/entities/browser/use-browser-comments";
import { isElectronRuntime } from "@/shared/runtime";
import type { BrowserComment } from "@/shared/browser-protocol";
import { formatBrowserComments } from "@pace/core";
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
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // Shelf drawer + footer Add-to-prompt menu. Images ride send_prompt /
  // queue_follow_up / steer_run. Decision: .scratch/composer-attachments/PRD.md
  const attachments = useComposerAttachments();
  const picker = useFilePicker(attachments.addFiles);
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  // Live Sessions query the runtime catalog — extension commands only exist
  // once the runtime is live (see usePromptCommands' piSessionId+status key).
  const commandQuery = usePromptCommands(sessionId ? { sessionId } : null);
  const commands = useMemo(
    () => commandQuery.data?.commands ?? [],
    [commandQuery.data],
  );
  const slashActive = slashTriggerActive(draft);
  const trigger = useMemo(
    () => slashTrigger(commands, { active: slashActive, queueMode }),
    [commands, slashActive, queueMode],
  );
  // "@" file references search the Session's workspace; Chat Sessions have
  // no project files, so the trigger stays off there.
  const fileSearch = useWorkspaceFileSearch(
    sessionId && !isChatProjectId(projection?.projectId ?? "")
      ? { sessionId }
      : null,
  );
  const fileTrigger = useMemo(
    () => (fileSearch ? atTrigger(fileSearch) : null),
    [fileSearch],
  );
  const inputTriggers = useMemo(
    () =>
      [trigger, fileTrigger].filter(
        (entry): entry is ChatComposerTrigger => entry !== null,
      ),
    [trigger, fileTrigger],
  );
  // Palette picks come back as row ids (paths); the matches behind the last
  // search are what onPick maps back to WorkspaceFileMatch.
  const lastFileMatchesRef = useRef<readonly WorkspaceFileMatch[]>([]);
  const fileSearchVersionRef = useRef(0);
  const fileCatalogSearch = useMemo(() => {
    if (!fileSearch) {
      return null;
    }
    return async (query: string) => {
      const version = ++fileSearchVersionRef.current;
      const matches = await fileSearch(query);
      // Match the palette's latest-query guard so picks use its visible rows.
      if (version === fileSearchVersionRef.current) {
        lastFileMatchesRef.current = matches;
      }
      return matches.map(fileSearchItem);
    };
  }, [fileSearch]);
  const leadingTokenFor = useCallback(
    (value: string) => leadingCommandMatch(value, commands),
    [commands],
  );
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

  // The Session's browser comments ride the send as an appendix — chips in
  // the drawer, and a formatted block + screenshots in the prompt itself.
  // onSubmitRequested is the page's Cmd/Ctrl+Enter — the composer answers the
  // event itself, so the send survives the Browser panel being closed. The
  // ref lets the callback run the latest submit without the option churning.
  const pageSubmitRef = useRef<() => void>(() => {});
  const browserComments = useBrowserComments(sessionId, {
    onSubmitRequested: () => pageSubmitRef.current(),
  });
  const commentChips = useMemo(
    () =>
      browserComments.comments.map((comment) => {
        const line = comment.comment
          ?.split(/\r?\n/)
          .map((part) => part.trim())
          .find((part) => part.length > 0);
        return {
          id: comment.id,
          // An area comment's first line still summarizes it; the kind word
          // keeps "#n" from reading as an element mark.
          label: comment.area
            ? line
              ? `#${comment.index} Area · ${line}`
              : `#${comment.index} Area`
            : line
              ? `#${comment.index} ${line}`
              : `#${comment.index}`,
          warning: comment.stale
            ? "No longer on the page — sent as it was when saved"
            : undefined,
        };
      }),
    [browserComments.comments],
  );

  const removeBrowserComment = useCallback(
    (id: string) => {
      if (!sessionId) {
        return;
      }
      deleteBrowserComment(sessionId, id).catch((error) => {
        setComposerError(errorMessage(error));
      });
    },
    [sessionId],
  );

  const submitDraft = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // Slash-command guard: TUI commands and queued extension commands are
      // rejected here so the draft survives a refused submit.
      const commandError = validateCommandSubmit(draft, { commands, queueMode });
      if (commandError) {
        setComposerError(commandError);
        return;
      }

      // What is sent is the settled store, not the hook's snapshot: a comment
      // whose crop is still in flight lands in the send once the wait ends.
      // The snapshot of ids — and only it — is what a success consumes.
      let pending: BrowserComment[] = [];
      if (sessionId && isElectronRuntime()) {
        try {
          pending = (await settleBrowserComments(sessionId)).comments;
        } catch (error) {
          // Nothing sent means nothing consumed — the comments stay put.
          setComposerError(errorMessage(error));
          return;
        }
      }
      const sentCommentIds = pending.map((comment) => comment.id);
      let appendix: PromptAppendix | undefined;

      if (pending.length && sessionId) {
        const imageIds = pending
          .filter((comment) => comment.hasImage)
          .map((comment) => comment.id);
        let imageData: Record<string, string | null> = {};

        try {
          if (imageIds.length) {
            imageData = await readBrowserCommentImages(sessionId, imageIds);
          }
        } catch (error) {
          // Nothing sent means nothing consumed — the comments stay put.
          setComposerError(errorMessage(error));
          return;
        }

        // hasImage here answers what this message actually carries, not what
        // the store hopes to have.
        const entries = pending.map((comment) => ({
          ...comment,
          hasImage: Boolean(imageData[comment.id]),
        }));

        appendix = {
          text: formatBrowserComments(entries),
          images: entries
            .filter((comment) => comment.hasImage)
            .map((comment) =>
              promptImageFromDataUrl(
                imageData[comment.id]!,
                `browser-comment-${comment.index}.png`,
              ),
            ),
        };
      }

      const built = await buildPromptWithAttachments(
        draft,
        attachments.items,
        appendix,
      );

      if (!built.ok) {
        setComposerError(built.error);
        return;
      }

      const sent = () => {
        setComposerError(null);
        attachments.clear();
        clearSubmittedDraft();
        // Sent comments leave the store — only the snapshot ids, so anything
        // saved while the send was in flight is kept.
        if (sentCommentIds.length && sessionId) {
          void consumeBrowserComments(sessionId, sentCommentIds).catch(
            () => {},
          );
        }
      };

      if (queueMode) {
        try {
          await onQueueSubmit?.(built.prompt, built.images);
          sent();
        } catch (error) {
          setComposerError(errorMessage(error));
        }

        return;
      }

      try {
        await onPromptSubmit?.(built.prompt, built.images);
        sent();
      } catch (error) {
        setComposerError(errorMessage(error));
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };
  // Cmd/Ctrl+Enter in the page asks this composer to send what it holds. The
  // ref keeps the subscription stable across every keystroke's new submitDraft.
  const submitDraftRef = useRef(submitDraft);
  submitDraftRef.current = submitDraft;

  // The request's own gates, read through refs for the same reason: while the
  // composer cannot send at all (Session Creation, a stop in flight) a page
  // request is ignored — and so is one that would go out empty. Delivered is
  // still true either way: the composer is mounted and did consider it.
  const composerBusyRef = useRef(isCreating || isStoppingRun);
  composerBusyRef.current = isCreating || isStoppingRun;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const attachmentsRef = useRef(attachments.items);
  attachmentsRef.current = attachments.items;

  // The request's own gates, read through refs for the same reason: while
  // the composer cannot send at all (Session Creation, a stop in flight) a
  // page request is ignored — and so is one that would go out empty.
  pageSubmitRef.current = () => {
    if (composerBusyRef.current) {
      return;
    }

    const hasDraft = Boolean(draftRef.current.replace(/\u00A0/g, " ").trim());

    if (
      !hasDraft &&
      attachmentsRef.current.length === 0 &&
      browserComments.latest().length === 0
    ) {
      return;
    }

    void submitDraftRef.current();
  };

  // Mounted means the page's send has a taker — the Browser panel only warns
  // about an unanswered request when this registry says nobody is here.
  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return markComposerMounted(sessionId);
  }, [sessionId]);

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
            comments={commentChips}
            commentsLabel="Browser comments"
            items={attachments.items}
            onRemove={attachments.remove}
            onRemoveComment={removeBrowserComment}
          />
        }
        error={attachments.error ?? composerError}
        footer={composerFooter}
        hasAttachments={
          attachments.items.length > 0 || browserComments.comments.length > 0
        }
        inputRef={inputRef}
        leadingTokenFor={leadingTokenFor}
        lockInputOnRun={!queueMode || isSubmitting}
        startActions={
          <>
            {picker.input}
            <ComposerInsertMenu
              catalogs={[
                ...insertCatalogs(commands, { queueMode }),
                ...(fileCatalogSearch
                  ? [fileInsertCatalog(fileCatalogSearch)]
                  : []),
              ]}
              onAttach={picker.open}
              onPick={(catalogId, itemId) => {
                if (catalogId === FILE_INSERT_CATALOG_ID) {
                  const match = lastFileMatchesRef.current.find(
                    (entry) => entry.path === itemId,
                  );
                  if (match) {
                    inputRef.current?.appendToken(fileToken(match));
                  }
                  return;
                }
                const kind = INSERT_CATALOG_KIND[catalogId];
                const command = commands.find(
                  (entry) => entry.kind === kind && entry.invocation === itemId,
                );
                if (command) {
                  inputRef.current?.insertLeadingToken(commandToken(command));
                }
              }}
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
        triggers={inputTriggers}
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

/**
 * A `data:image/…;base64,…` URL split into the pieces the runtime prompt
 * image takes. Anything unexpected still parses — the store only ever hands
 * back PNGs, and the fallback keeps a malformed one a sendable PNG.
 */
function promptImageFromDataUrl(
  dataUrl: string,
  name: string,
): RuntimePromptImage {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);

  return {
    mimeType: match?.[1] ?? "image/png",
    data: match?.[2] ?? "",
    name,
  };
}
