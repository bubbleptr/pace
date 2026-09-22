import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatRunFailure } from "./chat-run-failure";

describe("ChatRunFailure", () => {
  it("explains rejected credentials and keeps raw details collapsed", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    const raw = '401 {"error":{"message":"Invalid API key","type":"authentication_error"}}';
    render(<ChatRunFailure error={raw} onOpenProviderSettings={openSettings} />);
    expect(screen.getByText("Provider authentication failed")).toBeInTheDocument();
    expect(screen.queryByText(raw)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Error details" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Provider settings" }));
    expect(openSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Error details" }));
    expect(screen.getByText(raw)).toBeVisible();
  });

  it("prevents duplicate retries and shows a retry failure without losing the original", async () => {
    const user = userEvent.setup();
    let reject!: (reason: Error) => void;
    const retry = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    render(<ChatRunFailure error="The provider dropped the connection." onRetry={retry} />);
    await user.dblClick(screen.getByRole("button", { name: "Retry request" }));
    expect(retry).toHaveBeenCalledOnce();
    reject(new Error("Runtime disconnected"));
    expect(await screen.findByText("Runtime disconnected")).toBeInTheDocument();
    expect(screen.getByText("The provider dropped the connection.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry request" })).toBeEnabled());
  });

  it("does not offer a retry for a historical failure", () => {
    render(<ChatRunFailure error="503 service unavailable" />);
    expect(screen.queryByRole("button", { name: "Retry request" })).not.toBeInTheDocument();
  });

  it("points a subscription entitlement failure at Settings → Providers", () => {
    render(
      <ChatRunFailure error='403 {"error":{"message":"Your subscription plan does not include this model"}}' />,
    );
    expect(screen.getByText("This model is not included in your subscription plan.")).toBeInTheDocument();
    expect(screen.getByText(/Settings → Providers/)).toBeInTheDocument();
    expect(screen.queryByText("Run failed")).not.toBeInTheDocument();
  });
});
