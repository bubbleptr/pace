import { useQuery } from "@tanstack/react-query";
import type { ProviderAuthStatusReport } from "@pace/core";
import { invoke } from "@/shared/runtime";

/** Shared with Settings so a credential write refreshes every mounted reader. */
export const providerAuthStatusQueryKey = ["provider-auth-status"] as const;

/**
 * Provider credential status. Fail-open (treat as configured) when the
 * backend cannot answer so tests / offline shells stay usable.
 */
export function useProviderAuthStatus() {
  const query = useQuery({
    queryKey: providerAuthStatusQueryKey,
    queryFn: () => invoke<ProviderAuthStatusReport>("list_provider_auth_status"),
    retry: false,
  });

  return {
    report: query.data ?? null,
    loading: query.isPending,
    configured: query.isError || (query.data?.configuredCount ?? 0) > 0,
  };
}
