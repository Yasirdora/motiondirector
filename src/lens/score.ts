import { createHash } from "node:crypto";
import { groupEvents, measureChoreography } from "./choreography.js";
import { findMovements } from "./movements.js";
import { propertyKey } from "./properties.js";
import type { CompReading, LayerEvent, MotionScore, Movement } from "./types.js";

/**
 * Build the Motion Score for a comp: every movement, grouped into layer
 * events, and how those events are choreographed.
 */
export function buildScore(reading: CompReading): MotionScore {
  const geometry = {
    width: reading.width,
    height: reading.height,
    frameRate: reading.frameRate,
    sampleStart: reading.sampleStart,
  };
  const movements: Movement[] = [];
  const events: LayerEvent[] = [];
  const notes: string[] = [];

  for (const layer of reading.layers) {
    if (!layer.enabled) continue;
    const layerMovements: Movement[] = [];
    for (const track of layer.properties) {
      if (track.expression?.enabled && track.expression.error) {
        notes.push(
          `"${layer.name}" › ${track.name}: the expression has an error (${track.expression.error}), so its motion was measured as After Effects falls back to it.`,
        );
      }
      if (track.samples.length !== reading.sampleCount) {
        notes.push(
          `"${layer.name}" › ${track.name}: ${track.samples.length} samples instead of ${reading.sampleCount}; measured what was there.`,
        );
      }
      layerMovements.push(...findMovements(track, layer, geometry));
    }
    movements.push(...layerMovements);
    events.push(...groupEvents(layer, layerMovements, reading.frameRate));
  }

  const frameDuration = 1 / reading.frameRate;
  return {
    compId: reading.compId,
    compName: reading.name,
    frameRate: reading.frameRate,
    width: reading.width,
    height: reading.height,
    range: {
      start: reading.sampleStart,
      end: reading.sampleStart + Math.max(0, reading.sampleCount - 1) * frameDuration,
    },
    fingerprint: fingerprint(reading),
    movements: movements.sort((a, b) => a.startTime - b.startTime),
    events: events.sort((a, b) => a.startTime - b.startTime),
    choreography: measureChoreography(events, reading.frameRate),
    notes,
    ...(reading.truncated ? { truncated: reading.truncated } : {}),
  };
}

/**
 * A hash of what defines the motion: keyframes, expressions, layer timing.
 * Two readings with the same fingerprint describe the same animation, which is
 * how a change is verified and how evidence knows it has gone stale.
 */
export function fingerprint(reading: CompReading): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([reading.compId, reading.frameRate, reading.width, reading.height]));
  const layers = [...reading.layers].sort((a, b) => a.id - b.id);
  for (const layer of layers) {
    hash.update(JSON.stringify([layer.id, layer.inPoint, layer.outPoint, layer.parentId, layer.enabled]));
    const tracks = [...layer.properties].sort((a, b) => propertyKey(a).localeCompare(propertyKey(b)));
    for (const track of tracks) {
      hash.update(propertyKey(track));
      hash.update(JSON.stringify(track.keys));
      hash.update(JSON.stringify(track.expression ?? null));
    }
  }
  return hash.digest("hex").slice(0, 16);
}
