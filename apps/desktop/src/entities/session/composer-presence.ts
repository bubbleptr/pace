/**
 * Which Sessions have a composer mounted — the only thing the Browser panel
 * needs to know about a page's Cmd/Ctrl+Enter.
 *
 * The request itself no longer travels through here: a composer listens for
 * the browser `submit-requested` event on its own, so the send still lands
 * while the panel is closed or unmounted. Presence only answers "is anyone
 * there to send" — when nobody is, the panel is the one who can say so.
 */

const mountedComposers = new Map<string, number>();

/**
 * Marks a composer live for the Session until the returned unmount runs.
 * Ref-counted: a second composer in another split pane keeps the answer true
 * until every one of them is gone.
 */
export function markComposerMounted(sessionId: string) {
  mountedComposers.set(sessionId, (mountedComposers.get(sessionId) ?? 0) + 1);

  return () => {
    const remaining = (mountedComposers.get(sessionId) ?? 1) - 1;

    if (remaining <= 0) {
      mountedComposers.delete(sessionId);
    } else {
      mountedComposers.set(sessionId, remaining);
    }
  };
}

export function isComposerMounted(sessionId: string) {
  return (mountedComposers.get(sessionId) ?? 0) > 0;
}
