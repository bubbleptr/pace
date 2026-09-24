import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { SessionChanges } from "@pace/core";
import { useState } from "react";
import { Check, ChevronDown, GitBranch } from "@/shared/ui/icons";

function gitBranchPickerLabel(input: {
  branch: string | null;
  detached: boolean;
  oid: string | null;
}) {
  if (input.branch) {
    return input.branch;
  }

  // Detached HEAD has no branch name; the short oid is the only identity.
  if (input.detached) {
    return input.oid ? input.oid.slice(0, 7) : "HEAD";
  }

  return null;
}

export function gitBranchPickerLabelFromChanges(changes: SessionChanges | null) {
  if (!changes || changes.state === "non-git") {
    return null;
  }

  return gitBranchPickerLabel({
    branch: changes.head?.branch ?? null,
    detached: changes.head?.detached ?? false,
    oid: changes.head?.oid ?? null,
  });
}

function checkoutPathLabel(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function occupiedBranchHint(path: string) {
  return `Already checked out in ${checkoutPathLabel(path)}`;
}

function gitBranchPickerOptions(
  branch: string,
  branches: string[],
  occupiedBranches: Array<{ branch: string; path: string }>,
) {
  const occupied = new Map(
    occupiedBranches.map((item) => [item.branch, item.path]),
  );
  const names = [branch, ...branches.filter((name) => name !== branch)];

  return names.map((name) => ({
    value: name,
    label: name,
    disabled: occupied.has(name),
  }));
}

/**
 * Live-composer counterpart of ProjectPicker's ghost chip, with the searchable
 * menu chrome of ModelSelectorControl: `gap-1 p-1` around the field and list,
 * balanced rows so names are not flush against the popover edge. Selecting a
 * remote-only name creates a local tracking branch; occupied worktrees stay
 * visible but unselectable.
 */
export function GitBranchPicker({
  branch,
  branches,
  occupiedBranches,
  triggerLabel = branch,
  onBranchChange,
}: {
  branch: string;
  branches: string[];
  occupiedBranches: Array<{ branch: string; path: string }>;
  /** What the chip reads; a worktree's base says "from <branch>". */
  triggerLabel?: string;
  onBranchChange: (branch: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const options = gitBranchPickerOptions(branch, branches, occupiedBranches);
  const needle = query.trim().toLowerCase();
  const listed = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  return (
    <div className="min-w-0 max-w-full" data-testid="git-branch-status">
      <Popover
        alignment="start"
        isOpen={isOpen}
        label="Git branch"
        placement="above"
        content={
          <div
            className="flex w-full flex-col gap-1 p-1"
            data-testid="git-branch-status-menu"
          >
            <TextInput
              isLabelHidden
              label="Search branches"
              placeholder="Search branches..."
              size="sm"
              value={query}
              width="100%"
              onChange={setQuery}
            />
            <List
              aria-label="Git branch"
              className="max-h-72 overflow-y-auto"
              density="balanced"
            >
              {listed.map((option) => {
                const occupied = occupiedBranches.find(
                  (item) => item.branch === option.value,
                );
                return (
                  <ListItem
                    description={
                      occupied ? occupiedBranchHint(occupied.path) : undefined
                    }
                    endContent={
                      option.value === branch ? (
                        <Check aria-hidden="true" className="size-4 shrink-0" />
                      ) : undefined
                    }
                    isDisabled={option.disabled}
                    isSelected={option.value === branch}
                    key={option.value}
                    label={option.label}
                    role="option"
                    startContent={
                      <GitBranch
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted"
                      />
                    }
                    onClick={() => {
                      if (option.disabled || option.value === branch) {
                        return;
                      }

                      onBranchChange(option.value);
                      setIsOpen(false);
                      setQuery("");
                    }}
                  />
                );
              })}
            </List>
          </div>
        }
        onOpenChange={(open) => {
          setIsOpen(open);
          if (!open) {
            setQuery("");
          }
        }}
      >
        <Button
          className="min-w-0 max-w-full flex-nowrap gap-1.5 px-2 text-muted"
          data-testid="git-branch-status-trigger"
          label="Git branch"
          size="sm"
          variant="ghost"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch
              aria-hidden="true"
              className="size-4 shrink-0"
              data-testid="git-branch-status-icon"
            />
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </span>
        </Button>
      </Popover>
    </div>
  );
}
