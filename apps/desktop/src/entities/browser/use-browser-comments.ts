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
 * subscribed before the initial list goes out, and an event that arrived
 * before the reply wins: it is newer than whatever the reply was about to say.
 */
export function useBrowserComments(sessionId: string | null) {
  const [comments, setComments] = useState<BrowserComment[]>([]);
  const latestRef = useRef<BrowserComment[]>([]);

  useEffect(() => {
    latestRef.current = [];
    setComments([]);

    if (!sessionId || !isElectronRuntime()) {
      return;
    }

    let alive = true;
    let sawEvent = false;

    const unsubscribe = subscribeBrowserEvents((event) => {
      if (
        event.type !== "comments-changed" ||
        event.sessionId !== sessionId ||
        !alive
      ) {
        return;
      }

      sawEvent = true;
      latestRef.current = event.comments;
      setComments(event.comments);
    });

    void listBrowserComments(sessionId)
      .then((fetched) => {
        if (!alive || sawEvent || !fetched) {
          return;
        }
        latestRef.current = fetched;
        setComments(fetched);
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
