import { distance } from "./properties.js";
import type { CompReading, Keyframe, PropertyTrack, Vec } from "./types.js";

/**
 * Evaluate keyframes the way After Effects interpolates them, to predict how
 * an edit will move before it is rehearsed in After Effects.
 *
 * A temporal ease is a cubic bezier in (time, value): the outgoing handle of
 * key A sits `influence × Δt` later with slope `speed`, and the incoming handle
 * of key B the same distance earlier. Spatial properties ease their progress
 * along the path, which is modelled here as a straight line between keys.
 * Predictions are always labelled as such; only a reading from After Effects
 * counts as measured.
 */
export function valueAt(track: Pick<PropertyTrack, "keys" | "spatial" | "dimensions">, time: number): Vec {
  const keys = track.keys;
  const first = keys[0];
  if (!first) return [];
  if (time <= first.time) return [...first.value];
  const last = keys[keys.length - 1] as Keyframe;
  if (time >= last.time) return [...last.value];

  let i = 0;
  while (i < keys.length - 2 && (keys[i + 1] as Keyframe).time <= time) i++;
  const a = keys[i] as Keyframe;
  const b = keys[i + 1] as Keyframe;
  if (a.outInterpolation === "hold") return [...a.value];

  const dt = b.time - a.time;
  const linear = a.outInterpolation === "linear" && b.inInterpolation === "linear";
  if (track.spatial) {
    const length = distance(b.value, a.value);
    const progress = linear || length === 0
      ? (time - a.time) / dt
      : bezierAt(a.time, 0, b.time, length, a.outEase[0], b.inEase[0], a.outInterpolation, b.inInterpolation, time) / length;
    return a.value.map((v, d) => v + ((b.value[d] ?? v) - v) * progress);
  }
  return a.value.map((v, d) => {
    const target = b.value[d] ?? v;
    if (linear) return v + (target - v) * ((time - a.time) / dt);
    return bezierAt(a.time, v, b.time, target, a.outEase[d], b.inEase[d], a.outInterpolation, b.inInterpolation, time);
  });
}

function bezierAt(
  t0: number,
  v0: number,
  t1: number,
  v1: number,
  out: { speed: number; influence: number } | undefined,
  inn: { speed: number; influence: number } | undefined,
  outInterpolation: Keyframe["outInterpolation"],
  inInterpolation: Keyframe["inInterpolation"],
  time: number,
): number {
  const dt = t1 - t0;
  const averageSlope = (v1 - v0) / dt;
  // A linear side behaves like a handle a third of the way along with the average slope.
  const outSpeed = outInterpolation === "linear" ? averageSlope : out?.speed ?? 0;
  const outReach = outInterpolation === "linear" ? 1 / 3 : (out?.influence ?? 33.333) / 100;
  const inSpeed = inInterpolation === "linear" ? averageSlope : inn?.speed ?? 0;
  const inReach = inInterpolation === "linear" ? 1 / 3 : (inn?.influence ?? 33.333) / 100;

  const x1 = t0 + outReach * dt;
  const y1 = v0 + outSpeed * outReach * dt;
  const x2 = t1 - inReach * dt;
  const y2 = v1 - inSpeed * inReach * dt;

  const u = solveBezierX(t0, x1, x2, t1, time);
  return cubic(v0, y1, y2, v1, u);
}

function cubic(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
}

/** Find u with x(u) = target by bisection; x is monotonic because influences stay within 0–100%. */
function solveBezierX(x0: number, x1: number, x2: number, x3: number, target: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(x0, x1, x2, x3, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Re-sample every keyed property of a reading, e.g. after applying an edit plan to its keys. */
export function resampleReading(reading: CompReading): CompReading {
  return {
    ...reading,
    layers: reading.layers.map((layer) => ({
      ...layer,
      properties: layer.properties.map((track) =>
        track.keys.length < 2 || (track.expression?.enabled && track.expression.text.trim())
          ? track
          : {
              ...track,
              samples: Array.from({ length: reading.sampleCount }, (_, f) =>
                valueAt(track, reading.sampleStart + f / reading.frameRate),
              ),
            },
      ),
    })),
  };
}
