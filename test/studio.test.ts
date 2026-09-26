import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AfterEffects } from "../src/ae/client.js";
import type { AeOutcome } from "../src/ae/protocol.js";
import type { MailboxTransport } from "../src/ae/transport.js";
import { currentRevision } from "../src/director/brief.js";
import { Store } from "../src/director/store.js";
import { Studio, StudioError } from "../src/server/studio.js";
import type { CompItem, FakeAfterEffects } from "./helpers/fake-ae.js";
import { fakeStudio } from "./helpers/studio.js";

describe("Studio: the direction loop against a fake After Effects", () => {
  let root: string;
  let ae: FakeAfterEffects;
  let studio: Studio;
  let comp: CompItem;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "md-studio-"));
    ({ ae, studio, comp } = fakeStudio(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function approvedBrief() {
    const brief = await studio.createBrief({
      feedback: "This logo reveal feels cheap.",
      content: { interpretation: "Stagger and ease the elements; keep it quick.", keep: ["Total length under 1.5 s"] },
    });
    return studio.approveBrief(brief.id, 1, currentRevision(brief).hash, "designer");
  }

  it("reads the active comp and explains 'cheap' with measurements and one question", async () => {
    const analysis = await studio.analyse();
    expect(analysis.reading.name).toBe("Title Card (careless, keyed)");
    const meaning = studio.interpret("This logo reveal feels cheap.", analysis);
    expect(meaning.explanations.map((f) => f.detector)).toContain("linear-easing");
    expect(meaning.question).toMatch(/choreography/);
    expect(meaning.question).toMatch(/feel/);
  });

  it("finds comps by name and says which exist when one is missing", async () => {
    expect((await studio.resolveComp("title card")).id).toBe(comp.id);
    await expect(studio.resolveComp("Nope")).rejects.toThrow(/no comp called "Nope"/);
  });

  it("refuses to try changes before the brief is approved", async () => {
    const brief = await studio.createBrief({ feedback: "Feels cheap", content: {} });
    await expect(studio.tryVariants(brief.id)).rejects.toThrow(/not approved/);
  });

  it("rehearses every variant on a copy and leaves the original untouched", async () => {
    const before = structuredClone(comp.layers.map((l) => l.prop("ADBE Opacity").keys));
    const result = await studio.tryVariants((await approvedBrief()).id);
    expect(result.variants.map((v) => v.change.variant.label)).toEqual(["Choreography", "Feel", "Both"]);
    for (const v of result.variants) {
      expect(v.change.status).toBe("rehearsed");
      expect(v.rehearsal).not.toBeNull();
    }
    expect(comp.layers.map((l) => l.prop("ADBE Opacity").keys)).toEqual(before);
    const rehearsals = ae.project.items.filter((i) => "comment" in i && String(i.comment).startsWith("motion-director-rehearsal"));
    expect(rehearsals).toHaveLength(3);
    expect(existsSync(result.reviewPath)).toBe(true);
    expect(result.completion.label).toBe("Ready for design review");
    // Measured on the rehearsal, the 'Both' variant no longer shows the tells it targets.
    const both = result.variants.find((v) => v.change.variant.label === "Both")!;
    const after = both.critiqueAfter!.findings.map((f) => f.detector);
    expect(after).not.toContain("linear-easing");
    expect(after).not.toContain("simultaneous-start");
  });

  it("applies a rehearsed variant as one step, verifies it, and restores it exactly", async () => {
    const original = structuredClone(comp.layers.map((l) => [l.prop("ADBE Opacity").keys, l.prop("ADBE Position").keys]));
    const result = await studio.tryVariants((await approvedBrief()).id);
    const both = result.variants.find((v) => v.change.variant.label === "Both")!;
    ae.undoGroups.length = 0;

    const applied = await studio.apply(both.change.id);
    expect(applied.change.status).toBe("applied");
    expect(applied.message).toMatch(/verified/);
    expect(ae.undoGroups).toEqual(["Motion Director: Both (variant C)"]);
    const title = comp.layers.find((l) => l.name === "Title")!;
    expect(title.prop("ADBE Opacity").keys[0]!.time).toBeGreaterThan(0);

    const restored = await studio.restore(both.change.id);
    expect(restored.change.status).toBe("restored");
    expect(comp.layers.map((l) => [l.prop("ADBE Opacity").keys, l.prop("ADBE Position").keys])).toEqual(original);
    await expect(studio.restore(both.change.id)).rejects.toThrow(/nothing to restore/);
  });

  it("will not apply a change made for an earlier revision of the brief", async () => {
    const brief = await approvedBrief();
    const result = await studio.tryVariants(brief.id);
    const revised = await studio.reviseBrief(brief.id, { feedback: "The overshoot is too strong.", changes: { decisions: ["Less overshoot"] }, note: "Softer landing." });
    await expect(studio.apply(result.variants[2]!.change.id)).rejects.toThrow(/revision 1 of the brief/);
    // Even once the new revision is approved, the old change stays bound to revision 1.
    await studio.approveBrief(brief.id, 2, currentRevision(revised).hash, "designer");
    await expect(studio.apply(result.variants[2]!.change.id)).rejects.toThrow(/approved direction is now different/);
  });

  it("refuses to apply over edits made after the variants were planned", async () => {
    const result = await studio.tryVariants((await approvedBrief()).id);
    comp.layers[0]!.prop("ADBE Opacity").keys[1]!.value = [80];
    await expect(studio.apply(result.variants[2]!.change.id)).rejects.toThrow(/Nothing was applied: Logo › Opacity/);
    expect(comp.layers[0]!.prop("ADBE Opacity").keys[1]!.value).toEqual([80]);
  });

  it("refuses to restore over work done after the change was applied", async () => {
    const result = await studio.tryVariants((await approvedBrief()).id);
    const change = result.variants[2]!.change;
    await studio.apply(change.id);
    comp.layers[1]!.prop("ADBE Opacity").keys[1]!.value = [55];
    await expect(studio.restore(change.id)).rejects.toThrow(/Nothing was restored: Title › Opacity changed/);
    expect(comp.layers[1]!.prop("ADBE Opacity").keys[1]!.value).toEqual([55]);
  });

  it("removes its rehearsal copies and nothing else", async () => {
    const brief = await approvedBrief();
    await studio.tryVariants(brief.id);
    const removed = await studio.discardRehearsals(brief.id);
    expect(removed).toHaveLength(3);
    expect(ae.project.items.filter((i) => "comment" in i && String(i.comment).startsWith("motion-director-rehearsal"))).toHaveLength(0);
    expect(ae.project.itemByID(comp.id)).toBe(comp);
  });

  it("remembers briefs and changes across a restart", async () => {
    const brief = await approvedBrief();
    await studio.tryVariants(brief.id);
    const again = new Studio(new AfterEffects((studio as unknown as { ae: { transport: MailboxTransport } }).ae.transport), { store: new Store(path.join(root, "store")), previews: false });
    const history = await again.history();
    expect(history.briefs.map((b) => b.id)).toEqual([brief.id]);
    expect(history.changes.every((c) => c.status === "rehearsed")).toBe(true);
    expect(history.changes[0]!.log.map((l) => l.status)).toEqual(["planned", "rehearsing", "rehearsed"]);
  });

  it("learns a motion style and checks a comp against it", async () => {
    const style = await studio.learnStyle("House", []);
    expect(style.easing.dominant).toBe("linear");
    const { deviations } = await studio.checkStyle("House");
    expect(deviations).toEqual([]);
    await expect(studio.checkStyle("Missing")).rejects.toThrow(/no motion style called "Missing"/);
  });

  it("does not change anything in read-only mode", async () => {
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "md-studio-"));
    const { studio: readOnly } = fakeStudio(root, { readOnly: true });
    const brief = await readOnly.createBrief({ feedback: "cheap", content: {} });
    const approved = await readOnly.approveBrief(brief.id, 1, currentRevision(brief).hash, "designer");
    await expect(readOnly.tryVariants(approved.id)).rejects.toThrow(/read-only/);
  });
});

