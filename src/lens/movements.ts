import {
  distance,
  dot,
  magnitude,
  minimumAmplitude,
  noiseFloor,
  propertyKey,
  propertyKind,
  significance,
  subtract,
  trackRange,
} from "./properties.js";
import type { EaseShape, LayerTrack, Movement, PropertyTrack, Vec } from "./types.js";

export interface CompGeometry {
  width: number;
  height: number;
  frameRate: number;
  sampleStart: number;
}

/** Below this fraction of peak speed a frame counts as "still". */
const STILL_FRACTION = 0.02;
/** Still gaps this short inside a movement do not split it (frames). */
const MAX_INTERNAL_GAP = 1;
/** A smaller reverse move starting within this many frames is the settle of the one before. */
const MAX_SETTLE_GAP = 3;
/** Edge speed at or above this fraction of peak means the movement starts or stops at speed. */
const HARD_EDGE = 0.7;
/** Edge speed below this fraction of peak means it eases. */
const SOFT_EDGE = 0.5;
/** Tolerance band around the target, as a fraction of amplitude. */
const ARRIVAL_BAND = 0.02;
const SPEED_PROFILE_POINTS = 24;

interface Run {
  /** First moving interval (between sample s and s+1). */
  s: number;
  /** Last moving interval, inclusive. */
  e: number;
}

/**
 * Split one property's sampled curve into movements and measure each.
 *
 * Works on sampled values rather than keyframes, so expressions, parenting of
 * keyframes and eases are all measured as they actually play.
 */
export function findMovements(
  track: PropertyTrack,
  layer: LayerTrack,
  comp: CompGeometry,
): Movement[] {
  const samples = track.samples;
  if (samples.length < 2) return [];

  const kind = propertyKind(track.path);
  const steps = frameSteps(samples);
  const peak = Math.max(...steps);
  const floor = noiseFloor(kind);
  if (!(peak > floor)) return [];

  const threshold = Math.max(floor, STILL_FRACTION * peak);
  const runs = extendToRest(
    steps,
    floor,
    mergeSettles(samples, joinRuns(movingRuns(steps, threshold))),
  );
  const range = trackRange(samples);

  const movements: Movement[] = [];
  for (const run of runs) {
    const movement = measure(run, track, layer, comp, steps, kind, range);
    if (movement) movements.push(movement);
  }
  return movements;
}

/** Distance travelled between consecutive samples, in property units per frame. */
function frameSteps(samples: readonly Vec[]): number[] {
  const out = new Array<number>(samples.length - 1);
  for (let i = 0; i < samples.length - 1; i++) {
    out[i] = distance(samples[i + 1] as Vec, samples[i] as Vec);
  }
  return out;
}

function movingRuns(steps: readonly number[], threshold: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i < steps.length; i++) {
    const moving = (steps[i] as number) > threshold;
    if (moving && start < 0) start = i;
    if (!moving && start >= 0) {
      runs.push({ s: start, e: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ s: start, e: steps.length - 1 });
  return runs;
}

/** A single still frame inside a movement (e.g. the turn of an overshoot) does not end it. */
function joinRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && run.s - last.e - 1 <= MAX_INTERNAL_GAP) last.e = run.e;
    else out.push({ ...run });
  }
  return out;
}

/**
 * Fold settle and bounce-back runs into the movement they belong to: a run
 * that starts right after another, goes the opposite way and travels less is
 * that movement coming to rest, not a new one.
 */
function mergeSettles(samples: readonly Vec[], runs: Run[]): Run[] {
  const out: Run[] = [];
  let lastPart: Run | null = null;
  for (const run of runs) {
    const current = out[out.length - 1];
    if (current && lastPart && run.s - current.e - 1 <= MAX_SETTLE_GAP) {
      const previousNet = subtract(samples[lastPart.e + 1] as Vec, samples[lastPart.s] as Vec);
      const net = subtract(samples[run.e + 1] as Vec, samples[run.s] as Vec);
      // "No further than it came" (with a little slack) covers both a settle
      // and the return half of a pulse.
      if (dot(previousNet, net) < 0 && magnitude(net) <= magnitude(previousNet) * 1.05) {
        current.e = run.e;
        lastPart = run;
        continue;
      }
    }
    out.push({ ...run });
    lastPart = run;
  }
  return out;
}

/**
 * Splitting uses a threshold relative to the peak speed, which cuts off a slow
 * creep at the start or end that is still visible. Grow each movement outward
 * while it is still moving by more than the noise floor, without running into
 * its neighbours, so a sluggish tail is measured rather than hidden.
 */
