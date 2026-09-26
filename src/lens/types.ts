/**
 * The data model shared by every part of Motion Director.
 *
 * A `CompReading` is what the After Effects side reports: the exact keyframe
 * data of every animated property plus its value sampled once per frame. It is
 * plain data, so everything built on top of it — the Motion Score, the Critic,
 * the recipes — runs and is tested without After Effects.
 */

/** Every property value is carried as an array, so scalars are `[v]`. */
export type Vec = number[];

export type Interpolation = "linear" | "bezier" | "hold";

/** After Effects' `KeyframeEase`: speed in property units per second, influence in percent. */
export interface TemporalEase {
  speed: number;
  influence: number;
}

/**
 * One keyframe, with everything needed to put it back exactly as it was.
 * Restoring a change rewrites keys from this record, so nothing here is optional
 * that After Effects would otherwise invent a default for.
 */
export interface Keyframe {
  time: number;
  value: Vec;
  inInterpolation: Interpolation;
  outInterpolation: Interpolation;
  /** One entry per dimension, or exactly one for spatial properties (After Effects' own rule). */
  inEase: TemporalEase[];
  outEase: TemporalEase[];
  temporalContinuous: boolean;
  temporalAutoBezier: boolean;
  /** Spatial properties only. */
  inTangent?: Vec;
  outTangent?: Vec;
  spatialContinuous?: boolean;
  spatialAutoBezier?: boolean;
  roving?: boolean;
}

export type PropertyKind =
  | "position"
  | "scale"
  | "rotation"
  | "opacity"
  | "anchor"
  | "other";

export interface Expression {
  text: string;
  enabled: boolean;
  /** After Effects' `expressionError`: assignment "succeeds" even when this is set. */
  error: string | null;
}

export interface PropertyTrack {
  /** Locale-independent matchName path from the layer, e.g. `["ADBE Transform Group", "ADBE Position"]`. */
  path: string[];
  /** Display name in the user's language, for messages only. */
  name: string;
  dimensions: number;
  spatial: boolean;
  keys: Keyframe[];
  expression?: Expression;
  /** Value at every frame from `CompReading.sampleStart`, one entry per frame. */
  samples: Vec[];
}

export interface LayerTrack {
  /** After Effects' stable layer id. Never the index, which shifts when layers move. */
  id: number;
  index: number;
  name: string;
  type: string;
  inPoint: number;
  outPoint: number;
  parentId: number | null;
  enabled: boolean;
  properties: PropertyTrack[];
}

export interface CompReading {
  compId: number;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  /** Time of `samples[0]` in every track. */
  sampleStart: number;
  sampleCount: number;
  layers: LayerTrack[];
  /** Set when sampling was capped, so no one mistakes a partial reading for a whole one. */
  truncated?: { reason: string; sampledUntil: number };
}

/** How a movement accelerates on its way to the target. */
export type EaseShape =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "jump"
  | "excursion"
  | "irregular";

/** One continuous change of one property. */
export interface Movement {
  id: string;
  layerId: number;
  layerName: string;
  property: string;
  propertyName: string;
  kind: PropertyKind;
  startTime: number;
  endTime: number;
  duration: number;
  from: Vec;
  to: Vec;
  /** Distance travelled toward the target, in the property's own units (px, %, degrees, opacity points). */
  amplitude: number;
  /** Amplitude normalised to the comp (0–1), comparable across property kinds. */
  significance: number;
  peakSpeed: number;
  /** Where in the movement the peak speed falls, 0 = start, 1 = end. */
  peakAt: number;
  /** Speed at the first and last frame of travel, as a fraction of peak speed. */
  startSpeedRatio: number;
  endSpeedRatio: number;
  shape: EaseShape;
  /** How far past the target it travels, as a fraction of amplitude. */
  overshoot: number;
  /** Number of times it crosses the target after first reaching it. */
  oscillations: number;
  /** Mean ratio between successive oscillation peaks, `null` when there are fewer than two. */
  decay: number | null;
  /** How far it first moves backwards, as a fraction of amplitude. */
  anticipation: number;
  /** Seconds from first arriving near the target until it stays there. */
  settleTime: number;
  /** Fraction of the duration spent creeping over the last 5% of the distance. */
  tailFraction: number;
  /** Speed over the movement, normalised to peak = 1, resampled to 24 points. */
  speedProfile: number[];
  /** The movement is driven (at least partly) by an expression. */
  expressionDriven: boolean;
}

/** Movements of one layer that happen together, e.g. a slide and fade entrance. */
export interface LayerEvent {
  id: string;
  layerId: number;
  layerName: string;
  startTime: number;
  endTime: number;
  duration: number;
  movementIds: string[];
  kinds: PropertyKind[];
  /** The most significant movement in the event. */
  primaryMovementId: string;
  significance: number;
  role: "entrance" | "exit" | "action";
}

export interface Choreography {
  /** Events grouped by near-identical start time, largest first. */
  startClusters: { time: number; eventIds: string[] }[];
  endClusters: { time: number; eventIds: string[] }[];
  /** Fraction of events that start together with the largest start cluster. */
  simultaneousStartRatio: number;
  simultaneousEndRatio: number;
  /** Gaps between successive distinct start times, in seconds. */
  staggerIntervals: number[];
  /** Coefficient of variation of event durations (0 = all identical). */
  durationVariation: number;
  /** The largest number of events in motion at the same moment. */
  peakConcurrency: number;
  /** Event ids in order of their start. */
  order: string[];
}

export interface MotionScore {
  compId: number;
  compName: string;
  frameRate: number;
  width: number;
  height: number;
  range: { start: number; end: number };
  /** Hash of the keyframes and expressions this score was measured from. */
  fingerprint: string;
  movements: Movement[];
  events: LayerEvent[];
  choreography: Choreography;
  /** Properties whose motion was measured but that the Lens could not fully interpret. */
  notes: string[];
  truncated?: { reason: string; sampledUntil: number };
}
