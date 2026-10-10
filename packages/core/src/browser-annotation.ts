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
  /**
   * Present only for an area comment: the dragged rectangle relative to the
   * anchor element's border-box top-left in its scrolled content — i.e. plus
   * the anchor's `scrollLeft`/`scrollTop` at save time, except when the
   * anchor is the document's scrolling element (its rect already rides the
   * page scroll). `selector`/`tag`/`source` then describe the anchor
   * (smallest element fully containing the area); `rect` is the area's own
   * viewport rect when saved.
   */
  area?: { x: number; y: number; width: number; height: number };
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The crop saved with a comment: the element plus enough surroundings to
 * read, grown to a useful minimum, kept inside the viewport it was measured
 * in. Shifted before clipped — a crop near an edge keeps its full size if it
 * can be moved inside rather than shrunk.
 *
 * Lives in core because both ends of the crop need it: main to take the shot,
 * the formatter to name an area's bounds in the shot's own coordinates.
 */
export function resolveCommentCropRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const margin = 48;
  let x = rect.x - margin;
  let y = rect.y - margin;
  let width = rect.width + margin * 2;
  let height = rect.height + margin * 2;

  if (width < 320) {
    x -= (320 - width) / 2;
    width = 320;
  }
  if (height < 200) {
    y -= (200 - height) / 2;
    height = 200;
  }

  if (width <= viewport.width) {
    x = clamp(x, 0, viewport.width - width);
  } else {
    x = 0;
    width = viewport.width;
  }
  if (height <= viewport.height) {
    y = clamp(y, 0, viewport.height - height);
  } else {
    y = 0;
    height = viewport.height;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

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

    const marker = `#${comment.index}${comment.hasImage ? " [screenshot]" : ""}`;

    lines.push(
      "",
      comment.area
        ? `${marker} area in \`${oneLine(comment.selector)}\` (${oneLine(comment.tag)})`
        : `${marker} \`${oneLine(comment.selector)}\` (${oneLine(comment.tag)})`,
      ...commentBodyLines(comment.comment),
    );

    // An area's anchor text would name the element, not the marked region.
    if (!comment.area && comment.text) {
      lines.push(`  - text: "${oneLine(comment.text)}"`);
    }
    if (comment.source) {
      lines.push(`  - source: \`${formatSource(comment.source)}\``);
    }
    // An area always prints its bounds: its crop has margins and no drawn
    // box, so even a screenshot cannot say where exactly the region was.
    // With a screenshot the bounds come twice — in the shot's own
    // coordinates (1 image px is 1 CSS px after the CSS-width downsample,
    // and the crop may have been shifted by a viewport edge) and in the
    // viewport's.
    if (comment.area) {
      if (comment.hasImage) {
        const crop = resolveCommentCropRect(comment.rect, comment.viewport);
        const inCrop = {
          ...comment.rect,
          x: comment.rect.x - crop.x,
          y: comment.rect.y - crop.y,
        };
        lines.push(
          `  - area: ${formatRect(inCrop)} in its screenshot; (${comment.rect.x}, ${comment.rect.y}) in the viewport`,
        );
      } else {
        lines.push(`  - area: ${formatRect(comment.rect)}`);
      }
    } else if (!comment.hasImage) {
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
