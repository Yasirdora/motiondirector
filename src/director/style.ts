import type { EaseShape, LayerEvent, MotionScore, Movement } from "../lens/types.js";

/**
 * A motion language, learned by measuring comps the designer likes rather
 * than by asking them to describe it: how things ease, how long they take by
 * role, how far apart they are staggered and how much they overshoot. Every
 * later change can then be checked against it.
 */
export interface Range {
  min: number;
  median: number;
  max: number;
  samples: number;
}

export interface MotionStyle {
  name: string;
  learnedAt: string;
  learnedFrom: { compName: string; fingerprint: string }[];
  easing: { shares: Partial<Record<EaseShape, number>>; dominant: EaseShape | null };
  durations: Partial<Record<LayerEvent["role"], Range>>;
  stagger: Range | null;
  overshoot: { share: number; typical: number; max: number };
  /** Honest limits of what was learned, e.g. too few examples. */
  notes: string[];
}

export interface StyleDeviation {
  aspect: "easing" | "duration" | "stagger" | "overshoot";
  message: string;
  layerName?: string;
  start?: number;
}

const SHAPED: EaseShape[] = ["linear", "ease-in", "ease-out", "ease-in-out", "irregular"];

function styled(m: Movement, score: MotionScore): boolean {
  const frame = 1 / score.frameRate;
  const continuous = m.startTime <= score.range.start + frame && m.endTime >= score.range.end - frame;
  const visible = m.kind === "opacity" ? m.amplitude >= 20 : m.significance >= 0.01;
  return visible && !continuous && SHAPED.includes(m.shape);
}

export function learnStyle(name: string, scores: MotionScore[], now = new Date()): MotionStyle {
  const movements = scores.flatMap((s) => s.movements.filter((m) => styled(m, s)));
  const events = scores.flatMap((s) => s.events);
  const notes: string[] = [];

  const shares: Partial<Record<EaseShape, number>> = {};
  for (const m of movements) shares[m.shape] = (shares[m.shape] ?? 0) + 1;
  for (const k of Object.keys(shares) as EaseShape[]) shares[k] = round((shares[k] as number) / movements.length);
  const dominant = (Object.entries(shares) as [EaseShape, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const durations: MotionStyle["durations"] = {};
  for (const role of ["entrance", "action", "exit"] as const) {
    const range = rangeOf(events.filter((e) => e.role === role).map((e) => e.duration));
    if (range) durations[role] = range;
  }

  const staggers = scores.flatMap((s) => s.choreography.staggerIntervals).filter((g) => g >= 0.02 && g <= 0.5);
  const overshooting = movements.filter((m) => m.overshoot > 0.01);

  if (scores.length < 2) notes.push("Learned from a single comp; add another you like for a firmer style.");
  if (movements.length < 6) notes.push(`Only ${movements.length} movements to learn from; treat the ranges as rough.`);
  if (staggers.length === 0) notes.push("No staggers in the examples, so stagger is not part of this style.");

  return {
    name,
    learnedAt: now.toISOString(),
    learnedFrom: scores.map((s) => ({ compName: s.compName, fingerprint: s.fingerprint })),
    easing: { shares, dominant },
    durations,
    stagger: rangeOf(staggers),
    overshoot: {
      share: movements.length ? round(overshooting.length / movements.length) : 0,
      typical: round(median(overshooting.map((m) => m.overshoot)) ?? 0),
      max: round(Math.max(0, ...overshooting.map((m) => m.overshoot))),
    },
    notes,
  };
}

export function checkStyle(style: MotionStyle, score: MotionScore): StyleDeviation[] {
  const out: StyleDeviation[] = [];

  for (const m of score.movements.filter((mv) => styled(mv, score))) {
    if ((style.easing.shares[m.shape] ?? 0) < 0.1) {
      out.push({
        aspect: "easing",
        message: `${m.layerName} › ${m.propertyName} moves ${m.shape.replace(/-/g, " ")}, which this style ${style.easing.dominant ? `doesn't use (it mostly eases ${style.easing.dominant.replace(/^ease-/, "")})` : "doesn't use"}.`,
        layerName: m.layerName,
        start: m.startTime,
      });
    }
    if (m.overshoot > style.overshoot.max * 1.5 + 0.02) {
      out.push({
        aspect: "overshoot",
        message: `${m.layerName} › ${m.propertyName} overshoots by ${pct(m.overshoot)}; this style goes up to ${pct(style.overshoot.max)}.`,
        layerName: m.layerName,
        start: m.startTime,
      });
    }
  }

  for (const e of score.events) {
    const range = style.durations[e.role];
    if (!range) continue;
    if (e.duration < range.min * 0.8 || e.duration > range.max * 1.25) {
      out.push({
        aspect: "duration",
        message: `${e.layerName}'s ${e.role} takes ${ms(e.duration)}; in this style ${e.role}s take ${ms(range.min)}–${ms(range.max)}.`,
        layerName: e.layerName,
        start: e.startTime,
      });
    }
  }

  if (style.stagger) {
    const { choreography } = score;
    const simultaneous = score.events.length >= 3 && choreography.simultaneousStartRatio >= 0.5;
    const intervals = choreography.staggerIntervals.filter((g) => g <= 0.5);
    const off = intervals.filter((g) => g < style.stagger!.min * 0.7 || g > style.stagger!.max * 1.4);
    if (simultaneous) {
      out.push({ aspect: "stagger", message: `Elements start together; this style staggers them about ${ms(style.stagger.median)} apart.` });
    } else if (off.length > 0) {
      out.push({ aspect: "stagger", message: `Staggers of ${off.map(ms).join(", ")}; this style uses ${ms(style.stagger.min)}–${ms(style.stagger.max)}.` });
    }
  }
  return out;
}

function rangeOf(values: number[]): Range | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(quantile(sorted, 0.1)),
    median: round(quantile(sorted, 0.5)),
    max: round(quantile(sorted, 0.9)),
    samples: values.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

const ms = (s: number) => `${Math.round(s * 1000)} ms`;
const pct = (f: number) => `${Math.round(f * 100)}%`;

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
