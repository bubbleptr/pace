import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelControls } from "@pace/core";
import { ModelSelectorControl } from "@/entities/model/model-selector/model-selector-control";
import { buildIntentTarget, UiIntentPicker } from "./ui-intent-picker";

// Named exactly like the real Ledger component so the region registry matches.
function PiTrajectoryLedger() {
  return (
    <div data-testid="ledger">
      <button type="button">row</button>
    </div>
  );
}

function Fixture() {
  return (
    <div>
      <PiTrajectoryLedger />
      <UiIntentPicker />
    </div>
  );
}

/**
 * jsdom does no hit testing, so `document.elementFromPoint` is unusable there.
 * Tests stub it and return the intended target; in the real app the glass
 * pane hides itself momentarily and elementFromPoint finds the element under
 * the cursor.
 */
function stubElementFromPoint() {
  const stub = vi.fn();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: stub,
    writable: true,
  });
  return stub;
}

function arm() {
  fireEvent.click(screen.getByLabelText("Pick a UI element to copy its intent block"));
  return screen.getByTestId("ui-intent-picker-glass");
}

function armAndClick(target: Element) {
  const fromPoint = stubElementFromPoint();
  const glass = arm();

  fromPoint.mockReturnValue(target);
  fireEvent.pointerMove(glass, { clientX: 10, clientY: 10 });
  fireEvent.click(glass, { clientX: 10, clientY: 10 });
}

describe("buildIntentTarget", () => {
  it("resolves region, component definition site, and nearest testid", () => {
    render(<PiTrajectoryLedger />);

    const target = buildIntentTarget(screen.getByRole("button", { name: "row" }));

    expect(target.region?.region.term).toBe("Ledger");
    expect(target.component?.name).toBe("PiTrajectoryLedger");
    expect(target.component?.definition.file).toContain("ui-intent-picker.test");
    expect(target.testId).toBe("ledger");
  });

  it("skips design-system primitives (Astryx Button/Popover) for the headline", () => {
    const controls: RuntimeModelControls = {
      models: [
        {
          provider: "xai",
          modelId: "grok-4",
          name: "Grok 4",
          thinkingLevels: ["off", "medium", "high"],
        },
      ],
      selected: { provider: "xai", modelId: "grok-4", thinkingLevel: "high" },
    };
    render(
      <ModelSelectorControl controls={controls} isDisabled={false} onChange={() => {}} />,
    );

    const target = buildIntentTarget(screen.getByTestId("model-thinking-trigger"));

    // Regression: the headline used to be the Astryx `Button` wrapper whose
    // usage site lives in an app file, hiding the actual app component.
    expect(target.component?.name).toBe("ModelSelectorControl");
    expect(target.component?.definition.file).toContain("model-selector-control.tsx");
  });
});

describe("UiIntentPicker", () => {
  it("captures a clicked element and shows its region and component", () => {
    render(<Fixture />);

    armAndClick(screen.getByRole("button", { name: "row" }));

    const panel = screen.getByTestId("ui-intent-picker-panel");
    expect(panel).toHaveTextContent("Ledger");
    expect(panel).toHaveTextContent("PiTrajectoryLedger");
    expect(panel).toHaveTextContent("ledger");
  });

  it("copies the formatted intent block to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
      writable: true,
    });

    render(<Fixture />);
    armAndClick(screen.getByRole("button", { name: "row" }));
    fireEvent.click(screen.getByRole("button", { name: /Copy intent block/ }));

    await screen.findByText("Copied");
    expect(writeText).toHaveBeenCalledOnce();

    const block = writeText.mock.calls[0][0] as string;
    expect(block).toContain("- Region: `Ledger` — CONTEXT.md term \"**Ledger**:\"");
    expect(block).toContain("`PiTrajectoryLedger`");
    expect(block).toContain("- Nearest data-testid: `ledger`");
    expect(block).toContain("Change I want:");
  });

  it("toggles armed mode with Cmd/Ctrl+Shift+X and backs out with Escape", () => {
    render(<Fixture />);

    fireEvent.keyDown(document.body, {
      code: "KeyX",
      key: "x",
      metaKey: true,
      shiftKey: true,
    });
    expect(screen.getByText(/Click any element to capture/)).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/Click any element to capture/)).not.toBeInTheDocument();
  });

  it("intercepts pointer events on the glass pane so app handlers never fire", () => {
    const onAppClick = vi.fn();
    const onAppPointerMove = vi.fn();
    render(
      // Sibling, not parent: the picker mounts at the app root, so app
      // wrappers are never React ancestors of the glass pane.
      <div>
        <div onClick={onAppClick} onPointerMove={onAppPointerMove}>
          <button type="button">row</button>
        </div>
        <UiIntentPicker />
      </div>,
    );

    const fromPoint = stubElementFromPoint();
    const glass = arm();
    fromPoint.mockReturnValue(screen.getByRole("button", { name: "row" }));

    // The glass swallows hover and clicks — app tooltips/flyouts stay closed
    // and the picked element is resolved via elementFromPoint instead.
    fireEvent.pointerMove(glass, { clientX: 10, clientY: 10 });
    fireEvent.click(glass, { clientX: 10, clientY: 10 });

    expect(onAppPointerMove).not.toHaveBeenCalled();
    expect(onAppClick).not.toHaveBeenCalled();
    expect(screen.getByTestId("ui-intent-picker-panel")).toBeInTheDocument();
  });
});

