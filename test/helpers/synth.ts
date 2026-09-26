/**
 * Synthetic After Effects readings for tests: curves generated from known
 * easing functions, so every measurement can be checked against the truth.
 */
import type { CompReading, LayerTrack, PropertyTrack, Vec } from "../../src/lens/types.js";

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inCubic: (t: number) => t ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  /** The classic "back" ease-out; overshoots by about 10% with the default constant. */
  outBack: (s = 1.70158) => (t: number) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  /** Winds up backwards first, then travels. */
  inOutBack: (s = 1.70158 * 1.525) => (t: number) =>
    t < 0.5
      ? ((2 * t) ** 2 * ((s + 1) * 2 * t - s)) / 2
      : ((2 * t - 2) ** 2 * ((s + 1) * (t * 2 - 2) + s) + 2) / 2,
  /** Damped spring that settles on the target. */
  spring: (damping = 0.35, cycles = 3) => (t: number) =>
    1 - Math.exp(-damping * 10 * t) * Math.cos(cycles * 2 * Math.PI * t),
  /** Oscillation around the target that never decays: a ping-pong. */
  symmetricBounce: (cycles = 3, amount = 0.15) => (t: number) =>
    t < 0.25 ? ease.outCubic(t / 0.25) : 1 + amount * Math.sin(((t - 0.25) / 0.75) * cycles * 2 * Math.PI),
};

export interface MoveSpec {
  from: Vec;
  to: Vec;
  /** Seconds. */
  start: number;
  duration: number;
  ease?: Ease;
}

/** Sample a sequence of moves on one property at every frame. */
export function samplesFor(
  moves: MoveSpec[],
  opts: { fps?: number; total?: number; initial?: Vec } = {},
): Vec[] {
  const fps = opts.fps ?? 30;
  const total = opts.total ?? 4;
  const count = Math.round(total * fps) + 1;
  const sorted = [...moves].sort((a, b) => a.start - b.start);
  let current: Vec = opts.initial ?? (sorted[0]?.from ?? [0]);
  const out: Vec[] = [];
  for (let f = 0; f < count; f++) {
    const t = f / fps;
    let value = current;
    for (const m of sorted) {
      if (t < m.start) continue;
      // After the move, hold wherever the curve ended; a pulse ends where it began.
      const u = Math.min(1, (t - m.start) / m.duration);
      const e = (m.ease ?? ease.linear)(u);
      value = m.from.map((a, i) => a + ((m.to[i] ?? a) - a) * e);
    }
    out.push(value);
  }
  return out;
}

const MATCH = {
  position: ["ADBE Transform Group", "ADBE Position"],
  scale: ["ADBE Transform Group", "ADBE Scale"],
  rotation: ["ADBE Transform Group", "ADBE Rotate Z"],
  opacity: ["ADBE Transform Group", "ADBE Opacity"],
} as const;

export function track(
  kind: keyof typeof MATCH,
  samples: Vec[],
  extra: Partial<PropertyTrack> = {},
): PropertyTrack {
  const first = samples[0] ?? [0];
  return {
    path: [...MATCH[kind]],
    name: kind[0]!.toUpperCase() + kind.slice(1),
    dimensions: first.length,
    spatial: kind === "position",
    keys: [],
    samples,
    ...extra,
  };
}

let nextLayerId = 100;

export function layer(name: string, properties: PropertyTrack[], extra: Partial<LayerTrack> = {}): LayerTrack {
  const id = extra.id ?? nextLayerId++;
  return {
    id,
    index: 1,
    name,
    type: "shape",
    inPoint: 0,
    outPoint: 10,
    parentId: null,
    enabled: true,
    properties,
    ...extra,
  };
}

export function reading(layers: LayerTrack[], extra: Partial<CompReading> = {}): CompReading {
  const count = layers[0]?.properties[0]?.samples.length ?? 0;
  return {
    compId: 1,
    name: "Test Comp",
    width: 1920,
    height: 1080,
    frameRate: 30,
    duration: (count - 1) / 30,
    sampleStart: 0,
    sampleCount: count,
    layers: layers.map((l, i) => ({ ...l, index: i + 1 })),
    ...extra,
  };
}

/** A single layer with one moving property, for movement-level tests. */
export function single(kind: keyof typeof MATCH, moves: MoveSpec[], opts?: { fps?: number; total?: number }) {
  const t = track(kind, samplesFor(moves, opts));
  const l = layer("Layer", [t]);
  return { track: t, layer: l, comp: { width: 1920, height: 1080, frameRate: opts?.fps ?? 30, sampleStart: 0 } };
}
