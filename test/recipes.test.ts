import { describe, expect, it } from "vitest";
import { EASE_PRESETS, easeSegment } from "../src/director/ease.js";
import { keyedMotions, motionForWindow } from "../src/director/keys.js";
import { planVariant } from "../src/director/recipes.js";
import { buildScore } from "../src/lens/score.js";
import type { CompReading, Keyframe } from "../src/lens/types.js";
import { key, keyedTrack, spatialKey } from "./helpers/keyed.js";
import { ease, layer, reading, samplesFor, track } from "./helpers/synth.js";

function titleCard(): CompReading {
  const names = ["Logo", "Title", "Subtitle", "Rule"];
  return reading(
    names.map((name, i) =>
      layer(name, [
        keyedTrack("opacity", [{ from: [0], to: [100], start: 0, duration: 0.5 }]),
        keyedTrack("position", [{ from: [960, 640 + i * 40], to: [960, 540 + i * 40], start: 0, duration: 0.5 }]),
      ], { id: i + 1 }),
    ),
  );
}

function setup(r: CompReading) {
  return { r, score: buildScore(r) };
}

describe("easeSegment", () => {
  it("converts a bezier to After Effects speed and influence", () => {
    const a = key(0, [0]);
    const b = key(0.5, [100]);
    const { out, in: arrive } = easeSegment(a, b, { spatial: false, dimensions: 1 }, EASE_PRESETS["ease-out"]);
    // Average speed 200/s; ease-out leaves at y1/x1 = 6.25 × average and arrives at rest.
    expect(out[0]).toEqual({ speed: 1250, influence: 16 });
    expect(arrive[0]).toEqual({ speed: 0, influence: 70 });
  });

  it("gives a spatial property exactly one ease, and others one per dimension", () => {
    const spatial = easeSegment(spatialKey(0, [0, 0]), spatialKey(1, [300, 400]), { spatial: true, dimensions: 2 }, EASE_PRESETS["ease-in-out"]);
    expect(spatial.out).toHaveLength(1);
    const scale = easeSegment(key(0, [100, 100]), key(1, [50, 150]), { spatial: false, dimensions: 2 }, EASE_PRESETS["ease-out"]);
    expect(scale.out).toHaveLength(2);
    // Per-dimension speeds keep their direction.
    expect(scale.out[0]!.speed).toBeLessThan(0);
    expect(scale.out[1]!.speed).toBeGreaterThan(0);
  });
});

describe("keyedMotions", () => {
  it("splits keys into motions separated by rests", () => {
    const keys = [key(0, [0]), key(1, [100]), key(2, [100]), key(3, [0])];
    expect(keyedMotions(keys)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
    ]);
  });

  it("matches a measured window to the keys it came from", () => {
    const keys = [key(0, [0]), key(1, [100]), key(2, [100]), key(3, [0])];
    expect(motionForWindow(keys, 2.03, 3)).toEqual({ first: 2, last: 3 });
    expect(motionForWindow(keys, 5, 6)).toBeNull();
  });
});

