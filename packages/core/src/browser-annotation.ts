// Embedded browser annotations — what the user marked in design mode, and how
// it reaches Pi. The shapes are shared by the Electron main process, the
// annotation preload and the renderer; the formatter is what the model reads.
// Decision record: .scratch/embedded-browser/PRD.md (decision 5).

/**
 * The embedded page's own viewport when the marks were taken, not the panel's
 * rect: the marks are measured in this coordinate space, and the panel can be
 * resized between marking and sending.
 */
export type BrowserAnnotationViewport = {
  width: number;
  height: number;
  dpr: number;
};

/**
 * One element the user marked in design mode. Produced in the embedded page's
 * isolated world, validated in main, read by the renderer.
 *
 * There is no `reactName`: the isolated world shares the page's DOM but not
 * its JS wrappers, so React's `__reactFiber$` expando is simply not there
 * (PRD S2 implementation constraint 1). `source` is the best-effort stand-in,
 * read from whatever `data-*` attributes the dev server stamped.
 */
export type BrowserAnnotationElement = {
  /**
   * Stable identity for the annotation's lifetime, minted by the overlay
   * (`crypto.randomUUID()`). `index` renumbers on delete; `id` never changes.
   */
  id: string;
  /** 1-based; the number the marker shows in the page and on the screenshot. */
  index: number;
  selector: string;
  tag: string;
  text?: string;
  /** Viewport-relative, as measured when the element was marked. */
  rect: { x: number; y: number; width: number; height: number };
  source?: { file: string; line: number; column?: number };
  comment?: string;
};

export type BrowserAnnotationPayload = {
  url: string;
  title?: string;
  viewport: BrowserAnnotationViewport;
  elements: BrowserAnnotationElement[];
  capturedAt: string;
  /**
   * Whether a screenshot goes with this text. It changes what the prompt can
   * claim and how an element is located, so it is not the caller's to describe
   * in prose.
   */
  screenshot: boolean;
};

const headings = {
  withScreenshot:
    "Browser annotations from the embedded preview — the attached screenshot shows the same numbered markers.",
  withoutScreenshot:
    "Browser annotations from the embedded preview — no screenshot could be taken, so each mark carries its viewport rect instead.",
};

/**
 * One line of it. Main folds the same fields on the way in, but the template's
 * promise — one row per mark — is core's to keep for every caller of a public
 * function, not something to inherit from a well-behaved one.
 */
function oneLine(value: string) {
  return value.replace(/[\r\n]+/g, " ");
}

function formatSource(source: NonNullable<BrowserAnnotationElement["source"]>) {
  const file = oneLine(source.file);

  return source.column ? `${file}:${source.line}:${source.column}` : `${file}:${source.line}`;
}

function formatRect(rect: BrowserAnnotationElement["rect"]) {
  return `${rect.width}×${rect.height} at (${rect.x}, ${rect.y})`;
}

/**
 * The markdown block the `Send to composer` action drops into the draft.
 *
 * Fixed on purpose: this is the contract Pi reads, so the shape of it is
 * pinned by tests rather than tuned per call site. Text and comments arrive
 * already clamped (main rebuilds every annotation field by field), so nothing
 * is truncated a second time here.
 *
 * Rects appear only when the screenshot does not. With one, the numbered
 * markers are what locate an element and a rect measured before a scroll would
 * point somewhere else; without one, the rect is the only locator left.
 */
export function formatBrowserAnnotationPrompt(payload: BrowserAnnotationPayload) {
  const lines = [
    payload.screenshot ? headings.withScreenshot : headings.withoutScreenshot,
    "",
    `- URL: ${payload.url}`,
  ];

  if (payload.title) {
    lines.push(`- Title: ${payload.title}`);
  }

  lines.push(
    `- Viewport: ${payload.viewport.width}×${payload.viewport.height} @${payload.viewport.dpr}x`,
    `- Captured: ${payload.capturedAt}`,
  );

  for (const element of payload.elements) {
    // A mark with nothing said about it is still a mark: the user pointed at
    // it, and dropping the row would silently lose that.
    lines.push(
      "",
      `#${element.index} \`${oneLine(element.selector)}\` (${oneLine(element.tag)}) — ${
        element.comment ? oneLine(element.comment) : "(no comment)"
      }`,
    );

    if (!payload.screenshot) {
      lines.push(`  - rect: ${formatRect(element.rect)}`);
    }

    if (element.text) {
      lines.push(`  - text: "${oneLine(element.text)}"`);
    }

    if (element.source) {
      lines.push(`  - source: \`${formatSource(element.source)}\``);
    }
  }

  return lines.join("\n");
}
