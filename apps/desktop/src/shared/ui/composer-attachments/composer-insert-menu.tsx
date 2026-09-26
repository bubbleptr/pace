import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ImageIcon, Plus } from "@/shared/ui/icons";

/**
 * One searchable group in the composer's + menu — who fills it (prompt
 * commands, workspace files) is the caller's domain; the menu only renders.
 */
export type ComposerInsertCatalogItem = {
  id: string;
  label: string;
  description?: string;
};

export type ComposerInsertCatalog = {
  /** Stable id passed back to onPick. */
  id: string;
  /** First-level menu item, e.g. "Skills". */
  label: string;
  icon: ReactNode;
  /** Search field accessible label, e.g. "Search skills". */
  searchLabel: string;
  /** Empty-result text, e.g. "No matching skills". */
  emptyText: string;
  /** Static entries — exactly one of `items` / `search` is given. */
  items?: readonly ComposerInsertCatalogItem[];
  /**
   * Backend-backed lookup. A search catalog is always listed — its entries
   * are unknown until the user types.
   */
  search?: (query: string) => Promise<readonly ComposerInsertCatalogItem[]>;
};

type ComposerInsertMenuOwnProps = {
  /**
   * Groups listed after "Add files" in given order; empty catalogs are
   * hidden. Selecting an item reports (catalogId, itemId) via onPick.
   */
  catalogs?: readonly ComposerInsertCatalog[];
  onAttach: () => void;
  onPick: (catalogId: string, itemId: string) => void;
};

export type ComposerInsertMenuProps = Omit<
  ComponentProps<typeof DropdownMenu>,
  keyof ComposerInsertMenuOwnProps | "items" | "button" | "children"
> &
  ComposerInsertMenuOwnProps;

export function ComposerInsertMenu({
  catalogs = [],
  onAttach,
  onPick,
  className,
  ...rest
}: ComposerInsertMenuProps) {
  const [openCatalogId, setOpenCatalogId] = useState<string | null>(null);
  // Static groups hide when empty; a search-backed group is always listed
  // since its entries are only known by querying.
  const listedCatalogs = catalogs.filter(
    (catalog) => catalog.search !== undefined || (catalog.items?.length ?? 0) > 0,
  );
  const openCatalog = listedCatalogs.find((catalog) => catalog.id === openCatalogId);
  const source = useMemo(() => {
    if (openCatalog?.search) {
      const search = openCatalog.search;
      // The palette already guards stale results by version, so a thin
      // async source is enough.
      return {
        bootstrap: () => [],
        search: async (query: string) =>
          (await search(query)).map((item) => ({
            id: item.id,
            label: item.label,
            auxiliaryData: { description: item.description },
          })),
      };
    }
    return createStaticSource(
      (openCatalog?.items ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        auxiliaryData: { description: item.description },
      })),
      { keywords: (item) => [item.auxiliaryData.description ?? ""] },
    );
  }, [openCatalog]);

  return (
    <>
      <DropdownMenu
        alignment="start"
        hasChevron={false}
        placement="above"
        button={{ icon: <Plus aria-hidden="true" />, isIconOnly: true,
          className, label: "Add to prompt", size: "sm", tooltip: "Add to prompt", variant: "ghost" }}
        {...rest}
        items={[
          {
            icon: (
              <HStack as="span" className="pigui-compact-menu-item-icon text-muted" aria-hidden="true">
                <ImageIcon />
              </HStack>
            ),
            label: "Add files",
            onClick: onAttach,
          },
          ...listedCatalogs.map((catalog) => ({
            icon: (
              <HStack as="span" className="pigui-compact-menu-item-icon text-muted" aria-hidden="true">
                {catalog.icon}
              </HStack>
            ),
            label: catalog.label,
            onClick: () => setOpenCatalogId(catalog.id),
          })),
        ]}
      />
      {openCatalog ? (
        <CommandPalette
          isOpen
          label={openCatalog.label}
          input={
            <CommandPaletteInput
              label={openCatalog.searchLabel}
              placeholder={`${openCatalog.searchLabel}…`}
              // Portal clicks still bubble to ChatComposer, whose body
              // click handler would move focus back to the prompt.
              onClick={(event) => event.stopPropagation()}
            />
          }
          searchSource={source}
          emptySearchText={openCatalog.emptyText}
          emptyBootstrapText={openCatalog.emptyText}
          renderItem={(item) => (
            <VStack gap={0.5}>
              <Text>{item.label}</Text>
              {item.auxiliaryData.description ? (
                <Text color="secondary" type="body" size="sm" maxLines={2}>
                  {item.auxiliaryData.description}
                </Text>
              ) : null}
            </VStack>
          )}
          onOpenChange={(open) => { if (!open) setOpenCatalogId(null); }}
          onValueChange={(itemId) => onPick(openCatalog.id, itemId)}
        />
      ) : null}
    </>
  );
}
