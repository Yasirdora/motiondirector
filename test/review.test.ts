import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { critique } from "../src/critic/critic.js";
import { createBrief } from "../src/director/brief.js";
import { buildScore } from "../src/lens/score.js";
import { completionFor, toReviewBrief, toReviewFindings, toReviewScore, type ReviewData } from "../src/review/data.js";
import { embedJson, renderReviewPage, writeReviewPage } from "../src/review/page.js";
import { carelessTitleCard } from "./helpers/scenes.js";

function sample(layerName = "Logo"): ReviewData {
  const reading = carelessTitleCard();
  reading.layers[0]!.name = layerName;
  const score = buildScore(reading);
  return {
    title: "Review",
    compName: reading.name,
    generatedAt: "2026-09-26T12:00:00.000Z",
    completion: completionFor([]),
    brief: toReviewBrief(createBrief({ compId: 1, compName: reading.name, feedback: "Feels cheap", content: {} })),
    comparisons: [{ id: "now", label: "Now", kind: "measured", summary: [], score: toReviewScore(score), findings: toReviewFindings(critique(score, reading), score) }],
    checks: [],
    needsDesigner: [],
  };
}

describe("review page", () => {
  it("is one self-contained file with its styles, script and data", () => {
    const html = renderReviewPage(sample());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<style>");
    expect(html).toContain('<script id="review-data" type="application/json">');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it("keeps a hostile layer name as data", () => {
    const hostile = '</script><script>alert("x")</script>';
    const html = renderReviewPage(sample(hostile));
    expect(html).not.toContain(hostile);
    const json = html.split('type="application/json">')[1]!.split("</script>")[0]!;
    expect(JSON.parse(json).comparisons[0].score.movements.some((m: { layerName: string }) => m.layerName === hostile)).toBe(true);
  });

  it("escapes what would break a script element", () => {
    const sep = String.fromCharCode(0x2028);
    expect(embedJson({ a: `<b>${sep}` })).toBe('{"a":"\\u003cb>\\u2028"}');
  });

  it("maps findings to the movements they are about", () => {
    const findings = sample().comparisons[0]!.findings;
    const simultaneous = findings.find((f) => f.detector === "simultaneous-start")!;
    expect(simultaneous.movementIds.length).toBe(10);
    expect(simultaneous.times).toEqual([0]);
    const linear = findings.find((f) => f.detector === "linear-easing")!;
    expect(linear.times).toEqual([]);
  });

  it("writes index.html into its own folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "md-review-"));
    try {
      const file = writeReviewPage(path.join(dir, "r1"), sample());
      expect(file.endsWith(path.join("r1", "index.html"))).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("Review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("completionFor", () => {
  const check = (state: "done" | "incomplete" | "failed" | "not-checked", required = true) => ({ label: `a ${state} check`, state, detail: "", required });

  it("is ready only when every required check is done", () => {
    expect(completionFor([check("done"), check("not-checked", false)]).label).toBe("Ready for design review");
  });

  it("treats a required check that did not finish as incomplete, never as passed", () => {
    expect(completionFor([check("done"), check("incomplete")]).state).toBe("incomplete");
    expect(completionFor([check("done"), check("not-checked")]).label).toBe("Checks incomplete");
  });

  it("lets any failure fail the review", () => {
    expect(completionFor([check("incomplete"), check("failed", false)]).label).toBe("Checks failed");
  });
});
