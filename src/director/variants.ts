import type { Critique } from "../critic/critic.js";
import type { Axis, DetectorId, Finding } from "../critic/detectors.js";
import type { LayerEvent, MotionScore, Movement } from "../lens/types.js";
import type { EasePreset } from "./ease.js";
import type { RecipeStep } from "./recipes.js";

export type Intensity = "subtle" | "medium" | "bold";

export interface Variant {
  id: "A" | "B" | "C";
  label: string;
  /** What this variant tries, in a designer's words. */
  intent: string;
  steps: RecipeStep[];
}

export interface VariantSuggestion {
  variants: Variant[];
  /** Findings no recipe can fix without a creative decision (e.g. what an element should do instead of fading). */
  needsDesigner: Finding[];
}

const STAGGER: Record<Intensity, number> = { subtle: 0.04, medium: 0.07, bold: 0.11 };
const FOLLOW: Record<Intensity, number> = { subtle: 0.03, medium: 0.06, bold: 0.1 };
const SOFTEN: Record<Intensity, number> = { subtle: 0.7, medium: 0.5, bold: 0.3 };
const HIERARCHY: Record<Intensity, number> = { subtle: 0.2, medium: 0.4, bold: 0.6 };

/** Detectors a recipe can address, and the aspect each belongs to. */
const FIXABLE: Partial<Record<DetectorId, Axis>> = {
  "linear-easing": "feel",
  "hard-stop": "feel",
  "sluggish-tail": "feel",
  "no-follow-through": "feel",
  "ping-pong-bounce": "feel",
  "heavy-overshoot": "feel",
  "abrupt-move": "feel",
  "simultaneous-start": "choreography",
  "simultaneous-landing": "choreography",
  "uniform-duration": "choreography",
};

/**
 * Turn a critique into up to three variants worth comparing side by side.
 *
 * When findings span choreography and feel, the variants separate them
 * (choreography only, feel only, both), so the designer sees which one
 * matters. When they touch one aspect, the variants differ in intensity.
 */
export function suggestVariants(
  result: Critique,
  score: MotionScore,
  options: { axes?: Axis[]; findings?: DetectorId[] } = {},
): VariantSuggestion {
  const relevant = result.findings.filter(
    (f) =>
      (!options.findings || options.findings.includes(f.detector)) &&
      (!options.axes || options.axes.includes(f.axis)),
  );
  const needsDesigner = relevant.filter((f) => !FIXABLE[f.detector]);
  const fixable = relevant.filter((f) => FIXABLE[f.detector]);
  const axes = [...new Set(fixable.map((f) => FIXABLE[f.detector] as Axis))];

  if (fixable.length === 0) return { variants: [], needsDesigner };

  const stepsFor = (axis: Axis | "all", intensity: Intensity) =>
    fixable
      .filter((f) => axis === "all" || FIXABLE[f.detector] === axis)
      .flatMap((f) => stepsForFinding(f, score, intensity));

  let variants: Variant[];
  if (axes.includes("choreography") && axes.includes("feel")) {
    variants = [
      { id: "A", label: "Choreography", intent: "Only when things move: staggered starts and a clearer order.", steps: merge(stepsFor("choreography", "medium")) },
      { id: "B", label: "Feel", intent: "Only how each move accelerates and settles.", steps: merge(stepsFor("feel", "medium")) },
      { id: "C", label: "Both", intent: "Choreography and feel together.", steps: merge(stepsFor("all", "medium")) },
    ];
  } else {
    variants = (["subtle", "medium", "bold"] as const).map((intensity, i) => ({
      id: (["A", "B", "C"] as const)[i] as Variant["id"],
      label: intensity[0]!.toUpperCase() + intensity.slice(1),
      intent: `The same fix, ${intensity === "subtle" ? "barely" : intensity === "medium" ? "clearly" : "strongly"} applied.`,
      steps: merge(stepsFor("all", intensity)),
    }));
  }
  return { variants: variants.filter((v) => v.steps.length > 0), needsDesigner };
}

