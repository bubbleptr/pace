// The Strip (Trajectory Cockpit overview band): Input / Model / Tools swimlanes
// where every column is a segment — a user input, a stretch of model output,
// or a stretch of consecutive tool calls — so the lanes never overlap on one
// column. Click selects that block and jumps the Playhead; drag brushes a
// contiguous segment range (focus semantics: the page dims, never filters);
// hover shows a scrub cursor. Column widths track step count ("steps") or time
// ("duration") — in Time mode every column is measured from Pi's timestamps and
// the spans partition the session rather than overlap: an input column is the
// wait until its run started, never the whole gap the model and tools lanes go
// on to paint. A span Pi never bracketed falls back to an estimate and is
// hatched so the guess never reads as truth. Hatching means "this total is a
// guess", nothing else: a turn whose one measured call spans several model
// segments splits it evenly and stays solid, disclosing the split in its
// tooltip. Validated in the trajectory-cockpit prototype round (2026-08-18).
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import type { TrajectoryTurn } from "@/entities/session/trajectory-model";

/** Inclusive strip-column range (one column = one swimlane block). */
export type SegmentRange = [number, number];
export type StripWidthMode = "steps" | "duration";

export type StripLane = "input" | "model" | "tools";

export type StripSegment = {
  turnIndex: number;
  runIndex: number;
  lane: StripLane;
  isAnnotation: boolean;
  toolCount: number;
  hasError: boolean;
  /**
   * Seconds this segment stands for — measured, or the derived estimate. The
   * layout bounds it (see columnWeight); the tooltip reports it as-is.
   */
  durationSec: number;
  /** True when durationSec is a heuristic guess rather than a measured span. */
  isEstimatedDuration: boolean;
  /**
   * Set on a model segment that is one of several splitting a single measured
   * call: the whole span, so the tooltip can say what the share came from.
   */
  evenShareOfSec?: number;
  stepIds: string[];
  label: string;
  timestamp?: string;
};

const laneColors: Record<StripLane, string> = {
  input: "var(--pigui-data-blue)",
  model: "var(--pigui-data-slate)",
  tools: "var(--pigui-data-orange)",
};

/** Same green as the Ledger's CONTEXT badge: one colour per step type. */
const annotationColor = "var(--pigui-data-green)";

/**
 * Time-mode column weight. Widths are relative, so one 40-minute think would
 * otherwise crush every other column to its minimum width, and a 200ms call would
 * vanish. The bounds match the turn-gap clamp; tooltips report the real value.
 */
function columnWeight(durationSec: number) {
  return Math.min(300, Math.max(0.5, durationSec));
}

