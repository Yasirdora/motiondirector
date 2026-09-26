import { describe, expect, it } from "vitest";
import { EASE_PRESETS, easeSegment } from "../src/director/ease.js";
import { valueAt } from "../src/lens/evaluate.js";
import { findMovements } from "../src/lens/movements.js";
import type { Keyframe } from "../src/lens/types.js";
import { key, spatialKey } from "./helpers/keyed.js";
import { layer, track } from "./helpers/synth.js";

const scalar = (keys: Keyframe[]) => ({ keys, spatial: false, dimensions: 1 });

function eased(preset: keyof typeof EASE_PRESETS, spatial = false): Keyframe[] {
  const make = spatial ? spatialKey : key;
  const a = make(0, spatial ? [0, 0] : [0], { outInterpolation: "bezier" });
  const b = make(1, spatial ? [300, 400] : [100], { inInterpolation: "bezier" });
  const e = easeSegment(a, b, { spatial, dimensions: spatial ? 2 : 1 }, EASE_PRESETS[preset]);
  a.outEase = e.out;
  b.inEase = e.in;
  return [a, b];
}

describe("valueAt", () => {
  it("interpolates linear keys linearly and holds outside them", () => {
    const keys = [key(1, [0]), key(2, [100])];
    expect(valueAt(scalar(keys), 0)).toEqual([0]);
    expect(valueAt(scalar(keys), 1.25)[0]).toBeCloseTo(25, 6);
    expect(valueAt(scalar(keys), 3)).toEqual([100]);
  });

  it("holds a value until the next key for hold interpolation", () => {
    const keys = [key(0, [0], { outInterpolation: "hold" }), key(1, [100], { inInterpolation: "hold" })];
    expect(valueAt(scalar(keys), 0.99)).toEqual([0]);
  });

  it("reproduces the CSS curve the ease preset was converted from", () => {
    const keys = eased("ease-in-out");
    // cubic-bezier(0.65, 0, 0.35, 1) is symmetric, so it passes the midpoint at half time.
    expect(valueAt(scalar(keys), 0.5)[0]).toBeCloseTo(50, 3);
    expect(valueAt(scalar(keys), 0.25)[0]).toBeLessThan(15);
  });

  it("eases a spatial property along its path", () => {
    const keys = eased("ease-in-out", true);
    const mid = valueAt({ keys, spatial: true, dimensions: 2 }, 0.5);
    expect(mid[0]).toBeCloseTo(150, 2);
    expect(mid[1]).toBeCloseTo(200, 2);
  });

  it("produces curves the Lens classifies as the preset intended", () => {
    const comp = { width: 1920, height: 1080, frameRate: 30, sampleStart: 0 };
    const shapeOf = (preset: keyof typeof EASE_PRESETS) => {
      const keys = eased(preset);
      const samples = Array.from({ length: 46 }, (_, f) => valueAt(scalar(keys), f / 30));
      const t = track("opacity", samples, { keys });
      return findMovements(t, layer("L", [t]), comp)[0]?.shape;
    };
    expect(shapeOf("ease-out")).toBe("ease-out");
    expect(shapeOf("ease-in")).toBe("ease-in");
    expect(shapeOf("ease-in-out")).toBe("ease-in-out");
    expect(shapeOf("linear")).toBe("linear");
  });
});
