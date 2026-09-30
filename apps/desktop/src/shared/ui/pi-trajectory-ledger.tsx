import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { formatToolDuration, toolDisplayName } from "@/shared/ui/chat/chat-tool";
import type { TrajectoryRole, TrajectoryRun, TrajectoryStep } from "@/entities/session/trajectory-model";

/**
 * The Ledger (Trajectory Cockpit step list): one row per step, grouped two
 * levels deep — a sticky Run header per Active Run, a gutter dot at each
 * Turn boundary (one assistant message = one model call + its tools).
 * Rows carry a type badge and read `name {request} → result`; they never
 * expand inline — full payloads belong to the Inspector. Validated in the
 * trajectory-cockpit prototype round (2026-08-18).
 */

export type TrajectoryStepType = { label: string; color: string };

/**
 * Four badges only — think/image/text collapse into ASSISTANT (all model
 * actions); an image step inherits its carrier's role (user upload → USER,
 * model-generated → ASSISTANT). Tool-produced images never become image
 * steps: the parser keeps them inside the toolResult payload, so they belong
 * to the TOOL row and surface in the Inspector.
 */
export function trajectoryStepType(step: TrajectoryStep, role: TrajectoryRole): TrajectoryStepType {
  if (role === "annotation" || step.kind === "config") {
    return { label: "context", color: "var(--pigui-data-green)" };
  }
  if (step.kind === "tool") {
    return { label: "tool", color: "var(--pigui-data-orange)" };
  }
  if (role === "user") {
    return { label: "user", color: "var(--pigui-data-blue)" };
  }
  return { label: "assistant", color: "var(--pigui-data-slate)" };
}

export function trajectoryStepStatus(step: TrajectoryStep): {
  glyph: string;
  className: string;
  label: string;
} {
  if (step.kind !== "tool") {
    return { glyph: "·", className: "text-muted", label: "—" };
  }
  if (step.isRunning) {
    return { glyph: "●", className: "animate-pulse motion-reduce:animate-none text-primary", label: "Running" };
  }
  if (step.isError) {
    return { glyph: "✕", className: "text-danger", label: "Error" };
  }
  return { glyph: "✓", className: "text-success", label: "Completed" };
}

export type TrajectoryStepBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  type: TrajectoryStepType;
};

