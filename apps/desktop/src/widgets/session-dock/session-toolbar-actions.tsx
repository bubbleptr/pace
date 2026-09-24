import { SessionDockTrigger } from "@/shared/ui/session-dock/session-dock";

export function SessionToolbarActions({
  dockOpen = false,
  onDockOpenChange = () => {},
}: {
  dockOpen?: boolean;
  onDockOpenChange?: (isOpen: boolean) => void;
}) {
  return <SessionDockTrigger alignToRail isOpen={dockOpen} onOpenChange={onDockOpenChange} />;
}
