import { describe, expect, it } from "vitest";
import { critique } from "../src/critic/critic.js";
import { predictScore } from "../src/director/predict.js";
import { planVariant } from "../src/director/recipes.js";
import { suggestVariants } from "../src/director/variants.js";
import { buildScore } from "../src/lens/score.js";
import { keyedCarelessTitleCard } from "./helpers/scenes.js";

function analyse() {
  const reading = keyedCarelessTitleCard();
  const score = buildScore(reading);
  return { reading, score, result: critique(score, reading) };
}

describe("suggestVariants", () => {
  it("separates choreography and feel when both are at fault", () => {
    const { score, result } = analyse();
    const { variants } = suggestVariants(result, score);
    expect(variants.map((v) => v.label)).toEqual(["Choreography", "Feel", "Both"]);
    const recipes = (i: number) => variants[i]!.steps.map((s) => s.recipe).sort();
    expect(recipes(0)).toEqual(["retime", "stagger"]);
    expect(recipes(1)).toEqual(["re-ease"]);
    expect(recipes(2)).toEqual(["re-ease", "retime", "stagger"]);
  });

  it("varies intensity when only one aspect is chosen", () => {
    const { score, result } = analyse();
    const { variants } = suggestVariants(result, score, { axes: ["choreography"] });
    expect(variants.map((v) => v.label)).toEqual(["Subtle", "Medium", "Bold"]);
    const interval = (i: number) => {
      const step = variants[i]!.steps.find((s) => s.recipe === "stagger");
      return step && step.recipe === "stagger" ? step.interval : 0;
    };
    expect(interval(0)).toBeLessThan(interval(1));
    expect(interval(1)).toBeLessThan(interval(2));
  });

  it("hands staging problems back to the designer instead of guessing", () => {
    const { score, result } = analyse();
    const { needsDesigner } = suggestVariants(result, score);
    expect(needsDesigner.map((f) => f.detector)).toContain("fade-only-entrance");
  });

  it("returns no variants when nothing fixable was found", () => {
    const { score, result } = analyse();
    const { variants } = suggestVariants({ ...result, findings: [] }, score);
    expect(variants).toEqual([]);
  });
});

describe("variants fix what they claim to (predicted)", () => {
  it("the 'Both' variant removes the tells it targets", () => {
    const { reading, score, result } = analyse();
    const both = suggestVariants(result, score).variants.find((v) => v.label === "Both")!;
    const plan = planVariant(reading, score, both.label, both.steps);
    expect(plan.skipped).toEqual([]);

    const predicted = predictScore(reading, plan);
    const after = critique(predicted.score, predicted.reading).findings.map((f) => f.detector);
    expect(after).not.toContain("linear-easing");
    expect(after).not.toContain("simultaneous-start");
    expect(after).not.toContain("uniform-duration");
    // Fade-only entrances need a creative decision, so they remain.
    expect(after).toContain("fade-only-entrance");
  });

  it("the 'Choreography' variant leaves the easing alone", () => {
    const { reading, score, result } = analyse();
    const choreography = suggestVariants(result, score).variants[0]!;
    const predicted = predictScore(reading, planVariant(reading, score, choreography.label, choreography.steps));
    const after = critique(predicted.score, predicted.reading).findings.map((f) => f.detector);
    expect(after).toContain("linear-easing");
    expect(after).not.toContain("simultaneous-start");
  });
});
