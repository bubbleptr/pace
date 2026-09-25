import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PromptCommand } from "@pace/core";
import {
  commandToken,
  insertCatalogs,
  leadingCommandMatch,
  slashTrigger,
  slashTriggerActive,
  validateCommandSubmit,
} from "./prompt-command-tokens";

const NBSP = "\u00A0";

function skill(name: string, description?: string): PromptCommand {
  return { kind: "skill", name, invocation: `skill:${name}`, description };
}

function prompt(name: string, description?: string): PromptCommand {
  return { kind: "prompt", name, invocation: name, description };
}

function extension(name: string, description?: string): PromptCommand {
  return { kind: "extension", name, invocation: name, description };
}

describe("commandToken", () => {
  it("serializes each kind to its Pi invocation text", () => {
    expect(commandToken(skill("review-pr"))).toMatchObject({
      value: "/skill:review-pr",
      label: "review-pr",
      variant: "purple",
    });
    expect(commandToken(prompt("fix"))).toMatchObject({
      value: "/fix",
      label: "/fix",
      variant: "teal",
    });
    expect(commandToken(extension("deploy"))).toMatchObject({
      value: "/deploy",
      label: "/deploy",
      variant: "blue",
    });
  });

  it("carries a rendered kind icon", () => {
    const token = commandToken(skill("review-pr"));
    const { container } = render(<>{"icon" in token ? token.icon : null}</>);

    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("leadingCommandMatch", () => {
  const commands = [skill("review-pr"), prompt("fix"), extension("deploy")];

  it("matches a command at the end of the input", () => {
    const match = leadingCommandMatch("/fix", commands);
    expect(match?.token).toMatchObject({ value: "/fix" });
    expect(match?.length).toBe("/fix".length);
  });

  it("matches a command followed by a space and counts the space", () => {
    const match = leadingCommandMatch("/fix 参数", commands);
    expect(match?.length).toBe("/fix ".length);
  });

  it("matches a command followed by a non-breaking space", () => {
    const match = leadingCommandMatch(`/skill:review-pr${NBSP}参数`, commands);
    expect(match?.token).toMatchObject({ value: "/skill:review-pr" });
    expect(match?.length).toBe(`/skill:review-pr${NBSP}`.length);
  });

  it("matches a command followed by a newline without consuming it", () => {
    const match = leadingCommandMatch("/fix\nrest", commands);
    expect(match?.length).toBe("/fix".length);
  });

  it("requires a full word boundary", () => {
    expect(leadingCommandMatch("/reviewer x", commands)).toBeNull();
    expect(leadingCommandMatch("/fixer", commands)).toBeNull();
  });

  it("returns null for unknown commands and non-commands", () => {
    expect(leadingCommandMatch("/nope hi", commands)).toBeNull();
    expect(leadingCommandMatch("fix the bug", commands)).toBeNull();
    expect(leadingCommandMatch("", commands)).toBeNull();
    // A slash later in the text is not a leading command.
    expect(leadingCommandMatch("hello /fix", commands)).toBeNull();
  });

  it("prefers skill over prompt and extension on an invocation collision", () => {
    const colliding = [
      extension("shared"),
      prompt("shared"),
      { kind: "skill", name: "s", invocation: "shared" } as PromptCommand,
    ];
    const match = leadingCommandMatch("/shared x", colliding);
    expect(match?.token).toMatchObject({ variant: "purple" });
  });
});

describe("slashTriggerActive", () => {
  it.each([
    ["", true],
    ["/", true],
    ["/re", true],
    ["/review-pr", true],
    ["hello", false],
    ["hello /", false],
    ["/x ", false],
    [`/x${NBSP}`, false],
    ["/x y", false],
    ["\n", false],
  ])("slashTriggerActive(%j) → %s", (value, expected) => {
    expect(slashTriggerActive(value)).toBe(expected);
  });
});

describe("slashTrigger", () => {
  const commands = [skill("review-pr"), prompt("fix"), extension("deploy")];

  it("returns null when inactive", () => {
    expect(slashTrigger(commands, { active: false, queueMode: false })).toBeNull();
  });

  it("builds a '/' trigger whose selection emits a command token", () => {
    const trigger = slashTrigger(commands, { active: true, queueMode: false });
    expect(trigger?.character).toBe("/");

    const items = trigger?.searchSource.search("review") as
      | { id: string; auxiliaryData?: { command?: PromptCommand } }[]
      | undefined;
    expect(items?.some((item) => item.id === "skill/review-pr")).toBe(true);

    const pick = items!.find((item) => item.id === "skill/review-pr")!;
    expect(trigger?.onSelect(pick as never)).toMatchObject({
      value: "/skill:review-pr",
      variant: "purple",
    });
  });

  it("filters extension commands in queue mode", () => {
    const trigger = slashTrigger(commands, { active: true, queueMode: true });
    const items = trigger?.searchSource.search("") as { id: string }[];
    expect(items?.map((item) => item.id)).toEqual(
      expect.arrayContaining(["skill/review-pr", "prompt/fix"]),
    );
    expect(items?.some((item) => item.id === "extension/deploy")).toBe(false);
  });
});

describe("insertCatalogs", () => {
  const commands = [skill("review-pr"), prompt("fix"), extension("deploy")];

  it("groups commands into Skills, Prompts and Commands", () => {
    const catalogs = insertCatalogs(commands, { queueMode: false });
    expect(catalogs.map((catalog) => catalog.id)).toEqual([
      "skills",
      "prompts",
      "commands",
    ]);
    expect(catalogs[0]?.items?.map((item) => item.id)).toEqual(["skill:review-pr"]);
    expect(catalogs[1]?.items?.map((item) => item.id)).toEqual(["fix"]);
    expect(catalogs[2]?.items?.map((item) => item.id)).toEqual(["deploy"]);
  });

  it("drops the Commands group in queue mode", () => {
    const catalogs = insertCatalogs(commands, { queueMode: true });
    expect(catalogs.map((catalog) => catalog.id)).toEqual(["skills", "prompts"]);
  });
});

describe("validateCommandSubmit", () => {
  const commands = [skill("review-pr"), prompt("fix"), extension("deploy")];
  const validate = (value: string, queueMode = false) =>
    validateCommandSubmit(value, { commands, queueMode });

  it("accepts ordinary prompts and unknown slash words", () => {
    expect(validate("fix the bug")).toBeNull();
    expect(validate("/frobnicate go")).toBeNull();
    expect(validate("")).toBeNull();
  });

  it("blocks Pi terminal built-ins the catalog does not know", () => {
    expect(validate("/compact")).toBe(
      "`/compact` is a Pi terminal command; Pace doesn't run it.",
    );
    expect(validate(`/compact${NBSP}now`)).toBe(
      "`/compact` is a Pi terminal command; Pace doesn't run it.",
    );
    expect(validate("/model gpt-5")).toBe(
      "`/model` is a Pi terminal command; Pace doesn't run it.",
    );
  });

  it("lets a catalog command win over a same-named Pi built-in", () => {
    const withCompact = [...commands, prompt("compact")];
    expect(
      validateCommandSubmit("/compact please", {
        commands: withCompact,
        queueMode: false,
      }),
    ).toBeNull();
  });

  it("blocks queued extension commands but not other catalog commands", () => {
    expect(validate("/deploy now", true)).toBe(
      "Extension commands can't be queued. Send it when Pi is idle.",
    );
    expect(validate(`/deploy${NBSP}now`, true)).toBe(
      "Extension commands can't be queued. Send it when Pi is idle.",
    );
    expect(validate("/deploy now", false)).toBeNull();
    expect(validate("/skill:review-pr 参数", true)).toBeNull();
    expect(validate("/fix now", true)).toBeNull();
  });
});
