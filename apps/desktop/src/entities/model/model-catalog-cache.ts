import type { RuntimeModelCapability, RuntimeModelControls } from "@pace/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ignore a catalog push that is not a model list. The backend owns the shape. */
export function modelControlsFromUnknown(value: unknown): RuntimeModelControls | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  if (value.selected != null && !isRecord(value.selected)) return null;
  return value as RuntimeModelControls;
}

/**
 * Last catalog painted into a composer before a Session exists. Cleared when
 * credentials change so the next draft does not reuse models from the
 * previous auth.json.
 */
let cachedModelCatalog: RuntimeModelCapability[] = [];
const invalidationListeners = new Set<() => void>();

export function readCachedModelCatalog() {
  return cachedModelCatalog;
}

export function rememberModelCatalog(models: RuntimeModelCapability[]) {
  if (models.length) {
    cachedModelCatalog = models;
  }
}

export function invalidateCachedModelCatalog() {
  cachedModelCatalog = [];
  for (const listener of invalidationListeners) listener();
}

export function subscribeModelCatalogInvalidation(listener: () => void) {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}
