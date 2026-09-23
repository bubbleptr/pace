import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { classifyProviderFailure } from "@pace/core";

function describeFailure(error: string) {
  const kind = classifyProviderFailure(error);
  if (kind === "auth") {
    return {
      title: "Provider authentication failed",
      description: "The provider rejected the credentials. Sign in again or update them in Provider settings, then retry. You can also choose another model.",
    };
  }
  if (kind === "entitlement") {
    return {
      title: "This model is not included in your subscription plan",
      description: "Test the connection in Settings → Providers.",
    };
  }
  if (/\b429\b|rate.?limit|quota.?exceeded/i.test(error)) {
    return {
      title: "Provider limit reached",
      description: "Wait a moment, or choose another model and retry.",
    };
  }
  return {
    title: "Run failed",
    description: /[{}\n]/.test(error)
      ? "The provider could not complete this request. Check the error details, then retry or choose another model."
      : error,
  };
}

type ChatRunFailureOwnProps = {
  error: string;
  onRetry?: () => Promise<void>;
  onOpenProviderSettings?: () => void;
  modelControl?: ReactNode;
};

export type ChatRunFailureProps = Omit<
  ComponentProps<typeof VStack>,
  keyof ChatRunFailureOwnProps | "children" | "gap"
> &
  ChatRunFailureOwnProps;

export function ChatRunFailure({
  error,
  onRetry,
  onOpenProviderSettings,
  modelControl,
  className,
  ...rest
}: ChatRunFailureProps) {
  const [retrying, setRetrying] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const retryInFlight = useRef(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const summary = describeFailure(error);
  const retry = async () => {
    if (!onRetry || retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry();
    } catch (reason) {
      setRetryError(reason instanceof Error ? reason.message : "Retry could not start.");
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };

  return (
    <VStack className={className} gap={2} {...rest}>
      <Banner status="error" title={summary.title} description={summary.description} />
      <HStack gap={2} wrap="wrap">
        {onOpenProviderSettings ? (
          <Button label="Provider settings" size="sm" variant="secondary" onClick={onOpenProviderSettings} />
        ) : null}
        {modelControl}
        {onRetry ? (
          <Button label="Retry request" size="sm" variant="secondary" isDisabled={retrying} onClick={() => void retry()} />
        ) : null}
      </HStack>
      {retryError ? (
        <Text role="alert" style={{ color: "var(--danger)" }}>{retryError}</Text>
      ) : null}
      <Collapsible
        trigger={<Text type="body" size="sm" color="secondary">Error details</Text>}
        isOpen={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        {detailsOpen ? (
          <Text as="div" type="body" size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {error}
          </Text>
        ) : null}
      </Collapsible>
    </VStack>
  );
}