function extendToRest(steps: readonly number[], floor: number, runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  for (let j = 0; j < out.length; j++) {
    const run = out[j] as Run;
    const lowerLimit = j > 0 ? (out[j - 1] as Run).e + 1 : 0;
    const upperLimit = j < out.length - 1 ? (out[j + 1] as Run).s - 1 : steps.length - 1;
    while (run.s > lowerLimit && (steps[run.s - 1] as number) > floor) run.s--;
    while (run.e < upperLimit && (steps[run.e + 1] as number) > floor) run.e++;
  }
  return out;
}

function measure(
  run: Run,
  track: PropertyTrack,
  layer: LayerTrack,
  comp: CompGeometry,
  steps: readonly number[],
  kind: Movement["kind"],
  range: number,
): Movement | null {
  const samples = track.samples;
  const fps = comp.frameRate;
  const first = run.s;
  const last = run.e + 1; // sample index where the movement has finished
  const from = samples[first] as Vec;
  const to = samples[last] as Vec;
  const net = subtract(to, from);
  const netLength = magnitude(net);

  let maxExcursion = 0;
  for (let k = first; k <= last; k++) {
    maxExcursion = Math.max(maxExcursion, distance(samples[k] as Vec, from));
  }
  const minimum = minimumAmplitude(kind);
  if (Math.max(netLength, maxExcursion) < minimum || maxExcursion === 0) return null;

  const runSteps = steps.slice(run.s, run.e + 1);
  const peakStep = Math.max(...runSteps);
  const base: Omit<
    Movement,
    | "shape"
    | "amplitude"
    | "overshoot"
    | "oscillations"
    | "decay"
    | "anticipation"
    | "settleTime"
    | "tailFraction"
    | "peakAt"
    | "startSpeedRatio"
    | "endSpeedRatio"
    | "significance"
  > = {
    id: `${layer.id}:${propertyKey(track)}:${run.s}`,
    layerId: layer.id,
    layerName: layer.name,
    property: propertyKey(track),
    propertyName: track.name,
    kind,
    startTime: round(comp.sampleStart + first / fps),
    endTime: round(comp.sampleStart + last / fps),
    duration: round((last - first) / fps),
    from,
    to,
    peakSpeed: peakStep * fps,
    speedProfile: resample(runSteps.map((s) => s / peakStep), SPEED_PROFILE_POINTS),
    expressionDriven: Boolean(track.expression?.enabled && track.expression.text.trim()),
  };

  // A movement that ends roughly where it began (a pulse, a shake) has no
  // direction to measure progress along.
  if (netLength < 0.25 * maxExcursion) {
    const edges = edgeRatios(runSteps);
    return {
      ...base,
      shape: "excursion",
      amplitude: maxExcursion,
      significance: significance(kind, maxExcursion, comp, range),
      peakAt: edges.peakAt,
      startSpeedRatio: edges.start,
      endSpeedRatio: edges.end,
      overshoot: 0,
      oscillations: 0,
      decay: null,
      anticipation: 0,
      settleTime: 0,
      tailFraction: 0,
    };
  }

  const direction = net.map((c) => c / netLength);
  const progress: number[] = [];
  for (let k = first; k <= last; k++) {
    progress.push(dot(subtract(samples[k] as Vec, from), direction) / netLength);
  }

  // The approach ends where the movement first turns back after nearly
  // arriving: the peak of an overshoot, or the end when there is none.
  let turn = progress.length - 1;
  for (let k = 0; k < progress.length - 1; k++) {
    const here = progress[k] as number;
    if (here >= 0.9 && (progress[k + 1] as number) < here - 1e-6) {
      turn = k;
      break;
    }
  }
  const approach = runSteps.slice(0, Math.max(1, turn));
  const edges = edgeRatios(approach);

  const maxProgress = Math.max(...progress);
  const overshoot = maxProgress - 1 > 0.005 ? maxProgress - 1 : 0;

  const peakIndex = approach.indexOf(Math.max(...approach));
  let minBeforePeak = 0;
  for (let k = 0; k <= peakIndex; k++) minBeforePeak = Math.min(minBeforePeak, progress[k] as number);
  const anticipation = -minBeforePeak > 0.005 ? -minBeforePeak : 0;

  const { oscillations, decay } = oscillation(progress);
  const settleTime = settle(progress) / fps;
  const tailStart = progress.findIndex((p) => p >= 0.95);
  const tailFraction = tailStart >= 0 ? (progress.length - 1 - tailStart) / (progress.length - 1) : 0;

  return {
    ...base,
    shape: classify(approach, edges),
    amplitude: netLength,
    significance: significance(kind, netLength, comp, range),
    peakAt: edges.peakAt,
    startSpeedRatio: edges.start,
    endSpeedRatio: edges.end,
    overshoot: round(overshoot, 4),
    oscillations,
    decay,
    anticipation: round(anticipation, 4),
    settleTime: round(settleTime),
    tailFraction: round(tailFraction, 4),
  };
}

