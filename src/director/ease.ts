import { distance } from "../lens/properties.js";
import type { Keyframe, PropertyTrack, TemporalEase } from "../lens/types.js";

/** A CSS-style cubic-bezier easing curve: (x1, y1, x2, y2). */
export type Bezier = readonly [number, number, number, number];

/**
 * Named eases a designer can ask for. The values are the familiar curves from
 * CSS and motion systems, so "ease out" means what it means everywhere else.
 */
export const EASE_PRESETS = {
  /**
   * Fast start, gentle arrival: the default for entrances. Cubic rather than
   * expo: an expo ease-out spends about 45% of its time on the last 5% of the
   * distance, which the Critic (rightly) measures as creeping into place.
   */
  "ease-out": [0.33, 1, 0.68, 1],
  /** A softer arrival for small or secondary elements. */
  "soft-out": [0.25, 0.46, 0.45, 0.94],
  /** Accelerate and decelerate: for moves between two resting states. */
  "ease-in-out": [0.65, 0, 0.35, 1],
  /** Gather speed and leave: for exits. */
  "ease-in": [0.55, 0, 1, 0.45],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, Bezier>;

export type EasePreset = keyof typeof EASE_PRESETS;

const MIN_INFLUENCE = 0.1;

/**
 * After Effects stores eases as speed and influence at each key, not as a
 * bezier. For a segment from key A to key B with average speed v:
 *
 *   A.out.influence = x1 · 100      A.out.speed = (y1 / x1) · v
 *   B.in.influence  = (1 − x2) · 100 B.in.speed  = ((1 − y2) / (1 − x2)) · v
 *
 * Spatial properties (Position) take one ease for the whole path; the others
 * take one per dimension. That arity belongs to the property, not the value
 * (Engine Room measured the failure when it is guessed).
 */
export function easeSegment(
  a: Keyframe,
  b: Keyframe,
  track: Pick<PropertyTrack, "spatial" | "dimensions">,
  curve: Bezier,
): { out: TemporalEase[]; in: TemporalEase[] } {
  const [x1, y1, x2, y2] = curve;
  const dt = b.time - a.time;
  const averages = track.spatial
    ? [dt > 0 ? distance(b.value, a.value) / dt : 0]
    : Array.from({ length: track.dimensions }, (_, i) => (dt > 0 ? ((b.value[i] ?? 0) - (a.value[i] ?? 0)) / dt : 0));

  const outInfluence = clampInfluence(x1 * 100);
  const inInfluence = clampInfluence((1 - x2) * 100);
  const outFactor = x1 > 0 ? y1 / x1 : 0;
  const inFactor = 1 - x2 > 0 ? (1 - y2) / (1 - x2) : 0;

  return {
    out: averages.map((v) => ({ speed: round(v * outFactor), influence: outInfluence })),
    in: averages.map((v) => ({ speed: round(v * inFactor), influence: inInfluence })),
  };
}

/** Zero-speed ease at a key where motion turns around (the peak of an overshoot). */
export function stillEase(track: Pick<PropertyTrack, "spatial" | "dimensions">, influence: number): TemporalEase[] {
  const count = track.spatial ? 1 : track.dimensions;
  return Array.from({ length: count }, () => ({ speed: 0, influence: clampInfluence(influence) }));
}

function clampInfluence(value: number): number {
  return round(Math.min(100, Math.max(MIN_INFLUENCE, value)));
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
