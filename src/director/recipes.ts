import { propertyKey } from "../lens/properties.js";
import type { CompReading, Keyframe, LayerEvent, MotionScore, Movement, Vec } from "../lens/types.js";
import { EASE_PRESETS, easeSegment, type EasePreset } from "./ease.js";
import {
  checkOrder,
  cloneKeys,
  keyedMotions,
  motionForWindow,
  progressOf,
  round,
  straightPath,
  type KeyTrack,
  type KeyedMotion,
} from "./keys.js";

/**
 * Recipes turn a design decision into exact keyframe edits. They are pure:
 * given a reading and a score they return a plan, and nothing touches After
 * Effects until the plan is rehearsed and applied. Every edit records the full
 * key list it replaces, which is what makes a restore exact.
 */
export type RecipeStep =
  | { recipe: "re-ease"; preset: EasePreset; movements: string[] }
  | { recipe: "stagger"; interval: number; events: string[] }
  | { recipe: "retime"; factor: number | Record<string, number>; events: string[] }
  | { recipe: "follow-through"; overshoot: number; movements: string[] }
  | { recipe: "soften-overshoot"; factor: number; movements: string[] };

export type RecipeId = RecipeStep["recipe"];

export interface PropertyEdit {
  layerId: number;
  layerName: string;
  path: string[];
  property: string;
  propertyName: string;
  spatial: boolean;
  dimensions: number;
  before: Keyframe[];
  after: Keyframe[];
}

export interface EditPlan {
  label: string;
  steps: RecipeStep[];
  /** What the plan does, in a designer's words, one line per step. */
  summary: string[];
  edits: PropertyEdit[];
  /** Targets a step could not change, and why. Never silently dropped. */
  skipped: { step: RecipeId; target: string; reason: string }[];
}

type Tracks = Map<string, KeyTrack & { original: Keyframe[] }>;

const trackId = (layerId: number, property: string) => `${layerId}|${property}`;

export function planVariant(reading: CompReading, score: MotionScore, label: string, steps: RecipeStep[]): EditPlan {
  const tracks: Tracks = new Map();
  for (const layer of reading.layers) {
    for (const track of layer.properties) {
      if (track.keys.length < 2) continue;
      tracks.set(trackId(layer.id, propertyKey(track)), {
        layer: { id: layer.id, name: layer.name, inPoint: layer.inPoint, outPoint: layer.outPoint },
        track: { path: track.path, name: track.name, spatial: track.spatial, dimensions: track.dimensions },
        keys: cloneKeys(track.keys),
        original: cloneKeys(track.keys),
      });
    }
  }

  const movementsById = new Map(score.movements.map((m) => [m.id, m]));
  const eventsById = new Map(score.events.map((e) => [e.id, e]));
  const summary: string[] = [];
  const skipped: EditPlan["skipped"] = [];

  // Targets are resolved to keyed motions once, against the original keys.
  // Recipes never add or remove motions, so these indices stay valid while
  // steps change key times and values.
  const resolveMovement = (id: string, step: RecipeId): { entry: KeyTrack; motion: KeyedMotion } | null => {
    const m = movementsById.get(id);
    if (!m) {
      skipped.push({ step, target: id, reason: "no such movement in the current score" });
      return null;
    }
    const entry = tracks.get(trackId(m.layerId, m.property));
    if (!entry) {
      skipped.push({ step, target: movementLabel(m), reason: m.expressionDriven ? "driven by an expression, not keyframes" : "has no keyframes to change" });
      return null;
    }
    const motion = motionForWindow(entry.original ?? entry.keys, m.startTime, m.endTime);
    if (!motion) {
      skipped.push({ step, target: movementLabel(m), reason: "its keyframes could not be matched to the measured motion" });
      return null;
    }
    return { entry, motion };
  };

  for (const step of inCanonicalOrder(steps)) {
    switch (step.recipe) {
      case "re-ease": {
        let changed = 0;
        for (const id of step.movements) {
          const target = resolveMovement(id, step.recipe);
          if (target && reEase(target.entry, target.motion, step.preset)) changed++;
        }
        if (changed) summary.push(`Re-eased ${plural(changed, "movement")} with ${step.preset.replace(/-/g, " ")}.`);
        break;
      }
      case "stagger": {
        const events = step.events.map((id) => eventsById.get(id)).filter((e): e is LayerEvent => Boolean(e));
        let changed = 0;
        events.forEach((event, i) => {
          if (i === 0) return;
          const reason = shiftEvent(tracks, event, i * step.interval, score);
          if (reason) skipped.push({ step: step.recipe, target: event.layerName, reason });
          else changed++;
        });
        if (changed) summary.push(`Staggered ${plural(events.length, "element")} ${Math.round(step.interval * 1000)} ms apart, in the order ${events.map((e) => e.layerName).join(" → ")}.`);
        break;
      }
      case "retime": {
        let changed = 0;
        for (const id of step.events) {
          const event = eventsById.get(id);
          if (!event) continue;
          const factor = typeof step.factor === "number" ? step.factor : step.factor[id] ?? 1;
          if (Math.abs(factor - 1) < 1e-3) continue;
          const reason = scaleEvent(tracks, event, factor, score);
          if (reason) skipped.push({ step: step.recipe, target: event.layerName, reason });
          else changed++;
        }
        if (changed) summary.push(`Retimed ${plural(changed, "element")}${typeof step.factor === "number" ? ` to ${Math.round(step.factor * 100)}% of their length` : " so the most important moves take longest"}.`);
        break;
      }
      case "follow-through": {
        let changed = 0;
        // Adding a key shifts the indices of every later key in the same
        // property, so work from the end of each property backwards.
        const targets = step.movements
          .map((id) => ({ id, target: resolveMovement(id, step.recipe) }))
          .filter((t): t is { id: string; target: { entry: KeyTrack; motion: KeyedMotion } } => t.target !== null)
          .sort((a, b) => b.target.motion.first - a.target.motion.first);
        for (const { id, target } of targets) {
          const reason = addFollowThrough(target.entry, target.motion, step.overshoot);
          if (reason) skipped.push({ step: step.recipe, target: id, reason });
          else changed++;
        }
        if (changed) summary.push(`Added a ${Math.round(step.overshoot * 100)}% follow-through to ${plural(changed, "movement")}.`);
        break;
      }
      case "soften-overshoot": {
        let changed = 0;
        for (const id of step.movements) {
          const target = resolveMovement(id, step.recipe);
          if (!target) continue;
          const reason = softenOvershoot(target.entry, target.motion, step.factor);
          if (reason) skipped.push({ step: step.recipe, target: id, reason });
          else changed++;
        }
        if (changed) summary.push(`Softened the overshoot of ${plural(changed, "movement")} to ${Math.round(step.factor * 100)}%.`);
        break;
      }
    }
  }

  const edits: PropertyEdit[] = [];
  for (const entry of tracks.values()) {
    if (JSON.stringify(entry.keys) === JSON.stringify(entry.original)) continue;
    edits.push({
      layerId: entry.layer.id,
      layerName: entry.layer.name,
      path: entry.track.path,
      property: entry.track.path.join("/"),
      propertyName: entry.track.name,
      spatial: entry.track.spatial,
      dimensions: entry.track.dimensions,
      before: entry.original,
      after: entry.keys,
    });
  }
  return { label, steps, summary, edits, skipped };
}

