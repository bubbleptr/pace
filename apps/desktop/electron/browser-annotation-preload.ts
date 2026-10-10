import { ipcRenderer } from "electron";
import {
  browserAnnotationChannel,
  browserAnnotationCommandChannel,
  type BrowserAnnotationCommand,
} from "./browser-annotation";
import { createAnnotationOverlay } from "./browser-annotation-overlay";

/**
 * Preload for the embedded browser's `WebContentsView` — and nothing else.
 *
 * A preload already runs in an isolated world, so the overlay it builds is
 * invisible to page script without any bridging. That is the whole design:
 * **nothing is exposed to the page**. There is no `contextBridge` call here,
 * because a hostile page with a handle on any Pace API is exactly what the
 * annotation layer must not create. Traffic goes one way, over a channel of
 * its own that main re-validates on arrival (PRD S2 constraint 2) — never over
 * `pigui:invoke`, which is scoped to the main window's own sender and speaks
 * a different, command-shaped protocol.
 *
 * It also shares no module with `preload.ts`: electron-vite would hoist a
 * common import into a chunk, and a sandboxed preload cannot require one
 * (PRD S2 constraint 6). The build output has to stay two self-contained files.
 */

const overlay = createAnnotationOverlay({
  document,
  onAnnotationSaved(annotation, viewport) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "annotation-saved",
      annotation,
      viewport,
    });
  },
  onAnnotationDeleted(id) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "annotation-deleted",
      id,
    });
  },
  onAnnotationPresence(id, stale) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "annotation-presence",
      id,
      stale,
    });
  },
  onDesignModeChange(enabled) {
    ipcRenderer.send(browserAnnotationChannel, { type: "design-mode", enabled });
  },
  onCaptureReady(annotations, viewport) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "capture-ready",
      annotations,
      viewport,
    });
  },
});

ipcRenderer.on(
  browserAnnotationCommandChannel,
  (_event, command: BrowserAnnotationCommand) => {
    switch (command?.type) {
      case "set-design-mode":
        overlay.setDesignMode(command.enabled === true, command.palette);
        break;
      case "set-annotation-palette":
        overlay.setAnnotationPalette(command.palette);
        break;
      case "sync-annotations":
        overlay.syncAnnotations(
          Array.isArray(command.annotations) ? command.annotations : [],
        );
        break;
      case "prepare-capture":
        overlay.prepareCapture();
        break;
      case "capture-done":
        overlay.finishCapture();
        break;
    }
  },
);

// Every navigation builds a new document with a new overlay. Announcing it is
// what lets main put design mode back and tell the renderer the marks are gone.
ipcRenderer.send(browserAnnotationChannel, { type: "ready" });
