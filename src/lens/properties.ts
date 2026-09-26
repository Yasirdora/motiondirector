import type { PropertyKind, PropertyTrack, Vec } from "./types.js";

/**
 * Property kinds are recognised by matchName, never by display name: display
 * names are translated, so "Position" is "Posición" in a Spanish After Effects.
 */
const KIND_BY_MATCH_NAME: Record<string, PropertyKind> = {
  "ADBE Position": "position",
  "ADBE Position_0": "position",
  "ADBE Position_1": "position",
  "ADBE Position_2": "position",
  "ADBE Scale": "scale",
  "ADBE Rotate Z": "rotation",
  "ADBE Rotate X": "rotation",
  "ADBE Rotate Y": "rotation",
  "ADBE Orientation": "rotation",
  "ADBE Opacity": "opacity",
  "ADBE Anchor Point": "anchor",
};

export function propertyKind(path: readonly string[]): PropertyKind {
  const leaf = path[path.length - 1];
  return (leaf !== undefined && KIND_BY_MATCH_NAME[leaf]) || "other";
}

export function propertyKey(track: Pick<PropertyTrack, "path">): string {
  return track.path.join("/");
}

/**
 * The smallest per-frame change that counts as motion, in the property's own
 * units. Anything below is sampling noise or sub-pixel drift nobody can see.
 */
export function noiseFloor(kind: PropertyKind): number {
  switch (kind) {
    case "position":
    case "anchor":
      return 0.05; // px per frame
    case "scale":
      return 0.02; // % per frame
    case "rotation":
      return 0.02; // degrees per frame
    case "opacity":
      return 0.05; // opacity points per frame
    case "other":
      return 1e-4;
  }
}

/** Movements smaller than this are not worth reporting (px, %, degrees, opacity points). */
export function minimumAmplitude(kind: PropertyKind): number {
  switch (kind) {
    case "position":
    case "anchor":
      return 0.5;
    case "scale":
      return 0.5;
    case "rotation":
      return 0.5;
    case "opacity":
      return 1;
    case "other":
      return 0;
  }
}

/**
 * Normalise an amplitude to 0–1 so a 300 px slide and a 40° turn can be
 * compared. The references are what a viewer reads as a "full" move of that
 * kind in this comp.
 */
export function significance(
  kind: PropertyKind,
  amplitude: number,
  comp: { width: number; height: number },
  trackRange: number,
): number {
  const diagonal = Math.hypot(comp.width, comp.height) || 1;
  let reference: number;
  switch (kind) {
    case "position":
    case "anchor":
      reference = diagonal;
      break;
    case "scale":
      reference = 100;
      break;
    case "rotation":
      reference = 90;
      break;
    case "opacity":
      reference = 100;
      break;
    case "other":
      reference = trackRange > 0 ? trackRange : 1;
      break;
  }
  return Math.min(1, Math.abs(amplitude) / reference);
}

export function subtract(a: Vec, b: Vec): Vec {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) - (b[i] ?? 0);
  return out;
}

export function dot(a: Vec, b: Vec): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function magnitude(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: Vec, b: Vec): number {
  return magnitude(subtract(a, b));
}

/** Largest distance between any sample and the first one; the size of a track's motion. */
export function trackRange(samples: readonly Vec[]): number {
  const first = samples[0];
  if (!first) return 0;
  let max = 0;
  for (const s of samples) max = Math.max(max, distance(s, first));
  return max;
}
