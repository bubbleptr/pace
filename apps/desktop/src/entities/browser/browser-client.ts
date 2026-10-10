import { invoke, onBrowserEvent } from "@/shared/runtime";
import type {
  BrowserAnnotationPalette,
  BrowserComment,
  BrowserCommentList,
  BrowserEvent,
  BrowserSessionState,
  BrowserTabState,
  BrowserTabTarget,
  BrowserViewRect,
} from "@/shared/browser-protocol";

/**
 * Native views belong to main; every page command names its Session and tab.
 * Reattaches whatever native tabs main already has for this Session — it
 * never restores a previously saved tab group (#224).
 */
export function attachBrowserSession(sessionId: string) {
  return invoke<BrowserSessionState>("browser_attach", { sessionId });
}
export function openBrowserTab(sessionId: string) {
  return invoke<BrowserSessionState>("browser_open", { sessionId });
}
export function closeBrowserTab(target: BrowserTabTarget) {
  return invoke<BrowserSessionState>("browser_close", target);
}
export function activateBrowserTab(target: BrowserTabTarget) {
  return invoke<BrowserSessionState>("browser_activate", target);
}
export function hideBrowserSession(sessionId: string) {
  return invoke<null>("browser_hide_session", { sessionId });
}
export function navigateBrowser(target: BrowserTabTarget, url: string) {
  return invoke<BrowserTabState>("browser_navigate", { ...target, url });
}
export function browserBack(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_back", target);
}
export function browserForward(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_forward", target);
}
export function reloadBrowser(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_reload", target);
}
export function setBrowserBounds(
  target: BrowserTabTarget,
  rect: BrowserViewRect,
) {
  return invoke<BrowserTabState | null>("browser_set_bounds", {
    ...target,
    rect,
  });
}
export function setBrowserVisible(target: BrowserTabTarget, visible: boolean) {
  return invoke<BrowserTabState | null>("browser_set_visible", {
    ...target,
    visible,
  });
}
export function setBrowserDesignMode(
  target: BrowserTabTarget,
  enabled: boolean,
  palette?: BrowserAnnotationPalette,
) {
  return invoke<BrowserTabState | null>("browser_set_design_mode", {
    ...target,
    enabled,
    ...(palette ? { palette } : {}),
  });
}
export function setBrowserAnnotationPalette(
  target: BrowserTabTarget,
  palette: BrowserAnnotationPalette,
) {
  return invoke<BrowserTabState | null>("browser_set_annotation_palette", {
    ...target,
    palette,
  });
}
export function clearBrowserAnnotations(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_clear_annotations", target);
}
/**
 * The Session's comment store — every comment across all its tabs, in store
 * order. A pure read: it never attaches, activates or paints a tab.
 */
export function listBrowserComments(sessionId: string) {
  return invoke<BrowserCommentList>("browser_list_comments", { sessionId });
}
/**
 * The same read after every in-flight save-crop has landed — the answer a
 * send builds on, so a comment committed moments before the send is in it.
 */
export function settleBrowserComments(sessionId: string) {
  return invoke<BrowserCommentList>("browser_settle_comments", { sessionId });
}
/** The save-crops for the given comment ids, `null` where none was taken. */
export function readBrowserCommentImages(sessionId: string, ids: string[]) {
  return invoke<Record<string, string | null>>("browser_comment_images", {
    sessionId,
    ids,
  });
}
export function deleteBrowserComment(sessionId: string, id: string) {
  return invoke<null>("browser_delete_comment", { sessionId, id });
}
/**
 * Comments sent onward (to the composer, S3) leave the store exactly once —
 * removes precisely the given ids and ignores ones already gone.
 */
export function consumeBrowserComments(sessionId: string, ids: string[]) {
  return invoke<null>("browser_consume_comments", { sessionId, ids });
}
export function captureBrowser(target: BrowserTabTarget) {
  return invoke<string | null>("browser_capture", target);
}
export function openBrowserUrlExternally(url: string) {
  return invoke<null>("browser_open_external", { url });
}
export function subscribeBrowserEvents(
  listener: (event: BrowserEvent) => void,
) {
  return onBrowserEvent(listener);
}
