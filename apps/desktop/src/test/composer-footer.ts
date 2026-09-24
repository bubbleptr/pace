import { screen } from "@testing-library/react";

/** The Location row of the composer rendered under `composerTestId`. */
export function footerOf(composerTestId: string) {
  const footer = screen
    .getByTestId(composerTestId)
    .querySelector<HTMLElement>('[data-slot="prompt-input-footer"]');

  if (!footer) {
    throw new Error(`${composerTestId} has no Location row`);
  }

  return footer;
}
