import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Heading, Text } from "@astryxdesign/core/Text";

/**
 * Guard for the @astryxdesign/core patch: Text/Heading merge their forwarded
 * ref, useTruncation's callback ref, and an internal object ref into one
 * callback built fresh on every render. A new callback identity makes React
 * detach+reattach the ref on every commit — and useTruncation's attach calls
 * setState inside the commit, which is what let nested updates accumulate
 * into React #185 under dense Session events.
 */
describe("Astryx ref stability", () => {
  it("Text keeps the forwarded callback ref attached across re-renders", () => {
    const spy = vi.fn();
    function Parent({ label }: { label: string }) {
      return <Text ref={spy}>{label}</Text>;
    }

    const { rerender } = render(<Parent label="a" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(expect.any(HTMLElement));

    rerender(<Parent label="b" />);
    rerender(<Parent label="c" />);
    rerender(<Parent label="d" />);

    // No detach (spy(null)) and no re-attach: identity must be stable.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalledWith(null);
  });

  it("Heading keeps the forwarded callback ref attached across re-renders", () => {
    const spy = vi.fn();
    function Parent({ label }: { label: string }) {
      return (
        <Heading level={2} ref={spy}>
          {label}
        </Heading>
      );
    }

    const { rerender } = render(<Parent label="a" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(expect.any(HTMLElement));

    rerender(<Parent label="b" />);
    rerender(<Parent label="c" />);
    rerender(<Parent label="d" />);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalledWith(null);
  });
});
