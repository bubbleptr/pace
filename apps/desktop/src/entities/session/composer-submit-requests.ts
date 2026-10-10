/**
 * A way to ask a mounted composer to send what it holds from outside the
 * chat column — today the browser page's Cmd/Ctrl+Enter.
 *
 * There is nothing to write into from outside: the draft, the attachments and
 * the Session's browser comments all live inside the composer's own state, so
 * the request is a window event — the same paradigm the follow-up drafts next
 * door already use — and the composer answers by submitting.
 *
 * Only a composer mounted for that Session can take the request, and
 * `requestComposerSubmit` says whether one did. Nothing is queued for one
 * that is not — an archived Session is a read-only projection with no
 * composer at all — so the requester has to be able to tell the user that,
 * with the comments still on the page to send again.
 */

const composerSubmitRequestEvent = "pigui:composer-submit-request";

/** The envelope: `delivered` is the subscriber's answer back to the sender. */
type ComposerSubmitRequestEnvelope = {
  sessionId: string;
  delivered: boolean;
};

/**
 * Returns whether a composer took the request. Dispatch is synchronous, so
 * the answer is known by the time this returns — and a caller that hears "no"
 * can say so rather than let the user believe their comments went somewhere.
 */
export function requestComposerSubmit(sessionId: string) {
  const envelope: ComposerSubmitRequestEnvelope = {
    sessionId,
    delivered: false,
  };

  window.dispatchEvent(
    new CustomEvent<ComposerSubmitRequestEnvelope>(
      composerSubmitRequestEvent,
      { detail: envelope },
    ),
  );

  return envelope.delivered;
}

export function subscribeComposerSubmitRequests(
  sessionId: string,
  listener: () => void,
) {
  const handle = (event: Event) => {
    const envelope = (event as CustomEvent<ComposerSubmitRequestEnvelope>)
      .detail;

    // One composer is mounted at a time, but it outlives Session switches —
    // a request aimed at the Session it used to show is not for it.
    if (envelope.sessionId !== sessionId) {
      return;
    }

    envelope.delivered = true;
    listener();
  };

  window.addEventListener(composerSubmitRequestEvent, handle);

  return () => window.removeEventListener(composerSubmitRequestEvent, handle);
}
