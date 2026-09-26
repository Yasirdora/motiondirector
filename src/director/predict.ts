import { buildScore } from "../lens/score.js";
import { resampleReading } from "../lens/evaluate.js";
import { propertyKey } from "../lens/properties.js";
import type { CompReading, MotionScore } from "../lens/types.js";
import type { EditPlan } from "./recipes.js";

/** The reading a plan would produce: its keys applied and every edited property re-evaluated. */
export function applyPlanToReading(reading: CompReading, plan: EditPlan): CompReading {
  const edits = new Map(plan.edits.map((e) => [`${e.layerId}|${e.property}`, e]));
  const edited: CompReading = {
    ...reading,
    layers: reading.layers.map((layer) => ({
      ...layer,
      properties: layer.properties.map((track) => {
        const edit = edits.get(`${layer.id}|${propertyKey(track)}`);
        return edit ? { ...track, keys: edit.after } : track;
      }),
    })),
  };
  return resampleReading(edited);
}

/**
 * Predict the score of a plan without After Effects. Labelled a prediction:
 * it is how the keys should play, not a measurement of how they do.
 */
export function predictScore(reading: CompReading, plan: EditPlan): { reading: CompReading; score: MotionScore; predicted: true } {
  const next = applyPlanToReading(reading, plan);
  return { reading: next, score: buildScore(next), predicted: true };
}
