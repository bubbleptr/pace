import { isChatProjectId } from "@/entities/project/chat-workspace";

export type SessionDraftCheckoutMode = "local" | "worktree";

export type SessionDraft = {
  projectId: string | null;
  prompt: string;
  checkoutMode?: SessionDraftCheckoutMode;
  /** Branch a Git worktree starts from; the Project's HEAD when absent. */
  baseRef?: string;
  updatedAt: string;
};

export type GetSessionDraftOptions = {
  projectIds?: string[];
};

const storageKey = "pigui.sessionDraft.v2";
const draftsChangedEvent = "pigui:session-drafts-changed";

function nowIso() {
  return new Date().toISOString();
}

function getStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

function isSessionDraft(value: unknown): value is SessionDraft {
  const checkoutMode = (value as { checkoutMode?: unknown } | null)?.checkoutMode;
  const baseRef = (value as { baseRef?: unknown } | null)?.baseRef;

  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { projectId?: unknown }).projectId === null ||
      typeof (value as { projectId?: unknown }).projectId === "string") &&
    typeof (value as { prompt?: unknown }).prompt === "string" &&
    (checkoutMode === undefined ||
      checkoutMode === "local" ||
      checkoutMode === "worktree") &&
    (baseRef === undefined || typeof baseRef === "string") &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "string"
  );
}

function readDraft(): SessionDraft | null {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  const rawDraft = storage.getItem(storageKey);

  if (!rawDraft) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawDraft) as SessionDraft;

    return isSessionDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: SessionDraft | null) {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  if (!draft) {
    storage.removeItem(storageKey);
    return;
  }

  storage.setItem(storageKey, JSON.stringify(draft));
}

function emitDraftsChanged(projectId: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(draftsChangedEvent, { detail: { projectId } }));
}

// A base branch only names something inside the Project it was picked in.
function baseRefFor(existingDraft: SessionDraft | null, projectId: string | null) {
  return existingDraft?.baseRef && existingDraft.projectId === projectId
    ? { baseRef: existingDraft.baseRef }
    : {};
}

function clearMissingTarget(
  draft: SessionDraft,
  options: GetSessionDraftOptions | undefined,
) {
  if (!draft.projectId || !options?.projectIds) {
    return draft;
  }

  // Chat is a built-in target, not a registry Project, so it stays valid
  // even when projectIds is only the user's added folders.
  if (isChatProjectId(draft.projectId) || options.projectIds.includes(draft.projectId)) {
    return draft;
  }

  const { baseRef: _baseRef, ...rest } = draft;
  const nextDraft = {
    ...rest,
    projectId: null,
    updatedAt: nowIso(),
  };

  writeDraft(nextDraft);
  emitDraftsChanged(draft.projectId);

  return nextDraft;
}

export function getSessionDraft(
  options?: GetSessionDraftOptions | string,
): SessionDraft | null {
  const draft = readDraft();

  if (!draft) {
    return null;
  }

  return clearMissingTarget(draft, typeof options === "string" ? undefined : options);
}

export function hasSessionDraft(projectId: string) {
  const draft = getSessionDraft();

  return draft !== null && draft.projectId === projectId;
}

export function ensureSessionDraft(projectId: string | null = null) {
  const existingDraft = getSessionDraft();
  const draft: SessionDraft = {
    projectId,
    prompt: existingDraft?.prompt ?? "",
    checkoutMode: existingDraft?.checkoutMode,
    ...baseRefFor(existingDraft, projectId),
    updatedAt: nowIso(),
  };

  writeDraft(draft);
  emitDraftsChanged(projectId);

  return draft;
}

export function saveSessionDraft(projectId: string | null, prompt: string) {
  const existingDraft = getSessionDraft();
  const draft: SessionDraft = {
    projectId,
    prompt,
    checkoutMode: existingDraft?.checkoutMode,
    ...baseRefFor(existingDraft, projectId),
    updatedAt: nowIso(),
  };

  writeDraft(draft);
  emitDraftsChanged(projectId);

  return draft;
}

export function setSessionDraftTarget(projectId: string | null) {
  const existingDraft = getSessionDraft();
  const draft: SessionDraft = {
    projectId,
    prompt: existingDraft?.prompt ?? "",
    checkoutMode: existingDraft?.checkoutMode,
    ...baseRefFor(existingDraft, projectId),
    updatedAt: nowIso(),
  };

  writeDraft(draft);
  emitDraftsChanged(projectId);

  return draft;
}

export function setSessionDraftCheckoutMode(checkoutMode: SessionDraftCheckoutMode) {
  const existingDraft = getSessionDraft();
  const draft: SessionDraft = {
    projectId: existingDraft?.projectId ?? null,
    prompt: existingDraft?.prompt ?? "",
    checkoutMode,
    ...baseRefFor(existingDraft, existingDraft?.projectId ?? null),
    updatedAt: nowIso(),
  };

  writeDraft(draft);
  emitDraftsChanged(draft.projectId);

  return draft;
}

export function setSessionDraftBaseRef(baseRef: string) {
  const existingDraft = getSessionDraft();
  const draft: SessionDraft = {
    projectId: existingDraft?.projectId ?? null,
    prompt: existingDraft?.prompt ?? "",
    checkoutMode: existingDraft?.checkoutMode,
    baseRef,
    updatedAt: nowIso(),
  };

  writeDraft(draft);
  emitDraftsChanged(draft.projectId);

  return draft;
}

export function clearSessionDraft(projectId?: string | null) {
  const draft = getSessionDraft();

  if (!draft) {
    return;
  }

  if (projectId !== undefined && draft.projectId !== projectId) {
    return;
  }

  writeDraft(null);
  emitDraftsChanged(draft.projectId);
}

export function subscribeSessionDrafts(listener: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey) {
      listener();
    }
  };

  window.addEventListener(draftsChangedEvent, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(draftsChangedEvent, listener);
    window.removeEventListener("storage", handleStorage);
  };
}