describe("named component selection", () => {
  function NamedLeaf() { return <button type="button">deep target</button>; }
  function DeepFixture() {
    let child = <NamedLeaf />;
    for (let index = 0; index < 12; index++) {
      const Wrapper = ({ children }: { children: React.ReactNode }) => <section>{children}</section>;
      Wrapper.displayName = `NamedLayer${index}`;
      child = <Wrapper>{child}</Wrapper>;
    }
    return <>{child}<UiIntentPicker /></>;
  }

  it("allows selecting and copying named ancestors beyond eight rows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<DeepFixture />);
    armAndClick(screen.getByRole("button", { name: "deep target" }));
    expect(screen.queryByRole("button", { name: "NamedLayer11" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show full tree" }));
    fireEvent.click(screen.getByRole("button", { name: "NamedLayer11" }));
    fireEvent.click(screen.getByRole("button", { name: /Copy intent block/ }));
    await screen.findByText("Copied");
    const block = writeText.mock.calls[0][0] as string;
    expect(block).toContain('- Component: `NamedLayer11`');
    expect(block).not.toContain('`NamedLeaf`');
    expect(block).toContain('`NamedLayer11`');
    expect(block).not.toContain(' more)');
  });

  it("keeps the specific component name visible while hovering a known region", () => {
    render(<Fixture />);
    const fromPoint = stubElementFromPoint();
    const glass = arm();
    fromPoint.mockReturnValue(screen.getByRole("button", { name: "row" }));
    fireEvent.pointerMove(glass, { clientX: 10, clientY: 10 });
    expect(screen.getByText("PiTrajectoryLedger · Ledger")).toBeInTheDocument();
  });
});

describe("component identity", () => {
  it("does not hide an app component just because a library exports the same name", () => {
    function Button() { return <button type="button">local button</button>; }
    function AppFeature() { return <Button />; }
    render(<AppFeature />);
    expect(buildIntentTarget(screen.getByRole("button", { name: "local button" })).component?.name).toBe("Button");
  });
});

describe("expandable component tree", () => {
  function Descendant() { return <em>nested</em>; }
  function SiblingBranch() { return <article><Descendant /></article>; }
  function TreeFixture() { return <><PiTrajectoryLedger /><SiblingBranch /><UiIntentPicker /></>; }

  it("opens the picked path and lets users expand and copy a sibling descendant", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<TreeFixture />);
    armAndClick(screen.getByRole("button", { name: "row" }));
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Descendant" })).toBeNull();
    const sibling = screen.getByRole("button", { name: "SiblingBranch" }).closest('[role="treeitem"]')!;
    (sibling as HTMLElement).focus();
    fireEvent.keyDown(sibling, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Descendant" }));
    fireEvent.click(screen.getByRole("button", { name: /Copy intent block/ }));
    await screen.findByText("Copied");
    const block = writeText.mock.calls[0][0] as string;
    expect(block).toContain('- Component: `Descendant`');
    expect(block).toContain('`SiblingBranch`');
    expect(block).not.toContain('`PiTrajectoryLedger`');
    expect(block).toContain('Clicked element: `<button>`');
    expect(screen.queryByRole("button", { name: "UiIntentPicker" })).toBeNull();
  });
});
