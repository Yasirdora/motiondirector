/**
 * Keyed tracks for recipe tests: keys at the start and end of each move, and
 * samples generated from the same moves, so measured movements line up with
 * the keys the way they do in After Effects.
 */
import type { Keyframe, PropertyTrack, Vec } from "../../src/lens/types.js";
import { samplesFor, track, type MoveSpec } from "./synth.js";

export function key(time: number, value: Vec, extra: Partial<Keyframe> = {}): Keyframe {
  const ease = value.map(() => ({ speed: 0, influence: 16.667 }));
  return {
    time,
    value,
    inInterpolation: "linear",
    outInterpolation: "linear",
    inEase: ease,
    outEase: ease.map((e) => ({ ...e })),
    temporalContinuous: false,
    temporalAutoBezier: false,
    ...extra,
  };
}

export function spatialKey(time: number, value: Vec, extra: Partial<Keyframe> = {}): Keyframe {
  return key(time, value, {
    inEase: [{ speed: 0, influence: 16.667 }],
    outEase: [{ speed: 0, influence: 16.667 }],
    inTangent: value.map(() => 0),
    outTangent: value.map(() => 0),
    spatialContinuous: false,
    spatialAutoBezier: false,
    roving: false,
    ...extra,
  });
}

/** A track whose keys and samples both come from the same moves. */
export function keyedTrack(
  kind: Parameters<typeof track>[0],
  moves: MoveSpec[],
  opts: { total?: number; keys?: Keyframe[] } = {},
): PropertyTrack {
  const spatial = kind === "position";
  const make = spatial ? spatialKey : key;
  const keys: Keyframe[] = opts.keys ?? [];
  if (!opts.keys) {
    for (const m of moves) {
      if (!keys.some((k) => Math.abs(k.time - m.start) < 1e-9)) keys.push(make(m.start, m.from));
      keys.push(make(m.start + m.duration, m.to));
    }
  }
  return track(kind, samplesFor(moves, { total: opts.total ?? 3 }), { keys, spatial });
}
