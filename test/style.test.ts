import { describe, expect, it } from "vitest";
import { checkStyle, learnStyle } from "../src/director/style.js";
import { buildScore } from "../src/lens/score.js";
import { carefulTitleCard, carelessTitleCard } from "./helpers/scenes.js";

describe("motion style", () => {
  const careful = buildScore(carefulTitleCard());
  const style = learnStyle("House", [careful], new Date("2026-09-01T00:00:00Z"));

  it("learns easing, durations and stagger by measuring an example", () => {
    expect(style.easing.dominant).toBe("ease-out");
    expect(style.durations.entrance?.median).toBeGreaterThan(0.5);
    expect(style.stagger?.median).toBeCloseTo(0.08, 1);
    expect(style.learnedFrom[0]?.compName).toBe("Title Card (careful)");
  });

  it("is honest about learning from a single comp", () => {
    expect(style.notes.join(" ")).toMatch(/single comp/);
  });

  it("finds nothing to flag in the comp it learned from", () => {
    expect(checkStyle(style, careful)).toEqual([]);
  });

  it("flags where a careless comp breaks the style", () => {
    const aspects = new Set(checkStyle(style, buildScore(carelessTitleCard())).map((d) => d.aspect));
    expect(aspects).toEqual(new Set(["easing", "stagger"]));
  });

  it("explains a deviation in plain words", () => {
    const deviation = checkStyle(style, buildScore(carelessTitleCard())).find((d) => d.aspect === "easing");
    expect(deviation?.message).toMatch(/moves linear, which this style doesn't use \(it mostly eases out\)/);
  });
});
