// Pi's settings.json default model. Two readers: the model catalog's draft
// default selection and provider auth's connection-test probe order
// (ADR-0043 §5). Neither depends on the other.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readSettingsPreferredModel(agentDir: string) {
  try {
    const raw = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown;
    if (!isRecord(raw)) {
      return undefined;
    }

    const provider =
      (typeof raw.defaultProvider === "string" && raw.defaultProvider) ||
      (typeof raw.default_provider === "string" && raw.default_provider) ||
      (typeof raw.provider === "string" && raw.provider) ||
      undefined;
    const modelId =
      (typeof raw.defaultModel === "string" && raw.defaultModel) ||
      (typeof raw.default_model === "string" && raw.default_model) ||
      (typeof raw.model === "string" && raw.model) ||
      undefined;
    const thinkingLevel =
      (typeof raw.defaultThinkingLevel === "string" && raw.defaultThinkingLevel) ||
      (typeof raw.thinkingLevel === "string" && raw.thinkingLevel) ||
      undefined;

    return { provider, modelId, thinkingLevel };
  } catch {
    return undefined;
  }
}

export type PreferredModel = Awaited<ReturnType<typeof readSettingsPreferredModel>>;
