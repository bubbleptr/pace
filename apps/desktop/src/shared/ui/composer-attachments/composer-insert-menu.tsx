import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ImageIcon, Plus } from "@/shared/ui/icons";

/**
 * One searchable group in the composer's + menu — who fills it (prompt
 * commands, workspace files) is the caller's domain; the menu only renders.
 */
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
  items: readonly { id: string; label: string; description?: string }[];
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
  const listedCatalogs = catalogs.filter((catalog) => catalog.items.length > 0);
  const openCatalog = listedCatalogs.find((catalog) => catalog.id === openCatalogId);
  const source = useMemo(
    () =>
      createStaticSource(
        (openCatalog?.items ?? []).map((item) => ({
          id: item.id,
          label: item.label,
          auxiliaryData: { description: item.description },
        })),
        { keywords: (item) => [item.auxiliaryData.description ?? ""] },
      ),
    [openCatalog],
  );

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
          { icon: <ImageIcon />, label: "Add files", onClick: onAttach },
          ...listedCatalogs.map((catalog) => ({
            icon: catalog.icon,
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
