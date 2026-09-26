import type { Choreography, LayerEvent, LayerTrack, Movement, PropertyKind } from "./types.js";

/** Movements of one layer this close together (frames) belong to the same event. */
const EVENT_GAP_FRAMES = 2;
/**
 * Events starting or ending within one frame of each other count as
 * simultaneous. One frame only absorbs rounding to the frame grid: a
 * two-frame offset (67 ms at 30 fps) is already a visible stagger.
 */
const CLUSTER_FRAMES = 1;
/** Opacity at or below this (percent) counts as invisible. */
const INVISIBLE = 5;

/**
 * Group a layer's movements into events: a slide and a fade that play
 * together are one entrance, not two unrelated things.
 */
export function groupEvents(layer: LayerTrack, movements: Movement[], frameRate: number): LayerEvent[] {
  const sorted = [...movements].sort((a, b) => a.startTime - b.startTime);
  const gap = EVENT_GAP_FRAMES / frameRate + 1e-9;
  const groups: Movement[][] = [];
  let current: Movement[] = [];
  let currentEnd = -Infinity;
  for (const m of sorted) {
    if (current.length > 0 && m.startTime > currentEnd + gap) {
      groups.push(current);
      current = [];
      currentEnd = -Infinity;
    }
    current.push(m);
    currentEnd = Math.max(currentEnd, m.endTime);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const primary = group.reduce((best, m) => (m.significance > best.significance ? m : best));
    const startTime = Math.min(...group.map((m) => m.startTime));
    const endTime = Math.max(...group.map((m) => m.endTime));
    const kinds = [...new Set(group.map((m) => m.kind))] as PropertyKind[];
    return {
      id: `${layer.id}@${startTime.toFixed(3)}`,
      layerId: layer.id,
      layerName: layer.name,
      startTime,
      endTime,
      duration: round(endTime - startTime),
      movementIds: group.map((m) => m.id),
      kinds,
      primaryMovementId: primary.id,
      significance: primary.significance,
      role: roleOf(layer, group, startTime, endTime, frameRate),
    };
  });
}

function roleOf(
  layer: LayerTrack,
  group: Movement[],
  start: number,
  end: number,
  frameRate: number,
): LayerEvent["role"] {
  const tolerance = CLUSTER_FRAMES / frameRate + 1e-9;
  const appears = group.some(
    (m) =>
      (m.kind === "opacity" && (m.from[0] ?? 100) <= INVISIBLE && (m.to[0] ?? 0) > (m.from[0] ?? 0)) ||
      (m.kind === "scale" && Math.max(...m.from.map(Math.abs)) <= 1 && Math.max(...m.to.map(Math.abs)) > 1),
  );
  const disappears = group.some(
    (m) =>
      (m.kind === "opacity" && (m.to[0] ?? 100) <= INVISIBLE && (m.from[0] ?? 0) > (m.to[0] ?? 0)) ||
      (m.kind === "scale" && Math.max(...m.to.map(Math.abs)) <= 1 && Math.max(...m.from.map(Math.abs)) > 1),
  );
  if (appears || Math.abs(start - layer.inPoint) <= tolerance) return "entrance";
  if (disappears || Math.abs(end - layer.outPoint) <= tolerance) return "exit";
  return "action";
}

/** How the events of a comp relate to each other in time. */
export function measureChoreography(events: LayerEvent[], frameRate: number): Choreography {
  const byStart = [...events].sort((a, b) => a.startTime - b.startTime || a.layerId - b.layerId);
  const tolerance = CLUSTER_FRAMES / frameRate + 1e-9;
  const startClusters = cluster(byStart, (e) => e.startTime, tolerance);
  const endClusters = cluster(
    [...events].sort((a, b) => a.endTime - b.endTime),
    (e) => e.endTime,
    tolerance,
  );
  const total = events.length;
  const largest = (clusters: { eventIds: string[] }[]) => clusters[0]?.eventIds.length ?? 0;

  const distinctStarts = [...startClusters].map((c) => c.time).sort((a, b) => a - b);
  const staggerIntervals: number[] = [];
  for (let i = 1; i < distinctStarts.length; i++) {
    staggerIntervals.push(round((distinctStarts[i] as number) - (distinctStarts[i - 1] as number)));
  }

  return {
    startClusters,
    endClusters,
    simultaneousStartRatio: total >= 2 ? round(largest(startClusters) / total, 4) : 0,
    simultaneousEndRatio: total >= 2 ? round(largest(endClusters) / total, 4) : 0,
    staggerIntervals,
    durationVariation: round(coefficientOfVariation(events.map((e) => e.duration)), 4),
    peakConcurrency: peakConcurrency(events),
    order: byStart.map((e) => e.id),
  };
}

function cluster(
  sorted: LayerEvent[],
  timeOf: (e: LayerEvent) => number,
  tolerance: number,
): { time: number; eventIds: string[] }[] {
  const clusters: { time: number; eventIds: string[] }[] = [];
  for (const event of sorted) {
    const time = timeOf(event);
    const last = clusters[clusters.length - 1];
    if (last && time - last.time <= tolerance) last.eventIds.push(event.id);
    else clusters.push({ time, eventIds: [event.id] });
  }
  return clusters.sort((a, b) => b.eventIds.length - a.eventIds.length || a.time - b.time);
}

function peakConcurrency(events: LayerEvent[]): number {
  const edges: [number, number][] = [];
  for (const e of events) {
    edges.push([e.startTime, 1]);
    edges.push([e.endTime, -1]);
  }
  // Ends before starts at the same instant: back-to-back is not overlap.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    active += delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!(mean > 0)) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
