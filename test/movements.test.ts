import { describe, expect, it } from "vitest";
import { findMovements, resample } from "../src/lens/movements.js";
import { ease, layer, samplesFor, single, track } from "./helpers/synth.js";

function only(kind: Parameters<typeof single>[0], moves: Parameters<typeof single>[1], opts?: Parameters<typeof single>[2]) {
  const { track: t, layer: l, comp } = single(kind, moves, opts);
  return findMovements(t, l, comp);
}

describe("findMovements: ease shape", () => {
  it("recognises a linear move", () => {
    const [m] = only("position", [{ from: [0, 0], to: [600, 0], start: 0.5, duration: 1 }]);
    expect(m?.shape).toBe("linear");
    expect(m?.startTime).toBeCloseTo(0.5, 3);
    expect(m?.duration).toBeCloseTo(1, 3);
    expect(m?.amplitude).toBeCloseTo(600, 1);
    expect(m?.overshoot).toBe(0);
  });

  it("recognises ease-out (decelerating into the target)", () => {
    const [m] = only("position", [{ from: [0, 0], to: [600, 0], start: 0.5, duration: 1, ease: ease.outCubic }]);
    expect(m?.shape).toBe("ease-out");
    expect(m?.peakAt).toBeLessThan(0.2);
  });

  it("recognises ease-in (accelerating away)", () => {
    const [m] = only("position", [{ from: [0, 0], to: [600, 0], start: 0.5, duration: 1, ease: ease.inCubic }]);
    expect(m?.shape).toBe("ease-in");
    expect(m?.peakAt).toBeGreaterThan(0.8);
  });

  it("recognises ease-in-out", () => {
    const [m] = only("scale", [{ from: [100, 100], to: [150, 150], start: 0.2, duration: 1, ease: ease.inOutCubic }]);
    expect(m?.shape).toBe("ease-in-out");
    expect(m?.peakAt).toBeGreaterThan(0.35);
    expect(m?.peakAt).toBeLessThan(0.65);
  });

  it("calls a one-frame change a jump", () => {
    const samples = samplesFor([{ from: [0], to: [100], start: 1, duration: 1 / 30 }], { total: 2 });
    const t = track("opacity", samples);
    const [m] = findMovements(t, layer("Cut", [t]), { width: 1920, height: 1080, frameRate: 30, sampleStart: 0 });
    expect(m?.shape).toBe("jump");
  });
});

describe("findMovements: settling", () => {
  it("measures the overshoot of a back ease as one movement", () => {
    const moves = only("position", [{ from: [0, 0], to: [500, 0], start: 0.2, duration: 1, ease: ease.outBack() }]);
    expect(moves).toHaveLength(1);
    const [m] = moves;
    expect(m?.overshoot).toBeGreaterThan(0.08);
    expect(m?.overshoot).toBeLessThan(0.12);
    // The approach decelerates into the overshoot.
    expect(m?.shape).toBe("ease-out");
  });

  it("counts the oscillations of a damped spring and sees them decay", () => {
    const moves = only("rotation", [{ from: [0], to: [90], start: 0.2, duration: 2, ease: ease.spring() }], { total: 3 });
    expect(moves).toHaveLength(1);
    const [m] = moves;
    expect(m?.oscillations).toBeGreaterThanOrEqual(3);
    expect(m?.decay).not.toBeNull();
    expect(m?.decay as number).toBeLessThan(0.8);
    expect(m?.settleTime).toBeGreaterThan(0.3);
  });

  it("sees that a ping-pong bounce does not decay", () => {
    const moves = only("scale", [{ from: [0, 0], to: [100, 100], start: 0.1, duration: 2, ease: ease.symmetricBounce() }], { total: 3 });
    expect(moves).toHaveLength(1);
    expect(moves[0]?.decay as number).toBeGreaterThan(0.9);
  });

  it("measures anticipation when the move winds up backwards first", () => {
    const [m] = only("position", [{ from: [0, 0], to: [400, 0], start: 0.2, duration: 1.2, ease: ease.inOutBack() }]);
    expect(m?.anticipation).toBeGreaterThan(0.05);
  });

  it("reports a long creeping tail", () => {
    const creep = (t: number) => 1 - (1 - t) ** 8;
    const [m] = only("position", [{ from: [0, 0], to: [400, 0], start: 0, duration: 2, ease: creep }], { total: 3 });
    expect(m?.tailFraction).toBeGreaterThan(0.45);
    const [quick] = only("position", [{ from: [0, 0], to: [400, 0], start: 0, duration: 2, ease: ease.linear }], { total: 3 });
    expect(quick?.tailFraction).toBeLessThan(0.1);
  });
});

describe("findMovements: segmentation", () => {
  it("keeps two separate moves apart", () => {
    const moves = only("position", [
      { from: [0, 0], to: [300, 0], start: 0.2, duration: 0.6, ease: ease.outCubic },
      { from: [300, 0], to: [300, 300], start: 1.6, duration: 0.6, ease: ease.outCubic },
    ]);
    expect(moves).toHaveLength(2);
    expect(moves[1]?.startTime).toBeCloseTo(1.6, 2);
  });

  it("treats there-and-back as one excursion", () => {
    const pulse = (t: number) => Math.sin(Math.PI * t);
    const moves = only("scale", [{ from: [100, 100], to: [130, 130], start: 0.5, duration: 0.6, ease: pulse }]);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.shape).toBe("excursion");
    expect(moves[0]?.amplitude).toBeGreaterThan(40);
  });

  it("ignores sub-pixel drift", () => {
    expect(only("position", [{ from: [0, 0], to: [0.3, 0], start: 0, duration: 2 }])).toHaveLength(0);
  });

  it("returns nothing for a still property", () => {
    expect(only("opacity", [{ from: [100], to: [100], start: 0, duration: 1 }])).toHaveLength(0);
  });

  it("flags expression-driven motion", () => {
    const samples = samplesFor([{ from: [0, 0], to: [200, 0], start: 0, duration: 1 }]);
    const t = track("position", samples, { expression: { text: "wiggle(2, 30)", enabled: true, error: null } });
    const [m] = findMovements(t, layer("Wiggly", [t]), { width: 1920, height: 1080, frameRate: 30, sampleStart: 0 });
    expect(m?.expressionDriven).toBe(true);
  });

  it("reports times relative to the sampled range", () => {
    const { track: t, layer: l } = single("position", [{ from: [0, 0], to: [300, 0], start: 1, duration: 1 }]);
    const [m] = findMovements(t, l, { width: 1920, height: 1080, frameRate: 30, sampleStart: 5 });
    expect(m?.startTime).toBeCloseTo(6, 3);
  });
});

describe("resample", () => {
  it("keeps endpoints and interpolates between them", () => {
    expect(resample([0, 1], 3)).toEqual([0, 0.5, 1]);
    expect(resample([2], 4)).toEqual([2, 2, 2, 2]);
    expect(resample([], 4)).toEqual([]);
  });
});
