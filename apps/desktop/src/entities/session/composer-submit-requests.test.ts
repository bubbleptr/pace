import { describe, expect, it, vi } from "vitest";
import {
  requestComposerSubmit,
  subscribeComposerSubmitRequests,
} from "./composer-submit-requests";

describe("composer submit requests", () => {
  it("reaches the composer of the named session and no other", () => {
    const mine = vi.fn();
    const other = vi.fn();
    const unsubscribeMine = subscribeComposerSubmitRequests("session-1", mine);
    const unsubscribeOther = subscribeComposerSubmitRequests("session-2", other);

    expect(requestComposerSubmit("session-1")).toBe(true);

    expect(other).not.toHaveBeenCalled();
    expect(mine).toHaveBeenCalledOnce();

    unsubscribeMine();
    unsubscribeOther();
  });

  it("reports a composer that was not there to take it", () => {
    const listener = vi.fn();

    subscribeComposerSubmitRequests("session-1", listener)();

    // Nothing is queued for a composer that is not mounted — an archived
    // Session has none at all — so the caller has to learn that the request
    // went nowhere and can say so instead of appearing to have sent it.
    expect(requestComposerSubmit("session-1")).toBe(false);
    expect(requestComposerSubmit("session-2")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