function edgeRatios(steps: readonly number[]): { start: number; end: number; peakAt: number } {
  const peak = Math.max(...steps);
  if (!(peak > 0)) return { start: 0, end: 0, peakAt: 0 };
  const peakIndex = steps.indexOf(peak);
  return {
    start: round((steps[0] as number) / peak, 4),
    end: round((steps[steps.length - 1] as number) / peak, 4),
    peakAt: steps.length > 1 ? round(peakIndex / (steps.length - 1), 4) : 0,
  };
}

function classify(steps: readonly number[], edges: { start: number; end: number }): EaseShape {
  if (steps.length <= 1) return "jump";
  const hardStart = edges.start >= HARD_EDGE;
  const hardEnd = edges.end >= HARD_EDGE;
  if (hardStart && hardEnd) return middleVariation(steps) < 0.15 ? "linear" : "irregular";
  const softStart = edges.start < SOFT_EDGE;
  const softEnd = edges.end < SOFT_EDGE;
  if (softStart && softEnd) return "ease-in-out";
  if (!softStart && softEnd) return "ease-out";
  if (softStart && !softEnd) return "ease-in";
  return "irregular";
}

/** Coefficient of variation of speed over the middle 60% of a movement. */
function middleVariation(steps: readonly number[]): number {
  const from = Math.floor(steps.length * 0.2);
  const to = Math.max(from + 1, Math.ceil(steps.length * 0.8));
  const middle = steps.slice(from, to);
  const mean = middle.reduce((a, b) => a + b, 0) / middle.length;
  if (!(mean > 0)) return 0;
  const variance = middle.reduce((a, b) => a + (b - mean) ** 2, 0) / middle.length;
  return Math.sqrt(variance) / mean;
}

/** Crossings of the target after first reaching it, and how fast the swings shrink. */
function oscillation(progress: readonly number[]): { oscillations: number; decay: number | null } {
  const arrival = progress.findIndex((p) => p >= 1 - ARRIVAL_BAND);
  if (arrival < 0) return { oscillations: 0, decay: null };

  const lobes: number[] = [];
  let side = 0;
  let lobePeak = 0;
  let crossings = 0;
  for (let k = arrival; k < progress.length; k++) {
    const offset = (progress[k] as number) - 1;
    if (Math.abs(offset) <= ARRIVAL_BAND / 2) continue;
    const s = Math.sign(offset);
    if (side !== 0 && s !== side) {
      crossings++;
      lobes.push(lobePeak);
      lobePeak = 0;
    }
    side = s;
    lobePeak = Math.max(lobePeak, Math.abs(offset));
  }
  if (lobePeak > 0) lobes.push(lobePeak);

  const ratios: number[] = [];
  for (let j = 1; j < lobes.length; j++) {
    const previous = lobes[j - 1] as number;
    if (previous > 0) ratios.push((lobes[j] as number) / previous);
  }
  const decay = ratios.length >= 1 && lobes.length >= 3
    ? round(ratios.reduce((a, b) => a + b, 0) / ratios.length, 4)
    : null;
  return { oscillations: crossings, decay };
}

/** Frames from first arriving within the band until the movement stays inside it. */
function settle(progress: readonly number[]): number {
  const arrival = progress.findIndex((p) => Math.abs(p - 1) <= ARRIVAL_BAND);
  if (arrival < 0) return 0;
  let lastOutside = -1;
  for (let k = arrival; k < progress.length; k++) {
    if (Math.abs((progress[k] as number) - 1) > ARRIVAL_BAND) lastOutside = k;
  }
  return lastOutside < 0 ? 0 : lastOutside + 1 - arrival;
}

/** Linear resampling of a profile to a fixed number of points. */
export function resample(values: readonly number[], points: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return new Array<number>(points).fill(values[0] as number);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * (values.length - 1);
    const lo = Math.floor(x);
    const hi = Math.min(values.length - 1, lo + 1);
    const t = x - lo;
    out.push(round((values[lo] as number) * (1 - t) + (values[hi] as number) * t, 4));
  }
  return out;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