function stepsForFinding(finding: Finding, score: MotionScore, intensity: Intensity): RecipeStep[] {
  const movementIds = new Set(finding.evidence.map((e) => e.movementId));
  const eventIds = new Set(finding.evidence.map((e) => e.eventId));
  const flagged = score.movements.filter((m) => movementIds.has(m.id));
  const flaggedEvents = score.events.filter((e) => eventIds.has(e.id));

  switch (finding.detector) {
    case "linear-easing":
    case "hard-stop":
      return byRole(flagged, score).map(([preset, ids]) => ({ recipe: "re-ease", preset, movements: ids }));
    case "sluggish-tail":
      return [{ recipe: "re-ease", preset: "soft-out", movements: flagged.map((m) => m.id) }];
    case "no-follow-through":
      return [{ recipe: "follow-through", overshoot: FOLLOW[intensity], movements: flagged.filter((m) => m.kind !== "rotation").map((m) => m.id) }];
    case "ping-pong-bounce":
    case "heavy-overshoot":
      return [{ recipe: "soften-overshoot", factor: SOFTEN[intensity], movements: flagged.map((m) => m.id) }];
    case "abrupt-move": {
      const factors: Record<string, number> = {};
      for (const e of eventsOf(flagged, score)) factors[e.id] = Math.min(3, 0.25 / Math.max(e.duration, 1 / score.frameRate));
      return [{ recipe: "retime", factor: factors, events: Object.keys(factors) }];
    }
    case "simultaneous-start":
    case "simultaneous-landing": {
      // Most important first: the eye should land on the lead element.
      const ordered = [...flaggedEvents].sort((a, b) => b.significance - a.significance || a.layerId - b.layerId);
      return [{ recipe: "stagger", interval: STAGGER[intensity], events: ordered.map((e) => e.id) }];
    }
    case "uniform-duration": {
      const events = [...flaggedEvents].sort((a, b) => b.significance - a.significance);
      const spread = HIERARCHY[intensity];
      const factors: Record<string, number> = {};
      events.forEach((e, i) => {
        const rank = events.length > 1 ? 1 - i / (events.length - 1) : 1;
        factors[e.id] = round(1 - spread / 2 + spread * rank);
      });
      return [{ recipe: "retime", factor: factors, events: events.map((e) => e.id) }];
    }
    default:
      return [];
  }
}

/** Entrances ease out, exits ease in, everything else eases in and out. */
function byRole(movements: Movement[], score: MotionScore): [EasePreset, string[]][] {
  const groups = new Map<EasePreset, string[]>();
  for (const m of movements) {
    const event = score.events.find((e) => e.movementIds.includes(m.id));
    const preset: EasePreset = event?.role === "exit" ? "ease-in" : event?.role === "entrance" ? "ease-out" : "ease-in-out";
    groups.set(preset, [...(groups.get(preset) ?? []), m.id]);
  }
  return [...groups.entries()];
}

function eventsOf(movements: Movement[], score: MotionScore): LayerEvent[] {
  return score.events.filter((e) => movements.some((m) => e.movementIds.includes(m.id)));
}

/**
 * Several findings can ask for the same recipe (both simultaneous starts and
 * landings ask for a stagger). Keep one step per recipe and preset, uniting
 * their targets; the first stagger wins because a second one would stack.
 */
function merge(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const step of steps) {
    const same = out.find(
      (s) => s.recipe === step.recipe && (s.recipe !== "re-ease" || step.recipe !== "re-ease" || s.preset === step.preset),
    );
    if (!same) {
      out.push(structuredClone(step));
      continue;
    }
    if (same.recipe === "stagger") continue;
    if ("movements" in same && "movements" in step) same.movements = [...new Set([...same.movements, ...step.movements])];
    if (same.recipe === "retime" && step.recipe === "retime") {
      same.events = [...new Set([...same.events, ...step.events])];
      if (typeof same.factor === "object" && typeof step.factor === "object") same.factor = { ...step.factor, ...same.factor };
    }
  }
  return out.filter((s) => ("movements" in s ? s.movements.length > 0 : s.events.length > 0));
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
