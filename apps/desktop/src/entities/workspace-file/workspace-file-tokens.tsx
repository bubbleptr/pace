import { createElement } from "react";
import type {
  ChatComposerToken,
  ChatComposerTrigger,
  ChatComposerTriggerItem,
} from "@astryxdesign/core/Chat";
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { AUTOCOMPLETE_SEPARATOR_REGEX, type WorkspaceFileMatch } from "@pace/core";
import { FileIcon, FolderClosed } from "@/shared/ui/icons";
import type {
  ComposerInsertCatalog,
  ComposerInsertCatalogItem,
} from "@/shared/ui/composer-attachments/composer-insert-menu";

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The serialized form Pi sees for a file reference — identical to what the
 * Pi TUI's `buildCompletionValue` inserts: `@path`, `@"path"` when the path
 * contains a separator character, and a trailing `/` for directories. Pi
 * does not expand the reference; the model reads the file itself.
 */
export function fileReferenceText(match: WorkspaceFileMatch): string {
  const path = match.kind === "directory" ? `${match.path}/` : match.path;
  return AUTOCOMPLETE_SEPARATOR_REGEX.test(path) ? `@"${path}"` : `@${path}`;
}

/** Basename label shared by the trigger menu, the + palette, and the token. */
export function fileMatchLabel(match: WorkspaceFileMatch): string {
  const base = basenameOf(match.path);
  return match.kind === "directory" ? `${base}/` : base;
}

/**
 * The chip written into the composer for a file reference. `value` is the
 * serialized form (see fileReferenceText); the chip shows the basename.
 */
export function fileToken(match: WorkspaceFileMatch): ChatComposerToken {
  return {
    value: fileReferenceText(match),
    label: fileMatchLabel(match),
    variant: "cyan",
    icon: createElement(match.kind === "directory" ? FolderClosed : FileIcon, {
      size: 16,
      "aria-hidden": true,
    }),
  };
}

/** Catalog id of the + menu's "Reference file" group. */
export const FILE_INSERT_CATALOG_ID = "files";

/** Palette row shape for a match: basename label, full path as description. */
export function fileSearchItem(match: WorkspaceFileMatch): ComposerInsertCatalogItem {
  return {
    id: match.path,
    label: fileMatchLabel(match),
    description: match.path,
  };
}

/**
 * The + menu's async "Reference file" group. `search` returns palette rows
 * AND is expected to record the matches behind them so onPick can map the
 * picked id (a path) back to its WorkspaceFileMatch.
 */
export function fileInsertCatalog(
  search: (query: string) => Promise<readonly ComposerInsertCatalogItem[]>,
): ComposerInsertCatalog {
  return {
    id: FILE_INSERT_CATALOG_ID,
    label: "Reference file",
    icon: createElement(FolderClosed, { "aria-hidden": true }),
    searchLabel: "Search files",
    emptyText: "No matching files",
    search,
  };
}

/** A promise that never settles — see search() below. */
const never = new Promise<never>(() => {});

// useTriggerMenu probes `searchSource.search("")` on every keystroke to
// decide whether the source is async, then discards the result. Caching the
// empty-query answer keeps that probe from hitting the backend each time.
const EMPTY_PROBE_TTL_MS = 10_000;

/**
 * The "@" autocomplete for the composer, backed by search_workspace_files.
 * Astryx commits whichever search promise settles last, so a superseded
 * query must never settle — cancel()/generation guards keep stale results
 * from clobbering the newer list.
 */
export function atTrigger(
  search: (query: string) => Promise<WorkspaceFileMatch[]>,
  options?: { now?: () => number },
): ChatComposerTrigger {
  const now = options?.now ?? Date.now;
  let generation = 0;
  let emptyCache: { at: number; promise: Promise<WorkspaceFileMatch[]> } | null =
    null;

  const toItem = (match: WorkspaceFileMatch): SearchableItem => ({
    id: match.path,
    label: fileMatchLabel(match),
    auxiliaryData: { match },
  });

  const guard = (
    gen: number,
    promise: Promise<WorkspaceFileMatch[]>,
  ): Promise<SearchableItem[]> =>
    promise.then(
      (items) => (gen === generation ? items.map(toItem) : never),
      // Astryx discards its async probe; resolve failures so it cannot leak
      // an unhandled rejection, and keep stale failures from clearing results.
      () => (gen === generation ? [] : never),
    );

  const cancel = () => {
    generation += 1;
  };

  const searchSource: SearchSource = {
    cancel,
    bootstrap() {
      return [];
    },
    search(query) {
      cancel();
      if (query === "") {
        if (!emptyCache || now() - emptyCache.at >= EMPTY_PROBE_TTL_MS) {
          emptyCache = { at: now(), promise: search("") };
        }
        return guard(generation, emptyCache.promise);
      }
      return guard(generation, search(query));
    },
  };

  return {
    character: "@",
    searchSource,
    renderItem: (item: ChatComposerTriggerItem) => {
      const data = item.auxiliaryData as { match: WorkspaceFileMatch } | undefined;
      const Icon = data?.match.kind === "directory" ? FolderClosed : FileIcon;
      return (
        <VStack gap={0.5} style={{ minWidth: 0, width: "100%" }}>
          <HStack align="center" gap={1.5}>
            {createElement(Icon, { size: 16, "aria-hidden": true, style: { flexShrink: 0 } })}
            <Text maxLines={1}>{item.label}</Text>
          </HStack>
          {data ? (
            <Text color="secondary" maxLines={1} size="sm" type="body">
              {data.match.path}
            </Text>
          ) : null}
        </VStack>
      );
    },
    onSelect: (item) => {
      const data = item.auxiliaryData as { match: WorkspaceFileMatch } | undefined;
      return data ? fileToken(data.match) : `@${item.label}`;
    },
    emptySearchResultsText: "No matching files",
    loadingText: "Searching files…",
  };
}
