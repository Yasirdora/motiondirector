import { dot, subtract } from "../lens/properties.js";
import type { Keyframe, LayerTrack, PropertyTrack, Vec } from "../lens/types.js";

/** A run of keyframes over which a property keeps changing: the keyed counterpart of a Movement. */
export interface KeyedMotion {
  /** Index of the first and last key of the motion in the property's key list. */
  first: number;
  last: number;
}

/** The keys of one property, plus what an edit needs to know about the property. */
export interface KeyTrack {
  layer: Pick<LayerTrack, "id" | "name" | "inPoint" | "outPoint">;
  track: Pick<PropertyTrack, "path" | "name" | "spatial" | "dimensions">;
  keys: Keyframe[];
}

const VALUE_EPSILON = 1e-6;
const TIME_EPSILON = 1e-6;

export function sameValue(a: Vec, b: Vec, epsilon = VALUE_EPSILON): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > epsilon) return false;
  return true;
}

/** Consecutive keys with changing values form one motion; a key pair with equal values is a rest. */
export function keyedMotions(keys: readonly Keyframe[]): KeyedMotion[] {
  const motions: KeyedMotion[] = [];
  let first = -1;
  for (let i = 0; i < keys.length - 1; i++) {
    const changing = !sameValue((keys[i] as Keyframe).value, (keys[i + 1] as Keyframe).value);
    if (changing && first < 0) first = i;
    if (!changing && first >= 0) {
      motions.push({ first, last: i });
      first = -1;
    }
  }
  if (first >= 0) motions.push({ first, last: keys.length - 1 });
  return motions;
}

/**
 * The keyed motion that overlaps a time window the most, or null when none
 * comes within `tolerance` seconds of it. Measured windows are rounded to the
 * frame grid while keys sit at exact times, hence the tolerance.
 */
export function motionForWindow(
  keys: readonly Keyframe[],
  start: number,
  end: number,
  tolerance = 0.05,
): KeyedMotion | null {
  let best: KeyedMotion | null = null;
  let bestOverlap = -Infinity;
  for (const motion of keyedMotions(keys)) {
    const a = (keys[motion.first] as Keyframe).time;
    const b = (keys[motion.last] as Keyframe).time;
    const overlap = Math.min(b, end) - Math.max(a, start);
    if (overlap > bestOverlap) {
      best = motion;
      bestOverlap = overlap;
    }
  }
  return bestOverlap >= -tolerance ? best : null;
}

export function cloneKeys(keys: readonly Keyframe[]): Keyframe[] {
  return keys.map((k) => structuredClone(k));
}

/** Keys must stay in strictly increasing time for After Effects to hold them as given. */
export function checkOrder(keys: readonly Keyframe[]): string | null {
  for (let i = 1; i < keys.length; i++) {
    if ((keys[i] as Keyframe).time <= (keys[i - 1] as Keyframe).time + TIME_EPSILON) {
      return `two keys would land at ${round((keys[i] as Keyframe).time)} s`;
    }
  }
  return null;
}

/** Progress of a value from `from` toward `to`, 0 at from and 1 at to. */
export function progressOf(value: Vec, from: Vec, to: Vec): number {
  const direction = subtract(to, from);
  const length = dot(direction, direction);
  return length > 0 ? dot(subtract(value, from), direction) / length : 0;
}

/** True when a spatial key pair has a straight path (no bezier handles). */
export function straightPath(a: Keyframe, b: Keyframe): boolean {
  const zero = (v: Vec | undefined) => !v || v.every((c) => Math.abs(c) < 1e-3);
  return zero(a.outTangent) && zero(b.inTangent);
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
