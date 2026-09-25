import { fireEvent, waitFor, within } from "@testing-library/react";

/**
 * Locators for the ChatComposerInput-backed prompt composer. The editable is
 * a contentEditable div labelled "Prompt" with aria-placeholder carrying the
 * placeholder copy. Its role is combobox while triggers are configured (Pace
 * always passes a placeholder trigger to keep the role stable) and textbox
 * without any, so match by label instead of role.
 */

export type PromptInputOptions = {
  /** Filter by the composer's aria-placeholder, e.g. "Queue the next task…". */
  placeholder?: string;
};

function promptInputsIn(
  scope: ParentNode | undefined,
  options: PromptInputOptions,
): HTMLElement[] {
  const queries = within((scope as HTMLElement) ?? document.body);
  return [
    ...queries.queryAllByRole("textbox", { name: "Prompt" }),
    ...queries.queryAllByRole("combobox", { name: "Prompt" }),
  ].filter(
    (element) =>
      options.placeholder === undefined ||
      element.getAttribute("aria-placeholder") === options.placeholder,
  );
}

export function getPromptInput(
  scope?: ParentNode,
  options: PromptInputOptions = {},
): HTMLElement {
  const matches = promptInputsIn(scope, options);
  if (matches.length !== 1) {
    throw new Error(
      `Expected 1 prompt input, found ${matches.length}` +
        (options.placeholder ? ` (placeholder: ${options.placeholder})` : ""),
    );
  }
  return matches[0]!;
}

export function queryPromptInput(
  scope?: ParentNode,
  options: PromptInputOptions = {},
): HTMLElement | null {
  const matches = promptInputsIn(scope, options);
  return matches.length === 1 ? matches[0]! : null;
}

export async function findPromptInput(
  scope?: ParentNode,
  options: PromptInputOptions = {},
): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await waitFor(() => {
    element = getPromptInput(scope, options);
  });
  return element!;
}

/**
 * Replace the editable's content and fire the input event the component
 * listens to — the contentEditable counterpart of fireEvent.change on a
 * textarea. `user.keyboard` does write into a focused contentEditable in
 * jsdom (the suggestion-focus tests rely on it), but setting the value
 * atomically is both faster and what paste/injection flows do.
 */
export function typeIntoPrompt(element: HTMLElement, text: string) {
  element.textContent = text;
  fireEvent.input(element);
}

/** Same string ChatComposerInput's serialize() produces from the DOM. */
export function promptValue(element: HTMLElement): string {
  let result = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? "";
    } else if (child instanceof HTMLElement) {
      if (child.hasAttribute("data-astryx-token")) {
        result += child.getAttribute("data-astryx-token-value") ?? "";
      } else if (child.tagName === "BR") {
        result += "\n";
      } else {
        result += promptValue(child);
      }
    }
  }
  return result;
}