describe("planVariant", () => {
  it("re-eases linear movements and records exactly what it replaces", () => {
    const { r, score } = setup(titleCard());
    const ids = score.movements.filter((m) => m.shape === "linear").map((m) => m.id);
    const plan = planVariant(r, score, "Eased", [{ recipe: "re-ease", preset: "ease-out", movements: ids }]);
    expect(plan.edits).toHaveLength(8);
    for (const edit of plan.edits) {
      expect(edit.before[0]!.outInterpolation).toBe("linear");
      expect(edit.after[0]!.outInterpolation).toBe("bezier");
      expect(edit.after[1]!.inEase.every((e) => e.speed === 0)).toBe(true);
      expect(edit.after[0]!.outEase).toHaveLength(edit.spatial ? 1 : edit.dimensions);
    }
    expect(plan.summary[0]).toMatch(/Re-eased 8 movements with ease out/);
    expect(plan.label).toBe("Eased");
  });

  it("staggers elements in the given order without touching the first", () => {
    const { r, score } = setup(titleCard());
    const order = score.events.map((e) => e.id);
    const plan = planVariant(r, score, "Staggered", [{ recipe: "stagger", interval: 0.06, events: order }]);
    const startOf = (layerId: number) => plan.edits.filter((e) => e.layerId === layerId).map((e) => e.after[0]!.time);
    expect(startOf(1)).toEqual([]); // untouched, so no edit at all
    expect(startOf(2)).toEqual([0.06, 0.06]);
    expect(startOf(4)).toEqual([0.18, 0.18]);
    expect(plan.summary[0]).toMatch(/60 ms apart/);
  });

  it("refuses to stagger an element into its own next animation", () => {
    const busy = keyedTrack("opacity", [
      { from: [0], to: [100], start: 0, duration: 0.5 },
      { from: [100], to: [0], start: 0.55, duration: 0.5 },
    ]);
    const r = reading([
      layer("A", [keyedTrack("opacity", [{ from: [0], to: [100], start: 0, duration: 0.5 }])], { id: 1 }),
      layer("B", [busy], { id: 2 }),
    ]);
    const score = buildScore(r);
    const events = score.events.filter((e) => e.startTime < 0.1).map((e) => e.id);
    const plan = planVariant(r, score, "Staggered", [{ recipe: "stagger", interval: 0.2, events }]);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ step: "stagger", target: "B" });
    expect(plan.skipped[0]!.reason).toMatch(/collide/);
  });

  it("retimes and scales ease speeds so the curve keeps its shape", () => {
    const eased = [key(0, [0], { outInterpolation: "bezier", outEase: [{ speed: 600, influence: 30 }] }), key(0.5, [100], { inInterpolation: "bezier", inEase: [{ speed: 0, influence: 70 }] })];
    const r = reading([layer("A", [keyedTrack("opacity", [{ from: [0], to: [100], start: 0, duration: 0.5, ease: ease.outCubic }], { keys: eased })], { id: 1 })]);
    const score = buildScore(r);
    const plan = planVariant(r, score, "Slower", [{ recipe: "retime", factor: 2, events: [score.events[0]!.id] }]);
    const after = plan.edits[0]!.after;
    expect(after[1]!.time).toBe(1);
    expect(after[0]!.outEase[0]).toEqual({ speed: 300, influence: 30 });
  });

  it("adds follow-through as a key past the target on a straight path", () => {
    const r = reading([layer("A", [keyedTrack("position", [{ from: [0, 500], to: [800, 500], start: 0.2, duration: 1, ease: ease.outCubic }])], { id: 1 })]);
    const score = buildScore(r);
    const plan = planVariant(r, score, "Follow", [{ recipe: "follow-through", overshoot: 0.06, movements: [score.movements[0]!.id] }]);
    const after = plan.edits[0]!.after;
    expect(after).toHaveLength(3);
    expect(after[1]!.value[0]).toBeCloseTo(848, 3);
    expect(after[1]!.time).toBeCloseTo(0.92, 3);
    expect(after[1]!.inEase[0]!.speed).toBe(0);
    expect(after[2]!.value).toEqual([800, 500]);
  });

  it("will not add follow-through to a curved motion path", () => {
    const keys = [spatialKey(0, [0, 0], { outTangent: [200, -100] }), spatialKey(1, [800, 0], { inTangent: [-200, -100] })];
    const r = reading([layer("A", [keyedTrack("position", [{ from: [0, 0], to: [800, 0], start: 0, duration: 1 }], { keys })], { id: 1 })]);
    const score = buildScore(r);
    const plan = planVariant(r, score, "Follow", [{ recipe: "follow-through", overshoot: 0.06, movements: [score.movements[0]!.id] }]);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toMatch(/curved motion path/);
  });

  it("softens overshoot keys progressively so a bounce decays", () => {
    const keys: Keyframe[] = [key(0, [0]), key(0.4, [120]), key(0.6, [90]), key(0.8, [110]), key(1, [100])];
    const moves = [{ from: [0], to: [100], start: 0, duration: 1, ease: ease.symmetricBounce(2, 0.2) }];
    const r = reading([layer("A", [keyedTrack("scale", moves, { keys: keys.map((k) => ({ ...k })) })], { id: 1 })]);
    const score = buildScore(r);
    const plan = planVariant(r, score, "Soft", [{ recipe: "soften-overshoot", factor: 0.5, movements: [score.movements[0]!.id] }]);
    const values = plan.edits[0]!.after.map((k) => k.value[0]);
    expect(values).toEqual([0, 110, 97.5, 101.25, 100]);
  });

  it("explains why an expression-driven movement was left alone", () => {
    const r = reading([
      layer("W", [
        track("position", samplesFor([{ from: [0, 0], to: [300, 0], start: 0, duration: 1 }], { total: 3 }), {
          expression: { text: "linear(time, 0, 1, [0,0], [300,0])", enabled: true, error: null },
        }),
      ], { id: 1 }),
    ]);
    const score = buildScore(r);
    const plan = planVariant(r, score, "Eased", [{ recipe: "re-ease", preset: "ease-out", movements: [score.movements[0]!.id] }]);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toMatch(/expression/);
  });

  it("combines steps in a safe order whatever order they are given in", () => {
    const r = reading([layer("A", [keyedTrack("position", [{ from: [0, 500], to: [800, 500], start: 0.2, duration: 1 }])], { id: 1 })]);
    const score = buildScore(r);
    const id = score.movements[0]!.id;
    const plan = planVariant(r, score, "Both", [
      { recipe: "follow-through", overshoot: 0.05, movements: [id] },
      { recipe: "re-ease", preset: "ease-out", movements: [id] },
    ]);
    const after = plan.edits[0]!.after;
    expect(after).toHaveLength(3);
    // Follow-through ran last, so its own eases stand.
    expect(after[1]!.inEase[0]!.speed).toBe(0);
    expect(plan.summary).toHaveLength(2);
  });

  it("leaves unchanged properties out of the plan", () => {
    const { r, score } = setup(titleCard());
    const opacity = score.movements.filter((m) => m.kind === "opacity").map((m) => m.id);
    const plan = planVariant(r, score, "Fades", [{ recipe: "re-ease", preset: "soft-out", movements: opacity }]);
    expect(plan.edits.every((e) => e.propertyName === "Opacity")).toBe(true);
  });
});