export function TrajectoryStepBadge({ type, className, ...rest }: TrajectoryStepBadgeProps) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${className ?? ""}`.trim()}
      data-slot="trajectory-step-badge"
      style={{
        background: `color-mix(in oklch, ${type.color} 16%, transparent)`,
        color: `color-mix(in oklch, ${type.color} 72%, var(--foreground))`,
      }}
      {...rest}
    >
      {type.label}
    </span>
  );
}

function compactJson(value?: string, max = 72) {
  if (!value) {
    return undefined;
  }
  let compact = value;
  try {
    compact = JSON.stringify(JSON.parse(value));
  } catch {
    compact = value.replace(/\s+/g, " ");
  }
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function firstLinePreview(value?: string, max = 110) {
  if (!value) {
    return undefined;
  }
  const line =
    value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean) ?? "";
  const compact = line.replace(/\s+/g, " ");
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatHeaderTime(value?: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

function formatTokens(value?: number) {
  if (value === undefined) {
    return undefined;
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function LedgerRow({
  step,
  role,
  isSelected,
  isDimmed = false,
  onSelect,
  rowRef,
}: {
  step: TrajectoryStep;
  role: TrajectoryRole;
  isSelected: boolean;
  isDimmed?: boolean;
  onSelect?: (stepId: string) => void;
  rowRef?: (stepId: string, element: HTMLButtonElement | null) => void;
}) {
  const type = trajectoryStepType(step, role);
  const request =
    step.kind === "tool"
      ? compactJson(step.argsText)
      : step.kind === "config"
        ? [step.target, step.name, compactJson(step.text)].filter(Boolean).join(" · ")
        : firstLinePreview(step.text ?? step.target);
  const result =
    step.kind === "tool"
      ? step.isRunning
        ? "running…"
        : firstLinePreview(step.output)
      : undefined;

  return (
    <button
      aria-pressed={isSelected}
      data-slot="trajectory-ledger-row"
      data-kind={step.kind}
      data-status={step.kind === "tool" ? (step.isRunning ? "running" : step.isError ? "error" : "ok") : undefined}
      data-playhead={isSelected ? "" : undefined}
      data-focus-dimmed={isDimmed ? "" : undefined}
      className={`grid w-full min-w-0 cursor-pointer grid-cols-[5.5rem_minmax(0,1fr)_3.5rem] items-baseline gap-x-2 border-l-2 py-1 pl-2 pr-3 text-left font-mono text-xs leading-6 transition-colors ${
        isSelected ? "border-primary bg-surface-muted" : "border-transparent hover:bg-surface-hover"
      } ${isDimmed ? "opacity-30" : ""}`.trim()}
      ref={(element) => rowRef?.(step.id, element)}
      type="button"
      onClick={() => onSelect?.(step.id)}
    >
      <span className="flex justify-end">
        <TrajectoryStepBadge type={type} />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {step.kind === "tool" ? (
          <>
            <span className="shrink-0 font-semibold text-foreground">{toolDisplayName(step.name)}</span>
            {request ? (
              <span className="min-w-0 max-w-[45%] truncate text-muted">{request}</span>
            ) : null}
            <span aria-hidden="true" className="shrink-0 text-muted/60">
              →
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${
                step.isError
                  ? "font-semibold text-danger"
                  : step.isRunning
                    ? "animate-pulse motion-reduce:animate-none text-primary"
                    : "text-muted"
              }`}
            >
              {step.isError ? (firstLinePreview(step.output) ?? "Error") : (result ?? "—")}
            </span>
          </>
        ) : (
          <span
            className={`min-w-0 flex-1 truncate ${
              step.kind === "think" ? "text-muted" : "text-foreground"
            }`}
          >
            {request ?? step.name ?? "—"}
          </span>
        )}
      </span>
      <span className="text-right tabular-nums text-muted">
        {formatToolDuration(step.durationMs)}
      </span>
    </button>
  );
}

type PiTrajectoryLedgerContextValue = {
  selectedStepId?: string;
  onSelectedStepChange?: (stepId: string) => void;
  isStepDimmed?: (step: TrajectoryStep) => boolean;
  stepFilter?: (step: TrajectoryStep) => boolean;
  registerStepRef?: (stepId: string, element: HTMLButtonElement | null) => void;
  registerTurnRef?: (turnIndex: number, element: HTMLDivElement | null) => void;
};

const PiTrajectoryLedgerContext = createContext<PiTrajectoryLedgerContextValue | null>(
  null,
);

function usePiTrajectoryLedgerContext() {
  const value = useContext(PiTrajectoryLedgerContext);
  if (!value) {
    throw new Error("PiTrajectoryLedger.Run must be used within PiTrajectoryLedger");
  }
  return value;
}

type PiTrajectoryLedgerRunOwnProps = {
  run: TrajectoryRun;
  /** Focus semantics (Strip brush): dimmed runs stay rendered, greyed out. */
  isDimmed?: boolean;
};

export type PiTrajectoryLedgerRunProps = Omit<
  ComponentProps<"section">,
  keyof PiTrajectoryLedgerRunOwnProps | "children"
> &
  PiTrajectoryLedgerRunOwnProps;

