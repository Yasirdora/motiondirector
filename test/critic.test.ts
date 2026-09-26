import { describe, expect, it } from "vitest";
import { critique } from "../src/critic/critic.js";
import type { DetectorId } from "../src/critic/detectors.js";
import { interpret, knownWords } from "../src/critic/lexicon.js";
import { buildScore } from "../src/lens/score.js";
import type { CompReading } from "../src/lens/types.js";
import { carefulTitleCard, carelessTitleCard } from "./helpers/scenes.js";
import { ease, layer, reading, samplesFor, track } from "./helpers/synth.js";

function run(r: CompReading) {
  return critique(buildScore(r), r);
}

function detectors(r: CompReading): DetectorId[] {
  return run(r).findings.map((f) => f.detector);
}

describe("critique of whole scenes", () => {
  it("names the tells of a careless title card", () => {
    const found = detectors(carelessTitleCard());
    expect(found).toEqual(
      expect.arrayContaining(["linear-easing", "simultaneous-start", "simultaneous-landing", "uniform-duration", "fade-only-entrance"]),
    );
  });

  it("stays quiet about the same card animated with care", () => {
    const found = detectors(carefulTitleCard());
    for (const id of ["linear-easing", "simultaneous-start", "simultaneous-landing", "uniform-duration", "fade-only-entrance"] as const) {
      expect(found).not.toContain(id);
    }
  });

  it("orders findings by severity", () => {
    const { findings } = run(carelessTitleCard());
    const ranks = findings.map((f) => ({ major: 0, minor: 1, note: 2 })[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("says which detectors could not judge instead of dropping them", () => {
    const one = reading([layer("Solo", [track("position", samplesFor([{ from: [0, 0], to: [400, 0], start: 0, duration: 1, ease: ease.outCubic }]))])]);
    const result = run(one);
    expect(result.skipped.map((s) => s.detector)).toContain("simultaneous-start");
    expect(result.findings.map((f) => f.detector)).not.toContain("simultaneous-start");
  });

  it("carries evidence that points at layers and times", () => {
    const linear = run(carelessTitleCard()).findings.find((f) => f.detector === "linear-easing");
    expect(linear?.evidence.length).toBeGreaterThan(0);
    expect(linear?.evidence[0]).toMatchObject({ layerName: expect.any(String), start: 0 });
  });
});

describe("individual detectors", () => {
  const single = (moves: Parameters<typeof samplesFor>[0], kind: Parameters<typeof track>[0] = "position", total = 3) =>
    reading([layer("L", [track(kind, samplesFor(moves, { total }))])]);

  it("catches a bounce that never decays", () => {
    const r = single([{ from: [0, 0], to: [100, 100], start: 0.1, duration: 2, ease: ease.symmetricBounce() }], "scale");
    expect(detectors(r)).toContain("ping-pong-bounce");
  });

  it("accepts a spring that settles", () => {
    const r = single([{ from: [0], to: [90], start: 0.1, duration: 2, ease: ease.spring() }], "rotation");
    expect(detectors(r)).not.toContain("ping-pong-bounce");
  });

  it("catches a heavy overshoot but not a subtle one", () => {
    const heavy = single([{ from: [0, 0], to: [500, 0], start: 0.1, duration: 1, ease: ease.outBack(4) }]);
    const subtle = single([{ from: [0, 0], to: [500, 0], start: 0.1, duration: 1, ease: ease.outBack(1) }]);
    expect(detectors(heavy)).toContain("heavy-overshoot");
    expect(detectors(subtle)).not.toContain("heavy-overshoot");
  });

  it("catches a creeping tail", () => {
    const creep = (t: number) => 1 - (1 - t) ** 8;
    expect(detectors(single([{ from: [0, 0], to: [500, 0], start: 0, duration: 2, ease: creep }]))).toContain("sluggish-tail");
    expect(detectors(single([{ from: [0, 0], to: [500, 0], start: 0, duration: 1, ease: ease.outCubic }]))).not.toContain("sluggish-tail");
  });

  it("catches acceleration into a dead stop", () => {
    expect(detectors(single([{ from: [0, 0], to: [600, 0], start: 0.2, duration: 0.8, ease: ease.inCubic }]))).toContain("hard-stop");
  });

  it("catches a large move that is over in a blink", () => {
    expect(detectors(single([{ from: [0, 0], to: [800, 0], start: 0.2, duration: 0.1, ease: ease.outCubic }]))).toContain("abrupt-move");
  });

  it("catches a fast, wide wiggle expression but not a gentle drift", () => {
    const withExpression = (text: string) =>
      reading([
        layer("W", [
          track("position", samplesFor([{ from: [0, 0], to: [30, 0], start: 0, duration: 2 }]), {
            expression: { text, enabled: true, error: null },
          }),
        ]),
      ]);
    expect(detectors(withExpression("wiggle(5, 50)"))).toContain("default-wiggle");
    expect(detectors(withExpression("wiggle(0.5, 6)"))).not.toContain("default-wiggle");
  });

  it("does not call a continuous spin linear easing", () => {
    const r = single([{ from: [0], to: [720], start: 0, duration: 3 }], "rotation");
    expect(detectors(r)).not.toContain("linear-easing");
  });
});

describe("interpret", () => {
  it("explains 'cheap' with what was measured and asks one question across aspects", () => {
    const r = carelessTitleCard();
    const result = interpret("This logo reveal feels cheap.", run(r));
    expect(result.matched.map((m) => m.word)).toEqual(["cheap"]);
    expect(result.explanations[0]?.detector).toBe("linear-easing");
    expect(result.axes).toEqual(expect.arrayContaining(["feel", "choreography"]));
    expect(result.question).toMatch(/choreography/);
    expect(result.question).toMatch(/feel/);
    expect(result.summary).toMatch(/constant speed/);
  });

  it("does not ask when only one aspect is involved", () => {
    const creep = (t: number) => 1 - (1 - t) ** 8;
    const r = reading([layer("L", [track("position", samplesFor([{ from: [0, 0], to: [500, 0], start: 0, duration: 2, ease: creep }], { total: 3 }))])]);
    const result = interpret("It feels a bit heavy", run(r));
    expect(result.axes).toEqual(["feel"]);
    expect(result.question).toBeNull();
  });

  it("admits when the words point at nothing measurable", () => {
    const result = interpret("It feels cheap", run(carefulTitleCard()));
    expect(result.explanations).toHaveLength(0);
    expect(result.question).toBeNull();
    expect(result.summary).toMatch(/None of the usual measurable causes/);
  });

  it("admits when it does not know the word", () => {
    const result = interpret("It feels purple", run(carelessTitleCard()));
    expect(result.matched).toHaveLength(0);
    expect(result.summary).toMatch(/don't have a measured meaning/);
  });

  it("matches whole words only", () => {
    const result = interpret("the flatbread scene", run(carelessTitleCard()));
    expect(result.matched).toHaveLength(0);
  });

  it("knows a useful vocabulary", () => {
    expect(knownWords().length).toBeGreaterThan(60);
  });
});
