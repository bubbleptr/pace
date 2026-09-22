// Pi names these "OpenAI Codex" and "OpenAI" and both use the OpenAI mark, so
// side by side they read as the same thing. Say how each one is billed.
const channelLabels: Record<string, string> = {
  "openai-codex": "ChatGPT subscription",
  openai: "OpenAI API",
};

/** Short name for the channel a model is reached through, for disambiguating duplicate rows. */
export function providerChannelLabel(providerId: string): string {
  return channelLabels[providerId] ?? providerId;
}
