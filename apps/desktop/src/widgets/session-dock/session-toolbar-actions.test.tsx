import { describe, expect, it } from "vitest";
import { render } from "@/test/render";
import { SessionToolbarActions } from "./session-toolbar-actions";

// Context occupancy rides the composer footer line — the hint row under the
// input — and never the Session toolbar. Issue #128.
describe("Context usage placement", () => {
  it("leaves the Session toolbar to the dock toggle", () => {
    const { container } = render(
      <SessionToolbarActions />,
    );

    expect(
      container.querySelector('[data-slot="context-usage-meter"]'),
    ).not.toBeInTheDocument();
  });
});
