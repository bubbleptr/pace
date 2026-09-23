import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  describeProviderFailure,
  sortProvidersForDisplay,
} from "./provider-auth";

describe("sortProvidersForDisplay", () => {
  it("orders configured, then featured, then alphabetical by label", () => {
    const items = [
      { id: "together", label: "Together", configured: false },
      { id: "radius", label: "Radius", configured: false },
      { id: "baseten", label: "Baseten", configured: true },
      { id: "anthropic", label: "Anthropic", configured: false },
      { id: "openai", label: "OpenAI", configured: true },
      { id: "cerebras", label: "Cerebras", configured: false },
    ];

    expect(sortProvidersForDisplay(items).map((item) => item.id)).toEqual([
      "openai",
      "baseten",
      "anthropic",
      "radius",
      "cerebras",
      "together",
    ]);
  });
});

describe("classifyProviderFailure", () => {
  it("classifies HTTP 401 as auth, including when the body mentions a plan", () => {
    expect(classifyProviderFailure(Object.assign(new Error("subscription plan"), { status: 401 }))).toBe(
      "auth",
    );
    expect(classifyProviderFailure("401: Invalid API key")).toBe("auth");
  });

  it("classifies a rejected OAuth refresh token as auth even though the status is 400", () => {
    expect(
      classifyProviderFailure(
        "OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant: Invalid or unknown refresh token",
      ),
    ).toBe("auth");
    expect(classifyProviderFailure("Invalid or unknown refresh token")).toBe("auth");
  });

  it("treats a connectivity failure during an OAuth refresh as network, not a dead token", () => {
    expect(describeProviderFailure("OAuth refresh failed for xai: fetch failed")).toMatchObject({
      kind: "network",
      message: "Network error",
    });
    expect(
      classifyProviderFailure(
        Object.assign(new Error("OAuth refresh failed for xai"), { code: "ECONNRESET" }),
      ),
    ).toBe("network");
  });

  it("tells an OAuth user to sign in again but keeps the API-key label", () => {
    expect(
      describeProviderFailure(
        "OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant: Invalid or unknown refresh token",
      ).message,
    ).toBe("Sign in again");
    expect(describeProviderFailure("401: Invalid API key").message).toBe("Authentication failed");
  });

  it("leaves a model the account cannot use unclassified so the probe can try another", () => {
    expect(
      classifyProviderFailure(
        "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe("unknown");
  });

  it("classifies 403 and plan, subscription, or entitlement wording as entitlement", () => {
    expect(
      classifyProviderFailure(Object.assign(new Error("forbidden"), { statusCode: 403 })),
    ).toBe("entitlement");
    expect(
      classifyProviderFailure(
        Object.assign(new Error("forbidden"), { $metadata: { httpStatusCode: 403 } }),
      ),
    ).toBe("entitlement");
    expect(classifyProviderFailure("403 status code (no body)")).toBe("entitlement");
    expect(
      classifyProviderFailure("Your subscription plan does not include this model"),
    ).toBe("entitlement");
  });

  it("classifies fetch and connection failures as network", () => {
    expect(classifyProviderFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      "network",
    );
    expect(
      classifyProviderFailure(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        }),
      ),
    ).toBe("network");
    // OpenAI / Anthropic leave these on errorMessage when formatProviderError has no status.
    expect(classifyProviderFailure("Connection error.")).toBe("network");
    expect(classifyProviderFailure("Request timed out.")).toBe("network");
    expect(classifyProviderFailure("Provider finish_reason: network_error")).toBe("network");
    expect(classifyProviderFailure("socket hang up")).toBe("network");
  });

  it("leaves unrecognized failures unknown", () => {
    expect(classifyProviderFailure(new Error("model exploded"))).toBe("unknown");
    expect(classifyProviderFailure("The provider dropped the connection.")).toBe("unknown");
  });
});