function formatSeconds(seconds: number) {
  return seconds < 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Painted-lane alpha: tools deepen with call count, model sits further back. */
function laneOpacity(segment: StripSegment, estimatedWidth: boolean) {
  if (segment.lane === "tools" && !segment.hasError) {
    return Math.min(1, 0.45 + segment.toolCount * 0.04);
  }
  if (segment.lane === "model") {
    return estimatedWidth ? 0.5 : 0.75;
  }
  return 1;
}

function formatCursorTime(value?: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

/**
 * Nominal input width when the run start cannot be derived: a run normally
 * starts within about a second of the submit, so this is the estimate for that
 * wait — hatched like every other guess, never passed off as a measurement.
 */
const nominalInputSeconds = 1;

/**
 * Epoch ms at which this turn's model call opened. Pi stamps the message when
 * the call ends, so the start is that minus the measured latency; an
 * unbracketed call has no start to give.
 */
function modelCallStartMs(turn: TrajectoryTurn) {
  const durationMs = turn.modelDurationMs ?? NaN;
  if (turn.role !== "assistant" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  const endMs = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
  return Number.isFinite(endMs) ? endMs - durationMs : undefined;
}

/** The turn that answers an input: annotations record config, they never run. */
function runTurnAfter(turns: TrajectoryTurn[], index: number) {
  for (let i = index + 1; i < turns.length; i += 1) {
    if (turns[i].role !== "annotation") {
      return turns[i];
    }
  }
  return undefined;
}

/**
 * Input columns stand for the wait between the user's submit and their run
 * actually starting — its first model call opening. The stretch after that
 * belongs to the model and tools lanes, so charging the input lane the full gap
 * to the next turn would paint one span of wall clock twice.
 */
function inputDurationSeconds(turns: TrajectoryTurn[], index: number) {
  const turn = turns[index];
  const submittedMs = turn.role === "user" && turn.timestamp ? Date.parse(turn.timestamp) : NaN;

  if (Number.isFinite(submittedMs)) {
    const run = runTurnAfter(turns, index);
    const startedMs = run ? modelCallStartMs(run) : undefined;
    const seconds = startedMs === undefined ? NaN : (startedMs - submittedMs) / 1000;
    if (Number.isFinite(seconds) && seconds > 0) {
      return { seconds, isEstimated: false };
    }
  }

  return { seconds: nominalInputSeconds, isEstimated: true };
}

/** Gap to the next turn's timestamp, clamped to [1s, 300s]. */
function turnDurationsSeconds(turns: TrajectoryTurn[]): number[] {
  return turns.map((turn, index) => {
    const startMs = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
    const nextTimestamp = turns[index + 1]?.timestamp;
    const endMs = nextTimestamp ? Date.parse(nextTimestamp) : NaN;
    let seconds = (endMs - startMs) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const toolMs = turn.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
      seconds = toolMs > 0 ? toolMs / 1000 : 1;
    }
    return Math.min(300, Math.max(1, seconds));
  });
}

export function stripSegmentsFromTurns(turns: TrajectoryTurn[]): StripSegment[] {
  const turnDurations = turnDurationsSeconds(turns);
  const segments: StripSegment[] = [];

  for (const turn of turns) {
    const duration = turnDurations[turn.index];

    if (turn.role === "user" || turn.role === "annotation") {
      const input = inputDurationSeconds(turns, turn.index);
      segments.push({
        turnIndex: turn.index,
        runIndex: turn.runIndex,
        lane: "input",
        isAnnotation: turn.role === "annotation",
        toolCount: 0,
        hasError: turn.hasError,
        durationSec: input.seconds,
        isEstimatedDuration: input.isEstimated,
        stepIds: turn.steps.map((step) => step.id),
        label: turn.label,
        timestamp: turn.timestamp,
      });
      continue;
    }

    // Assistant/unknown: split steps into alternating model / tools groups.
    type Group = {
      lane: StripLane;
      stepIds: string[];
      toolCount: number;
      hasError: boolean;
      toolSec: number;
    };
    const groups: Group[] = [];
    for (const step of turn.steps) {
      const lane: StripLane = step.kind === "tool" ? "tools" : "model";
      const last = groups[groups.length - 1];
      if (last && last.lane === lane) {
        last.stepIds.push(step.id);
      } else {
        groups.push({ lane, stepIds: [step.id], toolCount: 0, hasError: false, toolSec: 0 });
      }
      const group = groups[groups.length - 1];
      if (lane === "tools") {
        group.toolCount += 1;
        group.toolSec += (step.durationMs ?? 0) / 1000;
        if (step.isError) {
          group.hasError = true;
        }
      }
    }

    const toolsTotalSec = groups.reduce((sum, group) => sum + group.toolSec, 0);
    const modelGroupCount = groups.filter((group) => group.lane === "model").length;
    const measuredModelSec =
      turn.modelDurationMs === undefined ? undefined : turn.modelDurationMs / 1000;
    // One turn is one model call, so its measured latency splits evenly across
    // the turn's model groups (tool time sits outside the call and is not
    // subtracted). Without that measurement, fall back to the residual of the
    // turn gap, capped so idle gaps between runs can't masquerade as model time
    // and dwarf the measured tool activity.
    const modelShareSec =
      modelGroupCount === 0
        ? 0
        : measuredModelSec !== undefined
          ? measuredModelSec / modelGroupCount
          : Math.min(30, Math.max(0.5, (duration - toolsTotalSec) / modelGroupCount));
    // Each share must own up to being a share, so carry the whole it came from.
    const sharedMeasuredSec =
      measuredModelSec !== undefined && modelGroupCount > 1 ? measuredModelSec : undefined;

    for (const group of groups) {
      segments.push({
        turnIndex: turn.index,
        runIndex: turn.runIndex,
        lane: group.lane,
        isAnnotation: false,
        toolCount: group.toolCount,
        hasError: group.hasError,
        durationSec: group.lane === "tools" ? Math.max(0.5, group.toolSec) : modelShareSec,
        isEstimatedDuration: group.lane === "model" && measuredModelSec === undefined,
        evenShareOfSec: group.lane === "model" ? sharedMeasuredSec : undefined,
        stepIds: group.stepIds,
        label: turn.label,
        timestamp: turn.timestamp,
      });
    }

    if (groups.length === 0) {
      segments.push({
        turnIndex: turn.index,
        runIndex: turn.runIndex,
        lane: "model",
        isAnnotation: false,
        toolCount: 0,
        hasError: turn.hasError,
        durationSec: measuredModelSec ?? duration,
        isEstimatedDuration: measuredModelSec === undefined,
        stepIds: [],
        label: turn.label,
        timestamp: turn.timestamp,
      });
    }
  }

  return segments;
}

type PiTrajectoryStripOwnProps = {
  turns: TrajectoryTurn[];
  /** The Playhead step; the segment containing it carries the position marker. */
  selectedStepId?: string;
  /** Called with the segment's turn index and its first step id. */
  onSelect: (turnIndex: number, stepId?: string) => void;
  selectedRange?: SegmentRange;
  onBrush?: (range: SegmentRange | undefined) => void;
  widthMode: StripWidthMode;
  onWidthModeChange: (mode: StripWidthMode) => void;
};

export type PiTrajectoryStripProps = Omit<
  ComponentProps<"div">,
  keyof PiTrajectoryStripOwnProps | "children"
> &
  PiTrajectoryStripOwnProps;

export function PiTrajectoryStrip({
  turns,
  selectedStepId,
  onSelect,
  selectedRange,
  onBrush,
  widthMode,
  onWidthModeChange,
  className,
  ...rest
}: PiTrajectoryStripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ index: number; x: number; y: number } | undefined>(undefined);
  const didDrag = useRef(false);
  const [dragPreview, setDragPreview] = useState<SegmentRange | undefined>(undefined);
  const [cursor, setCursor] = useState<{ x: number; index: number } | undefined>(undefined);

  const segments = stripSegmentsFromTurns(turns);
  // Reserve at most two thirds for column floors and one third for gaps.
  // Fixed 2px columns + 1px gaps overflow long sessions even with min-w-0.
  const densityBudget = Math.max(1, segments.length) * 3;

  function segmentIndexFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track) {
      return 0;
    }
    const columns = Array.from(track.querySelectorAll<HTMLElement>("[data-strip-col]"));
    for (let i = 0; i < columns.length; i += 1) {
      const rect = columns[i].getBoundingClientRect();
      if (clientX < rect.right) {
        return i;
      }
    }
    return columns.length - 1;
  }

  function segmentRange(a: number, b: number): SegmentRange {
    return a <= b ? [a, b] : [b, a];
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onBrush) {
      return;
    }
    dragOrigin.current = {
      index: segmentIndexFromClientX(event.clientX),
      x: event.clientX,
      y: event.clientY,
    };
    didDrag.current = false;
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (track) {
      const rect = track.getBoundingClientRect();
      setCursor({
        x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)),
        index: segmentIndexFromClientX(event.clientX),
      });
    }
    if (!onBrush || dragOrigin.current === undefined) {
      return;
    }
    if (!didDrag.current) {
      const dx = event.clientX - dragOrigin.current.x;
      const dy = event.clientY - dragOrigin.current.y;
      // Narrow columns are often 2px; treat jitter under 4px as a click, not a brush.
      if (dx * dx + dy * dy < 16) {
        return;
      }
      didDrag.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events (tests, automation) have no active pointer.
      }
    }
    const index = segmentIndexFromClientX(event.clientX);
    setDragPreview(segmentRange(dragOrigin.current.index, index));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!onBrush || dragOrigin.current === undefined) {
      return;
    }
    if (didDrag.current) {
      const index = segmentIndexFromClientX(event.clientX);
      onBrush(segmentRange(dragOrigin.current.index, index));
    }
    dragOrigin.current = undefined;
    setDragPreview(undefined);
    // Keep didDrag through the trailing click, then clear so the next click works
    // even if that click event never arrives (pointer captured away from the button).
    queueMicrotask(() => {
      didDrag.current = false;
    });
  }

  const highlightRange = dragPreview ?? selectedRange;

  function isDimmed(segmentIndex: number) {
    return (
      highlightRange !== undefined &&
      (segmentIndex < highlightRange[0] || segmentIndex > highlightRange[1])
    );
  }

  // Selection box (video-editor marquee) measured from real column elements
  // so it stays correct under duration-weighted widths.
  const [boxRect, setBoxRect] = useState<{ left: number; width: number } | undefined>(undefined);

  useLayoutEffect(() => {
    function measure() {
      const track = trackRef.current;
      if (!track || !highlightRange) {
        setBoxRect(undefined);
        return;
      }
      const columns = Array.from(track.querySelectorAll<HTMLElement>("[data-strip-col]"));
      const inRange = columns.filter(
        (_, i) => i >= highlightRange[0] && i <= highlightRange[1],
      );
      const first = inRange[0];
      const last = inRange[inRange.length - 1];
      if (!first || !last) {
        setBoxRect(undefined);
        return;
      }
      setBoxRect({
        left: first.offsetLeft,
        width: last.offsetLeft + last.offsetWidth - first.offsetLeft,
      });
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [highlightRange?.[0], highlightRange?.[1], widthMode, turns.length]);

  const laneLabels = ["Input", "Model", "Tools"];
  const laneOf: Record<StripLane, number> = { input: 0, model: 1, tools: 2 };

  return (
    <div
      className={`flex min-w-0 items-stretch gap-2 ${className ?? ""}`.trim()}
      data-slot="trajectory-strip"
      {...rest}
    >
      <div
        aria-hidden="true"
        className="flex shrink-0 flex-col justify-between py-px text-right font-mono text-[9px] uppercase leading-none tracking-wider text-muted"
      >
        {laneLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div
        className={`relative flex min-w-0 flex-1 items-stretch ${onBrush ? "cursor-crosshair" : ""}`.trim()}
        style={{ columnGap: `min(1px, calc(100% / ${densityBudget}))` }}
        ref={trackRef}
        role="listbox"
        aria-label="Session activity segments"
        onPointerDown={handlePointerDown}
        onPointerLeave={() => setCursor(undefined)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {segments.map((segment, index) => {
          const isActive = selectedStepId !== undefined && segment.stepIds.includes(selectedStepId);
          const dimmed = isDimmed(index);
          const fill = segment.hasError
            ? "var(--danger)"
            : segment.isAnnotation
              ? annotationColor
              : laneColors[segment.lane];
          // Only Time mode encodes duration in the width, so only there can a
          // width be a guess. Hatch + dim it so an estimated span never reads
          // as measured truth.
          const estimatedWidth = widthMode === "duration" && segment.isEstimatedDuration;
          const paint = estimatedWidth
            ? `repeating-linear-gradient(135deg, ${fill} 0 2px, transparent 2px 5px)`
            : fill;
          const durationLabel = segment.isEstimatedDuration
            ? `~${formatSeconds(segment.durationSec)} (estimated)`
            : segment.evenShareOfSec !== undefined
              ? `${formatSeconds(segment.durationSec)} · even share of measured ${formatSeconds(segment.evenShareOfSec)}`
              : formatSeconds(segment.durationSec);

          return (
            <button
              key={index}
              type="button"
              role="option"
              aria-selected={isActive}
              aria-label={`Run ${segment.runIndex + 1} ${segment.lane}${segment.hasError ? " (has error)" : ""}`}
              title={`#${segment.runIndex + 1} ${segment.label} · ${segment.lane}${segment.toolCount ? ` · ${segment.toolCount} tools` : ""}${segment.hasError ? " · error" : ""} · ${durationLabel}`}
              data-strip-col=""
              data-estimated-width={estimatedWidth ? "" : undefined}
              data-focus-dimmed={dimmed ? "" : undefined}
              className="group relative flex cursor-pointer flex-col gap-px"
              style={{
                minWidth: `min(2px, calc(200% / ${densityBudget}))`,
                // Steps mode: width tracks activity volume (36 collapsed tool
                // calls read 36x wider than one think). Time mode: seconds,
                // bounded so no single span can flatten the rest of the strip.
                flexGrow:
                  widthMode === "duration"
                    ? columnWeight(segment.durationSec)
                    : Math.max(1, segment.stepIds.length),
                flexBasis: 0,
                opacity: dimmed ? 0.15 : 1,
              }}
              onClick={() => {
                // A completed drag must not also fire the click-select.
                if (didDrag.current) {
                  didDrag.current = false;
                  return;
                }
                // Brush first so the page can dim the range, then jump the
                // Playhead to this segment (overrides the range's first turn).
                onBrush?.([index, index]);
                onSelect(segment.turnIndex, segment.stepIds[0]);
              }}
            >
              {[0, 1, 2].map((laneIndex) => {
                const painted = laneOf[segment.lane] === laneIndex;

                return (
                  <span
                    aria-hidden="true"
                    className="h-[8px] w-full rounded-[1px]"
                    key={laneIndex}
                    style={{
                      background: painted ? paint : "transparent",
                      opacity: painted ? laneOpacity(segment, estimatedWidth) : 1,
                    }}
                  />
                );
              })}
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-[4px] h-[2px] rounded-full bg-foreground"
                />
              ) : null}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[1px] opacity-0 transition-opacity group-hover:opacity-100"
                style={{ boxShadow: "0 0 0 1px var(--foreground) inset" }}
              />
            </button>
          );
        })}
        {boxRect ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-y-[3px] z-10 rounded-[3px]"
            data-slot="trajectory-strip-selection"
            style={{
              left: boxRect.left - 2,
              width: boxRect.width + 4,
              border: "1.5px solid var(--foreground)",
              boxShadow: "0 0 0 1px var(--background)",
            }}
          />
        ) : null}
        {cursor ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-y-[3px] z-20"
            data-slot="trajectory-strip-cursor"
            style={{ left: cursor.x }}
          >
            <span
              className="absolute inset-y-0 w-px"
              style={{ background: "var(--foreground)", boxShadow: "0 0 0 1px var(--background)" }}
            />
            <span className="absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] leading-none text-background shadow-sm">
              #{(segments[cursor.index]?.runIndex ?? 0) + 1}
              {formatCursorTime(segments[cursor.index]?.timestamp)
                ? ` · ${formatCursorTime(segments[cursor.index]?.timestamp)}`
                : ""}
            </span>
          </span>
        ) : null}
      </div>

      <div
        className="flex shrink-0 flex-col justify-center gap-0.5"
        role="group"
        aria-label="Strip width mode"
      >
        {(
          [
            ["steps", "Steps"],
            ["duration", "Time"],
          ] as Array<[StripWidthMode, string]>
        ).map(([mode, label]) => (
          <button
            aria-pressed={widthMode === mode}
            className={`cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors ${
              widthMode === mode
                ? "bg-foreground text-background"
                : "text-muted hover:bg-surface-hover hover:text-foreground"
            }`}
            key={mode}
            type="button"
            onClick={() => onWidthModeChange(mode)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
