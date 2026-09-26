import { describe, expect, it } from "vitest";
import { coefficientOfVariation } from "../src/lens/choreography.js";
import { buildScore, fingerprint } from "../src/lens/score.js";
import { carefulTitleCard, carelessTitleCard } from "./helpers/scenes.js";
import { ease, layer, reading, samplesFor, track } from "./helpers/synth.js";

describe("buildScore", () => {
  it("groups a slide and a fade on one layer into a single entrance", () => {
    const score = buildScore(carelessTitleCard());
    const logo = score.events.filter((e) => e.layerName === "Logo");
    expect(logo).toHaveLength(1);
    expect(logo[0]?.kinds.sort()).toEqual(["opacity", "position"]);
    expect(logo[0]?.role).toBe("entrance");
  });

  it("sees a careless title card start everything together", () => {
    const { choreography } = buildScore(carelessTitleCard());
    expect(choreography.simultaneousStartRatio).toBe(1);
    expect(choreography.simultaneousEndRatio).toBe(1);
    expect(choreography.durationVariation).toBe(0);
    expect(choreography.peakConcurrency).toBe(6);
  });

  it("sees a careful title card stagger its elements", () => {
    const { choreography } = buildScore(carefulTitleCard());
    expect(choreography.simultaneousStartRatio).toBeLessThan(0.34);
    expect(choreography.staggerIntervals.length).toBeGreaterThanOrEqual(4);
    for (const gap of choreography.staggerIntervals) expect(gap).toBeCloseTo(0.08, 1);
    expect(choreography.durationVariation).toBeGreaterThan(0.1);
  });

  it("orders events by start time", () => {
    const score = buildScore(carefulTitleCard());
    const starts = score.choreography.order.map((id) => score.events.find((e) => e.id === id)!.startTime);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("skips disabled layers", () => {
    const moving = track("position", samplesFor([{ from: [0, 0], to: [500, 0], start: 0, duration: 1 }]));
    const score = buildScore(reading([layer("Hidden", [moving], { enabled: false })]));
    expect(score.movements).toHaveLength(0);
  });

  it("notes an expression that errors instead of hiding it", () => {
    const moving = track("position", samplesFor([{ from: [0, 0], to: [500, 0], start: 0, duration: 1 }]), {
      expression: { text: "wigle(2,20)", enabled: true, error: "wigle is not defined" },
    });
    const score = buildScore(reading([layer("Broken", [moving])]));
    expect(score.notes.join(" ")).toContain("wigle is not defined");
  });

  it("carries a truncation warning through", () => {
    const moving = track("position", samplesFor([{ from: [0, 0], to: [500, 0], start: 0, duration: 1 }]));
    const score = buildScore(
      reading([layer("L", [moving])], { truncated: { reason: "sample budget", sampledUntil: 2 } }),
    );
    expect(score.truncated?.reason).toBe("sample budget");
  });
});

describe("fingerprint", () => {
  it("is stable for identical keyframes and changes when a key changes", () => {
    const make = (value: number) => {
      const t = track("opacity", samplesFor([{ from: [0], to: [100], start: 0, duration: 1, ease: ease.outCubic }]), {
        keys: [
          {
            time: 0,
            value: [0],
            inInterpolation: "linear",
            outInterpolation: "bezier",
            inEase: [{ speed: 0, influence: 16.7 }],
            outEase: [{ speed: 0, influence: 75 }],
            temporalContinuous: false,
            temporalAutoBezier: false,
          },
          {
            time: 1,
            value: [value],
            inInterpolation: "bezier",
            outInterpolation: "linear",
            inEase: [{ speed: 0, influence: 75 }],
            outEase: [{ speed: 0, influence: 16.7 }],
            temporalContinuous: false,
            temporalAutoBezier: false,
          },
        ],
      });
      return reading([layer("L", [t], { id: 7 })]);
    };
    expect(fingerprint(make(100))).toBe(fingerprint(make(100)));
    expect(fingerprint(make(100))).not.toBe(fingerprint(make(90)));
  });
});

describe("coefficientOfVariation", () => {
  it("is zero for identical values and for too few values", () => {
    expect(coefficientOfVariation([2, 2, 2])).toBe(0);
    expect(coefficientOfVariation([5])).toBe(0);
    expect(coefficientOfVariation([1, 3])).toBeCloseTo(0.5, 5);
  });
});
