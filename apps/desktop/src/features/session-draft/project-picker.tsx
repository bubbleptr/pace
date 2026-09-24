import { Selector } from "@astryxdesign/core/Selector";
import {
  CHAT_PICKER_LABEL,
  CHAT_PROJECT_ID,
  chatWorkspaceListEntry,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import { type ProjectRegistryEntry } from "@/entities/project/project-registry";
import { ChatAdd, FolderClosed } from "@/shared/ui/icons";

export function ProjectPicker({
  projects,
  selectedProjectId,
  onProjectChange,
  error,
}: {
  projects: ProjectRegistryEntry[];
  selectedProjectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  error?: boolean;
}) {
  const selectedProject = isChatProjectId(selectedProjectId)
    ? chatWorkspaceListEntry()
    : projects.find((project) => project.id === selectedProjectId);
  const selectedPickerKey = selectedProject?.id;
  const StartIcon = isChatProjectId(selectedProjectId) ? ChatAdd : FolderClosed;

  return (
    <div className="max-w-full" data-testid="project-picker">
      <Selector
        data-testid="project-picker-trigger"
        isLabelHidden
        label="Project"
        placeholder="Choose a project"
        placement="below"
        status={error ? { type: "error", message: "Choose a project or select No project to continue." } : undefined}
        options={[
          {
            value: CHAT_PROJECT_ID,
            label: CHAT_PICKER_LABEL,
            icon: (
              <ChatAdd
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          },
          ...projects.map((project) => ({
            value: project.id,
            label: project.displayName,
            icon: (
              <FolderClosed
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          })),
        ]}
        size="sm"
        startIcon={
          <StartIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted"
            data-testid="project-picker-folder-icon"
          />
        }
        value={selectedPickerKey}
        variant="ghost"
        onChange={(value) => {
          onProjectChange(value);
        }}
      />
    </div>
  );
}
