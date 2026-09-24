import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, VStack } from "@astryxdesign/core";
import type { ConfigInventory } from "@pace/core";
import { AppFrame } from "@/widgets/app-frame";
import { invoke } from "@/shared/runtime";
import { useRefreshOnWindowFocus } from "@/shared/refresh";
import { Marketplace } from "./packages/marketplace";
import { PackageManagement } from "./packages/resources";

export function SetupPage() {
  const navigate = useNavigate();
  const inventory = useQuery({ queryKey: ["config-inventory"], queryFn: () => invoke<ConfigInventory>("get_config_inventory") });
  useRefreshOnWindowFocus(() => inventory.refetch());
  return <AppFrame>
    {inventory.data ? <PackageManagement inventory={inventory.data}><Marketplace inventory={inventory.data} refreshing={inventory.isFetching} onRefresh={() => void inventory.refetch()} onEnvironmentCheck={() => void navigate({ to: "/preflight" })} /></PackageManagement> : <VStack padding={8}>
      <EmptyState title={inventory.isError ? "Could not read Pi configuration" : "Loading packages…"} description={inventory.isError ? inventory.error.message : undefined} actions={inventory.isError ? <Button label="Retry configuration" onClick={() => void inventory.refetch()} /> : undefined} />
    </VStack>}
  </AppFrame>;
}
