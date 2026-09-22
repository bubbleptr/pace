// Which catalog models the composer selector may list (issue #102). Managed
// on the Settings page, read by the selector. Same renderer-local settings
// channel as the other Pace preferences (localStorage, `pigui.*` keys) —
// Pi's own settings.json stays Pi's.
//
// Known boundary: this is an explicit allowlist (the Cursor semantics the
// issue asks for), not a denylist. The first time a user unchecks anything,
// the models visible at that moment are written out in full, so models Pi
// adds later are hidden until the user checks them in Settings. Only the
// empty set — nothing configured, or everything unchecked — keeps listing
// the whole catalog.

import { useSyncExternalStore } from "react";
import type { ModelRef } from "@/shared/ui/model-selector/model-selector-logic";

export const visibleModelsStorageKey = "pigui.visibleModels.v1";

function getStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

function isModelRef(value: unknown): value is ModelRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { modelId?: unknown }).modelId === "string"
  );
}

/** Empty means "not configured yet": the selector then shows every model. */
export function getVisibleModels(): ModelRef[] {
  const raw = getStorage()?.getItem(visibleModelsStorageKey);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) && parsed.every(isModelRef)
      ? parsed.map(({ provider, modelId }) => ({ provider, modelId }))
      : [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

export function saveVisibleModels(models: ModelRef[]) {
  getStorage()?.setItem(
    visibleModelsStorageKey,
    JSON.stringify(
      models.map(({ provider, modelId }) => ({ provider, modelId })),
    ),
  );
  for (const listener of listeners) listener();
}

function subscribeVisibleModels(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// useSyncExternalStore compares snapshots by identity, so the parsed array is
// reused until the stored string changes; a fresh array per read would
// re-render forever.
let snapshotRaw: string | null | undefined;
let snapshot: ModelRef[] = [];

function readVisibleModelsSnapshot(): ModelRef[] {
  const raw = getStorage()?.getItem(visibleModelsStorageKey) ?? null;

  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = getVisibleModels();
  }

  return snapshot;
}

/**
 * Settings opens as a dialog over the workspace, so a composer reading the
 * set once on mount would keep listing the old models until the next
 * navigation. This follows every save made in the same window.
 */
export function useVisibleModels(): ModelRef[] {
  return useSyncExternalStore(
    subscribeVisibleModels,
    readVisibleModelsSnapshot,
    readVisibleModelsSnapshot,
  );
}
