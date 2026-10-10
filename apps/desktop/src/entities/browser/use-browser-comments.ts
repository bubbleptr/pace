import { useEffect, useRef, useState } from "react";
import type { BrowserComment } from "@/shared/browser-protocol";
import { isElectronRuntime } from "@/shared/runtime";
import {
  listBrowserComments,
  subscribeBrowserEvents,
} from "@/entities/browser/browser-client";

/**
 * The Session's browser comments for the composer drawer and its send path.
 *
 * `comments` renders the chips; `latest()` is what a submit snapshots — it
 * reads the ref the event handler writes synchronously, because a save that
 * landed inside the same tick as the send has to be in it. Events are
 * subscribed before the initial list goes out, and every answer is stamped
 * with the store's revision: anything older than the last one applied is
 * dropped, whether it is a late reply or a replayed event.
 *
 * `onSubmitRequested` is the page's Cmd/Ctrl+Enter: the event's own channel
 * delivers it, so a send survives the Browser panel being closed. The
 * callback lives in a ref — the subscription does not move per keystroke.
 */
export function useBrowserComments(
  sessionId: string | null,
  options?: { onSubmitRequested?: () => void },
) {
  const [comments, setComments] = useState<BrowserComment[]>([]);
  const latestRef = useRef<BrowserComment[]>([]);
  const appliedRef = useRef(0);
  const onSubmitRequestedRef = useRef(options?.onSubmitRequested);
  onSubmitRequestedRef.current = options?.onSubmitRequested;

  useEffect(() => {
    latestRef.current = [];
    appliedRef.current = 0;
    setComments([]);

    if (!sessionId || !isElectronRuntime()) {
      return;
    }

    let alive = true;

    const unsubscribe = subscribeBrowserEvents((event) => {
      if (!alive) {
        return;
      }

      if (event.type === "submit-requested") {
        if (event.sessionId === sessionId) {
          onSubmitRequestedRef.current?.();
        }
        return;
      }

      if (
        event.type !== "comments-changed" ||
        event.sessionId !== sessionId ||
        event.revision <= appliedRef.current
      ) {
        return;
      }

      appliedRef.current = event.revision;
      latestRef.current = event.comments;
      setComments(event.comments);
    });

    void listBrowserComments(sessionId)
      .then((fetched) => {
        if (!alive || !fetched || fetched.revision <= appliedRef.current) {
          return;
        }
        appliedRef.current = fetched.revision;
        latestRef.current = fetched.comments;
        setComments(fetched.comments);
      })
      // A failed read leaves the list empty; the next comments-changed
      // repopulates it.
      .catch(() => {});

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [sessionId]);

  return { comments, latest: () => latestRef.current };
}
