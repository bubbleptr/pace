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

/**
 * A saved annotation as the Session-level comment store hands it out. The
 * page element it describes (`selector`/`tag`/`rect`/`comment`) is the
 * annotation's own shape; the fields here pin it to a tab, a document and a
 * moment. `index` is its 1-based position in the Session's comment order and
 * is recomputed on every read — a badge number only ever means "the nth
 * comment kept for this Session".
 *
 * In the composer, `hasImage` means "a screenshot of this comment is attached
 * to the message about to be sent" — the composer overrides it with what it
 * actually fetched.
 */
export type BrowserComment = BrowserAnnotationElement & {
  tabId: string;
  /** Page URL when saved; documents sharing it (`urlKey`) get the marker back. */
  url: string;
  title: string;
  /** The viewport the rect was measured in. */
  viewport: BrowserAnnotationViewport;
  /** The last restore attempt could not find the element in the document. */
  stale: boolean;
  /** A cropped screenshot was taken for it. */
  hasImage: boolean;
  createdAt: string;
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
 * The comment body as indented lines: blank lines dropped, the rest kept in
 * the commenter's own spacing. A comment that reduces to nothing is still
 * said about — the mark exists whether or not the text does.
 */
function commentBodyLines(comment: string | undefined) {
  const lines = (comment ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return lines.length
    ? lines.map((line) => `  ${line}`)
    : ["  (no comment)"];
}

/**
 * The text block the composer appends to a message that carries browser
 * comments. Fixed on purpose: this is the contract Pi reads, so its shape is
 * pinned by tests rather than tuned per call site.
 *
 * Comments arrive in store order — they are rendered exactly so, grouped by
 * nothing, with a `Page:` block reopening whenever the URL changes so a
 * comment going back to an earlier page gets its own context again. A rect is
 * only printed when no screenshot can say where the element is better; a
 * stale comment is flagged rather than presented as current truth.
 */
export function formatBrowserComments(comments: readonly BrowserComment[]) {
  const lines = [
    comments.some((comment) => comment.hasImage)
      ? "Browser comments from the embedded preview. A comment marked [screenshot] has a cropped screenshot of its element attached; those screenshots are the last images in this message, in comment order."
      : "Browser comments from the embedded preview.",
  ];
  let previousUrl: string | null = null;

  for (const comment of comments) {
    if (comment.url !== previousUrl) {
      previousUrl = comment.url;
      lines.push(
        "",
        comment.title
          ? `Page: ${oneLine(comment.title)} — ${oneLine(comment.url)}`
          : `Page: ${oneLine(comment.url)}`,
        `Viewport: ${comment.viewport.width}×${comment.viewport.height} @${comment.viewport.dpr}x`,
      );
    }

    lines.push(
      "",
      `#${comment.index}${comment.hasImage ? " [screenshot]" : ""} \`${oneLine(comment.selector)}\` (${oneLine(comment.tag)})`,
      ...commentBodyLines(comment.comment),
    );

    if (comment.text) {
      lines.push(`  - text: "${oneLine(comment.text)}"`);
    }
    if (comment.source) {
      lines.push(`  - source: \`${formatSource(comment.source)}\``);
    }
    if (!comment.hasImage) {
      lines.push(`  - rect: ${formatRect(comment.rect)}`);
    }
    if (comment.stale) {
      lines.push(
        "  - stale: not found on the page when last checked; described as it was when saved",
      );
    }
  }

  return lines.join("\n");
}