function movementLabel(m: Movement): string {
  return `${m.layerName} › ${m.propertyName}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function reEase(entry: KeyTrack, motion: KeyedMotion, preset: EasePreset): boolean {
  const keys = entry.keys;
  const first = keys[motion.first] as Keyframe;
  const last = keys[motion.last] as Keyframe;
  const curve = EASE_PRESETS[preset];
  const hold = first.outInterpolation === "hold";
  if (hold) return false;
  const interpolation = preset === "linear" ? "linear" : "bezier";

  // The first segment's start and the last segment's arrival carry the ease;
  // keys in between (an overshoot, a bounce) keep theirs.
  const second = keys[motion.first + 1] as Keyframe;
  const beforeLast = keys[motion.last - 1] as Keyframe;
  const start = easeSegment(first, motion.last - motion.first === 1 ? last : second, entry.track, curve);
  const end = easeSegment(motion.last - motion.first === 1 ? first : beforeLast, last, entry.track, curve);
  first.outEase = start.out;
  first.outInterpolation = interpolation;
  first.temporalAutoBezier = false;
  first.temporalContinuous = false;
  last.inEase = end.in;
  last.inInterpolation = interpolation;
  last.temporalAutoBezier = false;
  last.temporalContinuous = false;
  return true;
}

/** Key ranges of every keyed motion inside an event's window, grouped by property. */
function eventRanges(tracks: Tracks, event: LayerEvent, score: MotionScore): { entry: KeyTrack; motion: KeyedMotion }[] {
  const out: { entry: KeyTrack; motion: KeyedMotion }[] = [];
  const movementIds = new Set(event.movementIds);
  for (const m of score.movements) {
    if (!movementIds.has(m.id)) continue;
    const entry = tracks.get(trackId(m.layerId, m.property)) as (KeyTrack & { original: Keyframe[] }) | undefined;
    if (!entry) continue;
    const motion = motionForWindow(entry.original, m.startTime, m.endTime);
    if (motion && !out.some((o) => o.entry === entry && o.motion.first === motion.first)) out.push({ entry, motion });
  }
  return out;
}

function shiftEvent(tracks: Tracks, event: LayerEvent, offset: number, score: MotionScore): string | null {
  const ranges = eventRanges(tracks, event, score);
  if (ranges.length === 0) return "its motion is not keyframed";
  const staged = ranges.map(({ entry, motion }) => {
    const keys = cloneKeys(entry.keys);
    for (let i = motion.first; i <= motion.last; i++) (keys[i] as Keyframe).time = round((keys[i] as Keyframe).time + offset);
    return { entry, keys };
  });
  for (const { entry, keys } of staged) {
    const problem = checkOrder(keys);
    if (problem) return `moving it later would collide with its next animation (${problem})`;
    const lastTime = Math.max(...keys.map((k) => k.time));
    if (lastTime > entry.layer.outPoint) return "moving it later would push it past the end of the layer";
  }
  for (const { entry, keys } of staged) entry.keys = keys;
  return null;
}

function scaleEvent(tracks: Tracks, event: LayerEvent, factor: number, score: MotionScore): string | null {
  if (!(factor > 0)) return "a duration factor must be positive";
  const ranges = eventRanges(tracks, event, score);
  if (ranges.length === 0) return "its motion is not keyframed";
  const origin = Math.min(...ranges.map(({ entry, motion }) => (entry.keys[motion.first] as Keyframe).time));
  const staged = ranges.map(({ entry, motion }) => {
    const keys = cloneKeys(entry.keys);
    for (let i = motion.first; i <= motion.last; i++) {
      const key = keys[i] as Keyframe;
      key.time = round(origin + (key.time - origin) * factor);
      // Speeds are units per second: stretching time slows them by the same factor,
      // which keeps the shape of every ease intact.
      if (i > motion.first) key.inEase = key.inEase.map((e) => ({ ...e, speed: round(e.speed / factor) }));
      if (i < motion.last) key.outEase = key.outEase.map((e) => ({ ...e, speed: round(e.speed / factor) }));
    }
    return { entry, keys };
  });
  for (const { entry, keys } of staged) {
    const problem = checkOrder(keys);
    if (problem) return `stretching it would collide with its next animation (${problem})`;
    if (Math.max(...keys.map((k) => k.time)) > entry.layer.outPoint) return "stretching it would run past the end of the layer";
  }
  for (const { entry, keys } of staged) entry.keys = keys;
  return null;
}

function addFollowThrough(entry: KeyTrack, motion: KeyedMotion, overshoot: number): string | null {
  if (motion.last - motion.first !== 1) return "it already has keys between start and end";
  const keys = entry.keys;
  const a = keys[motion.first] as Keyframe;
  const b = keys[motion.last] as Keyframe;
  if (a.outInterpolation === "hold") return "it is a hold (a cut), not a movement";
  if (entry.track.spatial && !straightPath(a, b)) return "it follows a curved motion path; adding a key would reshape the path";

  const peakTime = round(a.time + 0.72 * (b.time - a.time));
  const peakValue: Vec = b.value.map((v, i) => round(v + overshoot * (v - (a.value[i] ?? v))));
  const peak: Keyframe = {
    time: peakTime,
    value: peakValue,
    inInterpolation: "bezier",
    outInterpolation: "bezier",
    inEase: [],
    outEase: [],
    temporalContinuous: false,
    temporalAutoBezier: false,
    ...(entry.track.spatial
      ? {
          inTangent: peakValue.map(() => 0),
          outTangent: peakValue.map(() => 0),
          spatialContinuous: false,
          spatialAutoBezier: false,
          roving: false,
        }
      : {}),
  };
  const toPeak = easeSegment(a, peak, entry.track, EASE_PRESETS["ease-out"]);
  const settle = easeSegment(peak, b, entry.track, EASE_PRESETS["ease-in-out"]);
  a.outEase = toPeak.out;
  a.outInterpolation = "bezier";
  peak.inEase = toPeak.in;
  peak.outEase = settle.out;
  b.inEase = settle.in;
  b.inInterpolation = "bezier";
  keys.splice(motion.last, 0, peak);
  return null;
}

/**
 * Targets are resolved to key indices once, against the original keys. Every
 * recipe except follow-through keeps the number of keys, so running
 * follow-through last keeps every resolved index valid.
 */
const STEP_ORDER: RecipeId[] = ["stagger", "retime", "re-ease", "soften-overshoot", "follow-through"];

function inCanonicalOrder(steps: RecipeStep[]): RecipeStep[] {
  return [...steps].sort((a, b) => STEP_ORDER.indexOf(a.recipe) - STEP_ORDER.indexOf(b.recipe));
}

function softenOvershoot(entry: KeyTrack, motion: KeyedMotion, factor: number): string | null {
  const keys = entry.keys;
  if (motion.last - motion.first < 2) return "its overshoot comes from the ease or an expression, not from keys that can be pulled in";
  const from = (keys[motion.first] as Keyframe).value;
  const target = (keys[motion.last] as Keyframe).value;
  let swing = 0;
  for (let i = motion.first + 1; i < motion.last; i++) {
    const key = keys[i] as Keyframe;
    if (progressOf(key.value, from, target) < 0.9) continue;
    swing++;
    const scale = factor ** swing;
    key.value = key.value.map((v, d) => round((target[d] ?? v) + (v - (target[d] ?? v)) * scale));
  }
  return swing > 0 ? null : "no keys past the target to pull in";
}

/** Exposed for tests: the keyed motions of a track. */
export { keyedMotions };