function Run({
  run,
  isDimmed = false,
  className,
  ...rest
}: PiTrajectoryLedgerRunProps) {
  const {
    selectedStepId,
    onSelectedStepChange,
    isStepDimmed,
    stepFilter,
    registerStepRef,
    registerTurnRef,
  } = usePiTrajectoryLedgerContext();
  const visibleTurns = run.turns
    .map((turn) => ({
      turn,
      steps: stepFilter ? turn.steps.filter(stepFilter) : turn.steps,
    }))
    .filter(({ steps }) => steps.length > 0);

  if (visibleTurns.length === 0) {
    return null;
  }

  return (
    <section
      className={`transition-opacity ${isDimmed ? "opacity-30" : ""} ${className ?? ""}`.trim()}
      data-focus-dimmed={isDimmed ? "" : undefined}
      data-slot="trajectory-ledger-run"
      {...rest}
    >
      <header className="sticky top-0 z-10 flex items-baseline justify-between gap-3 border-t border-border bg-surface-muted/80 px-3 py-1 backdrop-blur">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-foreground">
            Run #{run.index + 1}
          </span>
          <time className="shrink-0 font-mono text-[11px] text-muted" dateTime={run.timestamp}>
            {formatHeaderTime(run.timestamp)}
          </time>
        </span>
        {run.totalTokens > 0 ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {formatTokens(run.totalTokens)} tok
          </span>
        ) : null}
      </header>
      {visibleTurns.map(({ turn, steps }) => (
        <div
          key={turn.index}
          ref={(element) => registerTurnRef?.(turn.index, element)}
        >
          {/* Turn boundary: each assistant message = one model call + its
              tools (glossary Turn). The gutter dot marks the model call. */}
          {turn.role === "assistant" || turn.role === "unknown" ? (
            <div
              aria-hidden="true"
              className="flex h-3 items-center"
              data-slot="trajectory-turn-boundary"
              title="Turn boundary — model called"
            >
              <span className="ml-[2.875rem] h-[5px] w-[5px] rounded-full bg-default/50" />
            </div>
          ) : null}
          {steps.map((step) => (
            <LedgerRow
              isDimmed={!isDimmed && (isStepDimmed?.(step) ?? false)}
              isSelected={step.id === selectedStepId}
              key={step.id}
              role={turn.role}
              rowRef={registerStepRef}
              step={step}
              onSelect={onSelectedStepChange}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

type PiTrajectoryLedgerOwnProps = {
  runs?: TrajectoryRun[];
  emptyLabel?: string;
  /** Alternative to `runs`: render PiTrajectoryLedger.Run rows yourself (virtualization). */
  children?: ReactNode;
  selectedStepId?: string;
  onSelectedStepChange?: (stepId: string) => void;
  /** Focus semantics (Strip brush): dimmed runs stay rendered, greyed out. */
  isDimmed?: boolean;
  /** Focus semantics: dim rows outside the selected swimlane block. */
  isStepDimmed?: (step: TrajectoryStep) => boolean;
  /** True filter: steps not passing it drop out of the ledger. */
  stepFilter?: (step: TrajectoryStep) => boolean;
  registerStepRef?: (stepId: string, element: HTMLButtonElement | null) => void;
  registerTurnRef?: (turnIndex: number, element: HTMLDivElement | null) => void;
};

export type PiTrajectoryLedgerProps = Omit<
  ComponentProps<"div">,
  keyof PiTrajectoryLedgerOwnProps
> &
  PiTrajectoryLedgerOwnProps;

export function PiTrajectoryLedger({
  runs,
  emptyLabel = "No entries.",
  className = "",
  children,
  selectedStepId,
  onSelectedStepChange,
  isDimmed,
  isStepDimmed,
  stepFilter,
  registerStepRef,
  registerTurnRef,
  ...rest
}: PiTrajectoryLedgerProps) {
  const isEmpty = !children && (runs?.length ?? 0) === 0;
  const context: PiTrajectoryLedgerContextValue = {
    selectedStepId,
    onSelectedStepChange,
    isStepDimmed,
    stepFilter,
    registerStepRef,
    registerTurnRef,
  };

  return (
    <PiTrajectoryLedgerContext.Provider value={context}>
      <div className={`font-mono text-xs ${className}`.trim()} data-slot="trajectory-ledger" {...rest}>
        {isEmpty ? (
          <p className="px-3 py-8 text-center text-muted">{emptyLabel}</p>
        ) : (
          (children ??
            runs?.map((run) => <Run isDimmed={isDimmed} key={run.index} run={run} />))
        )}
      </div>
    </PiTrajectoryLedgerContext.Provider>
  );
}

PiTrajectoryLedger.Run = Run;
