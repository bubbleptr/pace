import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderWithoutQuery } from "@testing-library/react";
import { SessionProjectionsStoreProvider } from "@/entities/session/use-session-projections";
import { type SessionProjectionsStore } from "@/entities/session/session-projections-store";

// `store` hands the view a Session Projections store the test drives, as the
// app provider does.
export function render(
  ui: Parameters<typeof renderWithoutQuery>[0],
  { store }: { store?: SessionProjectionsStore } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = renderWithoutQuery(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        {store ? (
          <SessionProjectionsStoreProvider store={store} runtimeGeneration={0}>
            {children}
          </SessionProjectionsStoreProvider>
        ) : children}
      </QueryClientProvider>
    ),
  });
  return Object.assign(result, { queryClient });
}
