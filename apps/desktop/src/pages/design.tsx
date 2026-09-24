import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { AppFrame } from "@/widgets/app-frame";
import { DesignComponentsLayer } from "@/pages/design-components";

/**
 * Dev-only design gallery (/design). Layer 1: tokens.
 *
 * Swatches render straight from the live CSS custom properties (the Astryx
 * first-level tokens plus the Pace semantic bridge in styles.css), so this
 * page can never drift from what the app actually ships.
 */

const semanticColorTokens = [
  "--foreground",
  "--background",
  "--surface",
  "--surface-muted",
  "--surface-secondary",
  "--surface-hover",
  "--muted",
  "--default",
  "--separator",
  "--border",
  "--primary",
  "--danger",
  "--success",
  "--warning",
] as const;

const dataColorTokens = [
  "--pigui-data-blue",
  "--pigui-data-orange",
  "--pigui-data-orange-strong",
  "--pigui-data-amber",
  "--pigui-data-green",
  "--pigui-data-peach",
  "--pigui-data-coral",
  "--pigui-data-slate",
] as const;

const spacingTokens = [
  "--spacing-0-5",
  "--spacing-1",
  "--spacing-1-5",
  "--spacing-2",
  "--spacing-3",
  "--spacing-4",
  "--spacing-5",
  "--spacing-6",
  "--spacing-8",
  "--spacing-10",
  "--spacing-12",
] as const;

const radiusTokens = [
  "--radius-none",
  "--radius-inner",
  "--radius-element",
  "--radius-container",
  "--radius-chat",
  "--radius-page",
  "--radius-full",
] as const;

const fontSizeTokens = [
  "--font-size-3xs",
  "--font-size-2xs",
  "--font-size-xs",
  "--font-size-sm",
  "--font-size-base",
  "--font-size-lg",
  "--font-size-xl",
  "--font-size-2xl",
  "--font-size-3xl",
] as const;

/** Resolves a custom property against the live cascade (theme scope included). */
function useResolvedTokenValue(token: string) {
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const probe = probeRef.current;

    if (!probe) {
      return;
    }

    setValue(getComputedStyle(probe).getPropertyValue(token).trim());
  }, [token]);

  return { probeRef, value };
}

function TokenLabel({ token }: { token: string }) {
  const { probeRef, value } = useResolvedTokenValue(token);

  return (
    <span className="flex min-w-0 flex-col" ref={probeRef}>
      <code className="truncate text-xs text-foreground">{token}</code>
      {value ? <span className="truncate text-[10px] text-muted">{value}</span> : null}
    </span>
  );
}

export function GallerySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function ColorSwatchGrid({ tokens }: { tokens: readonly string[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
      {tokens.map((token) => (
        <div
          key={token}
          className="flex items-center gap-3 rounded-md border border-separator bg-surface p-2"
        >
          <span
            aria-hidden="true"
            className="size-8 shrink-0 rounded-md border border-separator"
            style={{ background: `var(${token})` }}
          />
          <TokenLabel token={token} />
        </div>
      ))}
    </div>
  );
}

export function SemanticPaletteSection() {
  return (
    <GallerySection title="Semantic colors">
      <ColorSwatchGrid tokens={semanticColorTokens} />
    </GallerySection>
  );
}

export function DataPaletteSection() {
  return (
    <GallerySection title="Data colors">
      <ColorSwatchGrid tokens={dataColorTokens} />
    </GallerySection>
  );
}

export function SpacingScaleSection() {
  return (
    <GallerySection title="Spacing">
      <div className="flex flex-col gap-1">
        {spacingTokens.map((token) => (
          <div key={token} className="flex items-center gap-3">
            <span className="w-36 shrink-0">
              <TokenLabel token={token} />
            </span>
            <span
              aria-hidden="true"
              className="h-3 rounded-sm bg-primary"
              style={{ width: `var(${token})` }}
            />
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

export function RadiusScaleSection() {
  return (
    <GallerySection title="Radius">
      <div className="flex flex-wrap gap-3">
        {radiusTokens.map((token) => (
          <div key={token} className="flex flex-col items-center gap-2">
            <span
              aria-hidden="true"
              className="size-16 border border-separator bg-surface-muted"
              style={{ borderRadius: `var(${token})` }}
            />
            <TokenLabel token={token} />
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

export function TypeScaleSection() {
  return (
    <GallerySection title="Typography">
      <div className="flex flex-col gap-2">
        {fontSizeTokens.map((token) => (
          <div key={token} className="flex items-baseline gap-4">
            <span className="w-36 shrink-0">
              <TokenLabel token={token} />
            </span>
            <span
              className="truncate text-foreground"
              style={{ fontSize: `var(${token})` }}
            >
              The quick brown fox
            </span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

type DesignTab = "tokens" | "components";

export function DesignPageContent() {
  const [tab, setTab] = useState<DesignTab>("tokens");

  return (
    <VStack gap={6} padding={6} style={{ width: "100%", maxWidth: "calc(var(--spacing-12) * 28)", marginInline: "auto", minWidth: 0 }}>
      <Text type="supporting">
        Pace design system · Foundations and reusable interface components.
      </Text>
      <TabList
        hasDivider
        value={tab}
        onChange={(value) => {
          if (value === "tokens" || value === "components") {
            setTab(value);
          }
        }}
      >
        <Tab label="Tokens" value="tokens" />
        <Tab label="Components" value="components" />
      </TabList>
      {tab === "tokens" ? (
        <>
          <SemanticPaletteSection />
          <DataPaletteSection />
          <SpacingScaleSection />
          <RadiusScaleSection />
          <TypeScaleSection />
        </>
      ) : (
        <DesignComponentsLayer />
      )}
    </VStack>
  );
}

export function DesignPage() {
  return (
    <AppFrame>
      <div className="h-full overflow-y-auto">
        <DesignPageContent />
      </div>
    </AppFrame>
  );
}
