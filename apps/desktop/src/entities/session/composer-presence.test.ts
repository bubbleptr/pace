import { describe, expect, it } from "vitest";
import {
  isComposerMounted,
  markComposerMounted,
} from "./composer-presence";

describe("composer presence registry", () => {
  it("answers whether a Session has a composer", () => {
    expect(isComposerMounted("s")).toBe(false);

    const unmount = markComposerMounted("s");
    expect(isComposerMounted("s")).toBe(true);

    unmount();
    expect(isComposerMounted("s")).toBe(false);
  });

  it("counts mounts — the last unmount clears the answer", () => {
    const first = markComposerMounted("s");
    const second = markComposerMounted("s");

    first();
    expect(isComposerMounted("s")).toBe(true);

    second();
    expect(isComposerMounted("s")).toBe(false);
  });

  it("scopes the answer to its Session", () => {
    const unmount = markComposerMounted("s");

    expect(isComposerMounted("other")).toBe(false);
    unmount();
  });
});
