import { Selector, SelectorOption } from "@astryxdesign/core/Selector";
import type { CreateSessionFromDraftInput } from "@/entities/session/session-creation";
import type { SessionDraftCheckoutMode } from "@/entities/session/session-drafts";
import { Computer, FolderLibrary } from "@/shared/ui/icons";

export const checkoutModeLabels: Record<SessionDraftCheckoutMode, string> = {
  local: "Project folder",
  worktree: "Git worktree",
};

export function checkoutModeToExecutionMode(
  checkoutMode: SessionDraftCheckoutMode,
): CreateSessionFromDraftInput["executionMode"] {
  return checkoutMode === "worktree" ? "background" : "foreground";
}

export function CheckoutStrategyPicker({
  selectedCheckoutMode,
  onCheckoutModeChange,
}: {
  selectedCheckoutMode: SessionDraftCheckoutMode;
  onCheckoutModeChange: (checkoutMode: SessionDraftCheckoutMode) => void;
}) {
  return (
    <div className="max-w-full" data-testid="checkout-strategy-picker">
      <Selector
        data-testid="checkout-strategy-trigger"
        isLabelHidden
        label="Where to work"
        placement="below"
        renderOption={(option) => (
          <SelectorOption label={option.label} icon={option.icon}
            description={option.value === "local"
              ? "Edit files directly in the selected project."
              : "Create a separate Git worktree for this chat."} />
        )}
        options={[
          {
            value: "local",
            label: checkoutModeLabels.local,
            icon: (
              <Computer
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
                data-testid="checkout-strategy-local-icon"
              />
            ),
          },
          {
            value: "worktree",
            label: checkoutModeLabels.worktree,
            icon: (
              <FolderLibrary
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          },
        ]}
        size="sm"
        startIcon={
          selectedCheckoutMode === "worktree" ? (
            <FolderLibrary
              aria-hidden="true"
              className="size-4 shrink-0 text-muted"
            />
          ) : (
            <Computer
              aria-hidden="true"
              className="size-4 shrink-0 text-muted"
              data-testid="checkout-strategy-local-icon"
            />
          )
        }
        value={selectedCheckoutMode}
        variant="ghost"
        onChange={(value) => {
          onCheckoutModeChange(value === "worktree" ? "worktree" : "local");
        }}
      />
    </div>
  );
}
