import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalError,
  approveBrief,
  briefToMarkdown,
  createBrief,
  currentRevision,
  isApproved,
  reviseBrief,
} from "../src/director/brief.js";
import { createChange, findDrift, sameKeys, transition, TransitionError } from "../src/director/changes.js";
import { planVariant } from "../src/director/recipes.js";
import { projectKey, Store } from "../src/director/store.js";
import { buildScore } from "../src/lens/score.js";
import { keyedCarelessTitleCard } from "./helpers/scenes.js";
import { key } from "./helpers/keyed.js";

const first = () =>
  createBrief({
    compId: 1,
    compName: "Logo Reveal",
    feedback: "Make the sidebar feel more alive.",
    content: {
      interpretation: "Hover and selection respond more clearly; motion stays restrained.",
      keep: ["Sidebar width", "Icon set"],
      acceptance: ["Selection eases out in under 250 ms"],
    },
    now: new Date("2026-09-01T10:00:00Z"),
  });

describe("brief", () => {
  it("keeps the designer's words verbatim and separate from the interpretation", () => {
    const brief = first();
    expect(brief.feedback[0]!.text).toBe("Make the sidebar feel more alive.");
    expect(currentRevision(brief).interpretation).toMatch(/Hover and selection/);
  });

  it("carries every earlier decision forward into a revision", () => {
    const revised = reviseBrief(first(), {
      feedback: "The selection is better, but hover feels too strong.",
      changes: { decisions: ["Hover: halve the scale change"] },
      note: "Hover softened; selection kept from rev 1.",
    });
    const rev = currentRevision(revised);
    expect(rev.revision).toBe(2);
    expect(rev.keep).toEqual(["Sidebar width", "Icon set"]);
    expect(rev.interpretation).toMatch(/Hover and selection/);
    expect(rev.decisions).toEqual(["Hover: halve the scale change"]);
    expect(revised.feedback.map((f) => f.revision)).toEqual([1, 2]);
  });

  it("binds approval to one exact revision", () => {
    const brief = first();
    const approved = approveBrief(brief, 1, currentRevision(brief).hash, "designer");
    expect(isApproved(approved)).toBe(true);

    const revised = reviseBrief(approved, { changes: { acceptance: ["Hover under 150 ms"] }, note: "Tighter hover." });
    expect(isApproved(revised)).toBe(false);
    expect(briefToMarkdown(revised)).toMatch(/revision 1 was approved, the brief is now at revision 2/);
  });

  it("refuses to approve a stale revision or a changed one", () => {
    const revised = reviseBrief(first(), { changes: { experience: "Calmer" }, note: "Calmer." });
    expect(() => approveBrief(revised, 1, revised.revisions[0]!.hash, "designer")).toThrow(ApprovalError);
    expect(() => approveBrief(revised, 2, "0000000000000000", "designer")).toThrow(/changed since it was shown/);
  });

  it("says who approved", () => {
    const brief = first();
    const byAgent = approveBrief(brief, 1, currentRevision(brief).hash, "agent-on-behalf-of-designer");
    expect(briefToMarkdown(byAgent)).toMatch(/recorded by the agent on the designer's behalf/);
  });

  it("a revision that changes nothing still needs its own approval", () => {
    const brief = first();
    const approved = approveBrief(brief, 1, currentRevision(brief).hash, "designer");
    const again = reviseBrief(approved, { changes: {}, note: "Re-read, no change." });
    expect(currentRevision(again).hash).toBe(currentRevision(brief).hash);
    expect(isApproved(again)).toBe(false);
  });
});

describe("store", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("writes atomically, reads back and lists", () => {
    root = mkdtempSync(path.join(tmpdir(), "md-store-"));
    const store = new Store(root);
    const brief = first();
    store.write("p1", "briefs", brief.id, brief);
    expect(store.read("p1", "briefs", brief.id)).toEqual(brief);
    expect(store.list("p1", "briefs")).toHaveLength(1);
    expect(readdirSync(path.join(root, "projects", "p1", "briefs")).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(store.read("p1", "briefs", "missing")).toBeNull();
    expect(store.list("nothing-here", "changes")).toEqual([]);
  });

  it("refuses ids that could escape the store", () => {
    root = mkdtempSync(path.join(tmpdir(), "md-store-"));
    const store = new Store(root);
    expect(() => store.write("p1", "briefs", "../evil", {})).toThrow(/Unsafe/);
    expect(() => store.read("..", "briefs", "x")).toThrow(/Unsafe/);
  });

  it("keys projects by path, and unsaved ones by name", () => {
    expect(projectKey("/work/a.aep", "a")).toBe(projectKey("/work/../work/a.aep", "a"));
    expect(projectKey("/work/a.aep", "a")).not.toBe(projectKey("/work/b.aep", "a"));
    expect(projectKey(null, "My Project!")).toBe("unsaved-my-project");
  });
});

describe("changes", () => {
  function planned() {
    const reading = keyedCarelessTitleCard();
    const score = buildScore(reading);
    const ids = score.movements.map((m) => m.id);
    const plan = planVariant(reading, score, "Eased", [{ recipe: "re-ease", preset: "ease-out", movements: ids }]);
    const change = createChange({
      compId: 1,
      compName: reading.name,
      brief: { id: "b", revision: 1, hash: "h" },
      variant: { id: "B", label: "Feel", intent: "Easing only." },
      plan,
      beforeFingerprint: score.fingerprint,
    });
    return { reading, plan, change };
  }

  it("moves only through allowed states", () => {
    const { change } = planned();
    const rehearsing = transition(change, "rehearsing", "Rehearsing on a copy.");
    expect(() => transition(rehearsing, "applied", "skip")).toThrow(TransitionError);
    const unknown = transition(rehearsing, "outcome-unknown", "After Effects took the request but did not answer.");
    // An unknown outcome is resolved by reading the project, not by retrying.
    expect(() => transition(unknown, "rehearsing", "retry")).toThrow(TransitionError);
    expect(transition(unknown, "rehearsed", "Read back: the rehearsal exists.").status).toBe("rehearsed");
    expect(transition(unknown, "rehearsed", "x").log.map((l) => l.status)).toEqual(["planned", "rehearsing", "outcome-unknown", "rehearsed"]);
  });

  it("a restored change is final", () => {
    let { change } = planned();
    for (const [to, note] of [["rehearsing", "r"], ["rehearsed", "ok"], ["applying", "a"], ["applied", "done"], ["restored", "back"]] as const) {
      change = transition(change, to, note);
    }
    expect(() => transition(change, "applied", "again")).toThrow(TransitionError);
  });

  it("finds no drift when the project is as planned", () => {
    const { reading, plan } = planned();
    expect(findDrift(plan.edits, reading, "before")).toEqual([]);
  });

  it("finds drift when the designer edited a property after the plan", () => {
    const { reading, plan } = planned();
    const edited = structuredClone(reading);
    edited.layers[1]!.properties[0]!.keys[1]!.value = [80];
    const drift = findDrift(plan.edits, edited, "before");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ layerName: "Title", propertyName: "Opacity" });
  });

  it("reports a deleted layer as drift", () => {
    const { reading, plan } = planned();
    const edited = { ...reading, layers: reading.layers.slice(1) };
    expect(findDrift(plan.edits, edited, "before").some((d) => d.reason === "the layer no longer exists")).toBe(true);
  });

  it("compares keys with the tolerance After Effects' floats need", () => {
    const a = [key(0, [0]), key(1, [100])];
    const b = [key(0.00001, [0.0001]), key(1, [100.00001])];
    expect(sameKeys(a, b)).toBe(true);
    expect(sameKeys(a, [key(0, [0]), key(1, [101])])).toBe(false);
  });
});
