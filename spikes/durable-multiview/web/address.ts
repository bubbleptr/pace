export const DEFAULT_HOST_URL = "ws://127.0.0.1:7420";

/**
 * The host address from the page's fragment, `#token=...&url=...`. The fragment
 * never reaches the dev server, so the token stays between the host's printed
 * link and this tab.
 */
export function addressFromHash(hash: string): { url: string; token: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token === null || token === "") return undefined;
  return { url: params.get("url") ?? DEFAULT_HOST_URL, token };
}
