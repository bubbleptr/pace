// Provider auth contracts for Pace Settings (DF-002 / S3).
// Credentials live in Pi's auth.json via AuthStorage; this package only
// defines the IPC-facing status shape (never raw secrets). Provider ids
// come from the bundled Pi runtime, not a hard-coded catalog.

export type ProviderAuthId = string;

export type ProviderAuthMode = "none" | "api_key" | "oauth";

export type ProviderAuthStatusItem = {
  id: ProviderAuthId;
  label: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  mode: ProviderAuthMode;
  configured: boolean;
  /** Masked hint only, e.g. "…ae1d". Never a full key. */
  keyHint?: string;
  statusLabel?: string;
};

export type ProviderAuthStatusReport = {
  agentDir: string;
  authPath: string;
  providers: ProviderAuthStatusItem[];
  configuredCount: number;
};

/** Labels Pace keeps when they differ from Pi's provider.name. */
export const PROVIDER_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = {
  "openai-codex": "ChatGPT / Codex",
  xai: "Grok (xAI)",
};

export const FEATURED_PROVIDER_ORDER: readonly string[] = [
  "openai-codex",
  "anthropic",
  "radius",
  "openai",
  "deepseek",
  "xai",
  "google",
  "github-copilot",
  "openrouter",
];

const featuredIndex = new Map(
  FEATURED_PROVIDER_ORDER.map((id, index) => [id, index]),
);

/** Configured first, then featured order, then alphabetical by label. */
export function sortProvidersForDisplay<
  T extends { id: string; label: string; configured: boolean },
>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }

    const leftFeatured = featuredIndex.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightFeatured = featuredIndex.get(right.id) ?? Number.POSITIVE_INFINITY;
    if (leftFeatured !== rightFeatured) {
      return leftFeatured - rightFeatured;
    }

    return left.label.localeCompare(right.label, "en");
  });
}

export type ProviderFailureKind = "auth" | "entitlement" | "network" | "unknown";

export type ProviderConnectionTestResult =
  | { ok: true; modelId: string; latencyMs: number }
  | {
      ok: false;
      kind: ProviderFailureKind;
      message: string;
      /** Absent when the probe could not choose a model. */
      modelId?: string;
    };

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type ProviderFailureDetail = {
  status?: number;
  networkCode?: string;
  message: string;
};

function ownMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * pi-ai folds SDK errors into `errorMessage` and only keeps a numeric status
 * when `formatProviderError` prefixes it. The fields below are the ones
 * `normalizeProviderError` reads before that formatting, in the same order
 * (`error-body.js` `extractStatus`): Mistral `statusCode`, OpenAI / Google
 * `status`, Bedrock `$metadata.httpStatusCode`, Bedrock `$response.statusCode`.
 * `fetch` puts the socket code on `error.cause`, so the walk follows `cause`.
 */
function inspectProviderFailure(error: unknown, depth = 0): ProviderFailureDetail {
  if (depth > 4) return { message: "" };

  const message = ownMessage(error);
  if (!error || typeof error !== "object") return { message };

  const record = error as Record<string, unknown>;
  const status = httpStatus(record);
  const code = typeof record.code === "string" && NETWORK_CODES.has(record.code) ? record.code : undefined;
  const cause = inspectProviderFailure(record.cause, depth + 1);
  const causeMessage = cause.message && !message.includes(cause.message) ? cause.message : "";

  return {
    status: status ?? cause.status,
    networkCode: code ?? cause.networkCode,
    message: [message, causeMessage].filter(Boolean).join(" "),
  };
}

function httpStatus(error: Record<string, unknown>): number | undefined {
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.status === "number") return error.status;

  const metadata = error.$metadata;
  if (isRecord(metadata) && typeof metadata.httpStatusCode === "number") {
    return metadata.httpStatusCode;
  }

  const response = error.$response;
  if (isRecord(response) && typeof response.statusCode === "number") {
    return response.statusCode;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function kindFromDetail(detail: ProviderFailureDetail): ProviderFailureKind {
  // Status wins over prose: a 401 that mentions a plan is still an auth failure,
  // and a 403 that says "unauthorized" is still an entitlement reject.
  if (detail.status === 401 || /\b401\b/.test(detail.message)) return "auth";
  if (detail.status === 403 || /\b403\b/.test(detail.message)) return "entitlement";
  if (/\b(?:plan|subscription|entitlement)\b/i.test(detail.message)) return "entitlement";
  if (/invalid.?api.?key|authentication_error|unauthorized/i.test(detail.message)) return "auth";
  if (
    detail.networkCode ||
    /\bfetch failed\b|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR_/i.test(
      detail.message,
    )
  ) {
    return "network";
  }
  return "unknown";
}

function messageFor(kind: ProviderFailureKind, detail: ProviderFailureDetail): string {
  switch (kind) {
    case "auth":
      return "Authentication failed.";
    case "entitlement":
      return "Not covered by your subscription plan.";
    case "network":
      if (detail.networkCode) return `Network error (${detail.networkCode}).`;
      if (/\bfetch failed\b/i.test(detail.message)) return "Network error (fetch failed).";
      return "Network error.";
    default: {
      const text = detail.message.replace(/\s+/g, " ").trim();
      if (!text) return "Connection test failed.";
      return text.length > 180 ? `${text.slice(0, 179)}…` : text;
    }
  }
}

export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  return kindFromDetail(inspectProviderFailure(error));
}

/** User-facing probe copy. Chat renders its own longer entitlement sentence. */
export function describeProviderFailure(error: unknown): {
  kind: ProviderFailureKind;
  message: string;
} {
  const detail = inspectProviderFailure(error);
  const kind = kindFromDetail(detail);
  return { kind, message: messageFor(kind, detail) };
}
