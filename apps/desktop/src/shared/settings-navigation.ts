import { useRouter, useRouterState } from "@tanstack/react-router";

export type SettingsSection = "providers" | "models" | "mcp" | "chats" | "changelog" | "about";

export function parseSettingsSection(value: unknown): SettingsSection | null {
  return value === "providers" ||
    value === "models" ||
    value === "mcp" ||
    value === "chats" ||
    value === "changelog" ||
    value === "about"
    ? value
    : null;
}

/** Keep the current route mounted so opening settings cannot discard a session draft. */
export function useSettingsDialog() {
  const router = useRouter();
  const section = useRouterState({
    select: (state) =>
      parseSettingsSection(
        (state.location.search as { settings?: unknown }).settings,
      ),
  });

  const setSection = (next: SettingsSection | null) => {
    void router.navigate({
      search: ((previous: Record<string, unknown>) => {
        const { settings: _settings, ...search } = previous;
        return next ? { ...search, settings: next } : search;
      }) as never,
      hash: true,
      replace: true,
      resetScroll: false,
    });
  };

  return {
    section,
    openSettings: (next: SettingsSection = "providers") => setSection(next),
    closeSettings: () => setSection(null),
  };
}