describe("Studio with previews", () => {
  it("renders real-speed previews into the review and reports them as checks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "md-studio-"));
    try {
      const { studio } = fakeStudio(root, { previews: true });
      const brief = await studio.createBrief({ feedback: "cheap", content: {} });
      await studio.approveBrief(brief.id, 1, currentRevision(brief).hash, "designer");
      const result = await studio.tryVariants(brief.id, { axes: ["feel"] });
      const html = readFileSync(result.reviewPath, "utf8");
      const data = JSON.parse(html.split('type="application/json">')[1]!.split("</script>")[0]!);
      expect(data.comparisons[0].preview.fps).toBe(30);
      expect(data.comparisons[0].preview.frames[0]).toBe("frames-now/0000.png");
      expect(existsSync(path.join(path.dirname(result.reviewPath), "frames-now", "0000.png"))).toBe(true);
      expect(data.checks.filter((c: { label: string }) => c.label.startsWith("Render")).every((c: { state: string }) => c.state === "done")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Studio resolves unknown outcomes by reading, never by retrying", () => {
  it("records a change as applied when the read-back shows it applied", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "md-studio-"));
    try {
      const { studio, client } = fakeStudio(root);
      const brief = await studio.createBrief({ feedback: "cheap", content: {} });
      await studio.approveBrief(brief.id, 1, currentRevision(brief).hash, "designer");
      const result = await studio.tryVariants(brief.id);
      // After Effects applies the change but the answer is lost.
      const real = client.setKeys.bind(client);
      let calls = 0;
      client.setKeys = async (...args: Parameters<typeof client.setKeys>) => {
        calls++;
        await real(...args);
        return { status: "unknown", message: "no answer", hint: "", durationMs: 1 } as AeOutcome<{ applied: number }>;
      };
      const applied = await studio.apply(result.variants[1]!.change.id);
      expect(calls).toBe(1);
      expect(applied.change.status).toBe("applied");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the outcome unknown when the read-back fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "md-studio-"));
    try {
      const { studio, client } = fakeStudio(root);
      const brief = await studio.createBrief({ feedback: "cheap", content: {} });
      await studio.approveBrief(brief.id, 1, currentRevision(brief).hash, "designer");
      const result = await studio.tryVariants(brief.id);
      const realRead = client.readComp.bind(client);
      let reads = 0;
      client.setKeys = async () => ({ status: "unknown", message: "no answer", hint: "", durationMs: 1 });
      client.readComp = async (...args: Parameters<typeof client.readComp>) => {
        reads++;
        // The first read is the pre-apply drift check; the confirming read fails.
        return reads === 1 ? realRead(...args) : { status: "failed", code: "NOT_PICKED_UP", message: "busy", hint: "", durationMs: 1, logs: [] };
      };
      const outcome = await studio.apply(result.variants[1]!.change.id);
      expect(outcome.change.status).toBe("outcome-unknown");
      expect(outcome.message).toMatch(/Don't repeat the change/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("StudioError", () => {
  it("carries a plain next step", () => {
    const e = new StudioError("What happened.", "What to do.");
    expect(e.hint).toBe("What to do.");
  });
});
