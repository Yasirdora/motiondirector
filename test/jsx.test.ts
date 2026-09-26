import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AeResponse } from "../src/ae/protocol.js";
import { serialize } from "../src/ae/transport.js";
import { buildScore } from "../src/lens/score.js";
import type { CompReading, Keyframe } from "../src/lens/types.js";
import { createFakeAfterEffects, type CompItem, type FakeAfterEffects, FakeLayer } from "./helpers/fake-ae.js";
import { key, spatialKey } from "./helpers/keyed.js";

const JSX = path.resolve(import.meta.dirname, "..", "jsx");

describe("ExtendScript sources", () => {
  for (const file of readdirSync(JSX).filter((f) => f.endsWith(".jsx"))) {
    it(`${file} is valid ES3`, () => {
      expect(() => parse(readFileSync(path.join(JSX, file), "utf8"), { ecmaVersion: 3 })).not.toThrow();
    });
  }

  it("is plain ASCII, because ExtendScript can misread UTF-8 source without a byte-order mark", () => {
    for (const file of readdirSync(JSX).filter((f) => f.endsWith(".jsx"))) {
      expect(readFileSync(path.join(JSX, file), "utf8")).toMatch(/^[\x00-\x7f]*$/);
    }
  });

  it("never evaluates request data as code", () => {
    for (const file of readdirSync(JSX).filter((f) => f.endsWith(".jsx"))) {
      const source = readFileSync(path.join(JSX, file), "utf8").replace(/\/\/.*$/gm, "");
      expect(source).not.toMatch(/\beval\s*\(/);
      expect(source).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});

describe("dispatcher and operations (fake After Effects)", () => {
  let root: string;
  let mailbox: string;
  let ae: FakeAfterEffects;
  let comp: CompItem;
  let logo: FakeLayer;
  let title: FakeLayer;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "md-jsx-"));
    mailbox = path.join(root, "motion-director", "mailbox");
    ae = createFakeAfterEffects(root);
    mkdirSync(mailbox, { recursive: true });
    comp = ae.project.addComp("Logo Reveal");
    logo = comp.addLayer(new FakeLayer(ae.project.nextId(), "Logo"));
    title = comp.addLayer(new FakeLayer(ae.project.nextId(), "Title"));
    logo.prop("ADBE Opacity").keys = [key(0, [0]), key(0.5, [100])];
    logo.prop("ADBE Position").keys = [spatialKey(0, [960, 640]), spatialKey(0.5, [960, 540])];
    title.prop("ADBE Opacity").keys = [key(0, [0]), key(0.5, [100])];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function call<T = unknown>(op: string, args: unknown, mutates = false): AeResponse & { result: T } {
    const id = `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
    writeFileSync(path.join(mailbox, `request-${id}.json`), serialize({ id, op, args, label: op, mutates }));
    ae.runDispatcher(mailbox);
    const file = path.join(mailbox, `response-${id}.json`);
    const response = JSON.parse(readFileSync(file, "utf8")) as AeResponse & { result: T };
    rmSync(file);
    expect(readdirSync(mailbox).some((n) => n.startsWith("request-"))).toBe(false);
    return response;
  }

  it("answers ping with the project and the active comp", () => {
    ae.project.activeItem = comp;
    const r = call<{ activeComp: { name: string } }>("ping", {});
    expect(r.ok).toBe(true);
    expect(r.result.activeComp.name).toBe("Logo Reveal");
  });

  it("refuses an unknown operation before running anything", () => {
    const r = call("rm_rf", {});
    expect(r).toMatchObject({ ok: false, phase: "dispatch" });
    expect(r.error).toMatch(/unknown operation/);
  });

  it("writes nothing when there is no request, so it cannot overwrite another answer", () => {
    ae.runDispatcher(mailbox);
    expect(readdirSync(mailbox).filter((n) => n.startsWith("response-"))).toEqual([]);
  });

  it("reads a comp into a reading the Lens understands", () => {
    const r = call<CompReading>("read_comp", { compId: comp.id });
    expect(r.ok).toBe(true);
    const reading = r.result;
    expect(reading.sampleCount).toBe(91);
    const logoTrack = reading.layers[0]!.properties.find((p) => p.path.join("/") === "ADBE Transform Group/ADBE Position")!;
    expect(logoTrack.spatial).toBe(true);
    expect(logoTrack.keys[1]!.value).toEqual([960, 540]);
    expect(logoTrack.samples[15]).toEqual([960, 540]);
    // Only animated properties are read.
    expect(reading.layers[1]!.properties.map((p) => p.name)).toEqual(["Opacity"]);
    const score = buildScore(reading);
    expect(score.events).toHaveLength(2);
    expect(score.choreography.simultaneousStartRatio).toBe(1);
  });

  it("caps sampling and says so", () => {
    const r = call<CompReading>("read_comp", { compId: comp.id, maxSamples: 30 });
    expect(r.result.sampleCount).toBe(10);
    expect(r.result.truncated?.reason).toMatch(/capped/);
  });

  it("rehearses on a marked copy and maps layer ids", () => {
    const r = call<{ compId: number; layerMap: [number, number][] }>("duplicate_comp", { compId: comp.id, label: "Variant B" }, true);
    expect(r.ok).toBe(true);
    const copy = ae.project.itemByID(r.result.compId) as CompItem;
    expect(copy.name).toBe("Logo Reveal \u2014 Variant B");
    expect(copy.comment).toMatch(/^motion-director-rehearsal/);
    expect(r.result.layerMap).toEqual([
      [logo.id, copy.layer(1).id],
      [title.id, copy.layer(2).id],
    ]);
    expect(ae.undoGroups).toEqual(["Motion Director: duplicate_comp"]);
  });

  it("deletes only its own rehearsals", () => {
    const refused = call("delete_rehearsal", { compId: comp.id }, true);
    expect(refused.ok).toBe(false);
    expect(refused.rolledBack).toBe(true);
    expect(comp.removed).toBe(false);

    const copy = call<{ compId: number }>("duplicate_comp", { compId: comp.id }, true);
    expect(call("delete_rehearsal", { compId: copy.result.compId }, true).ok).toBe(true);
  });

  const eased = (): Keyframe[] => [
    key(0, [0], { outInterpolation: "bezier", outEase: [{ speed: 1250, influence: 16 }] }),
    key(0.5, [100], { inInterpolation: "bezier", inEase: [{ speed: 0, influence: 70 }] }),
  ];

  it("replaces keys exactly, as one undo step", () => {
    const edits = [{ layerId: logo.id, path: ["ADBE Transform Group", "ADBE Opacity"], keys: eased(), expect: logo.prop("ADBE Opacity").keys }];
    const r = call("set_keys", { compId: comp.id, edits }, true);
    expect(r.ok).toBe(true);
    expect(logo.prop("ADBE Opacity").keys).toEqual(eased());
    expect(ae.undoGroups).toEqual(["Motion Director: set_keys"]);
    expect(ae.suppressedDialogs).toBe(1);
  });

  it("refuses to apply over keys that changed since they were read", () => {
    const expected = structuredClone(logo.prop("ADBE Opacity").keys);
    logo.prop("ADBE Opacity").keys[1]!.value = [80]; // the designer edited it meanwhile
    const r = call("set_keys", { compId: comp.id, edits: [{ layerId: logo.id, path: ["ADBE Transform Group", "ADBE Opacity"], keys: eased(), expect: expected }] }, true);
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.error).toMatch(/Logo › Opacity/);
    expect(logo.prop("ADBE Opacity").keys[1]!.value).toEqual([80]);
  });

  it("puts every touched property back when a later one fails", () => {
    const before = structuredClone(logo.prop("ADBE Opacity").keys);
    title.prop("ADBE Opacity").failOnAddKey = true;
    const r = call("set_keys", {
      compId: comp.id,
      edits: [
        { layerId: logo.id, path: ["ADBE Transform Group", "ADBE Opacity"], keys: eased() },
        { layerId: title.id, path: ["ADBE Transform Group", "ADBE Opacity"], keys: eased() },
      ],
    }, true);
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(logo.prop("ADBE Opacity").keys).toEqual(before);
  });

  it("respects After Effects' ease arity for spatial properties", () => {
    const keys = [
      spatialKey(0, [960, 640], { outInterpolation: "bezier", outEase: [{ speed: 900, influence: 30 }] }),
      spatialKey(0.5, [960, 540], { inInterpolation: "bezier", inEase: [{ speed: 0, influence: 70 }] }),
    ];
    const r = call("set_keys", { compId: comp.id, edits: [{ layerId: logo.id, path: ["ADBE Transform Group", "ADBE Position"], keys }] }, true);
    expect(r.ok).toBe(true);
    expect(logo.prop("ADBE Position").keys[0]!.outEase).toEqual([{ speed: 900, influence: 30 }]);
  });

  it("refuses to address a layer that does not exist", () => {
    const r = call("set_keys", { compId: comp.id, edits: [{ layerId: 9999, path: ["ADBE Transform Group", "ADBE Opacity"], keys: eased() }] }, true);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.error).toMatch(/no layer with id 9999/);
  });

  it("renders a frame at the requested resolution and restores the viewer's", () => {
    comp.resolutionFactor = [4, 4];
    const file = path.join(root, "frame.png");
    const r = call<{ width: number; factor: number }>("save_frame", { compId: comp.id, time: 0.25, path: file, factor: 2 });
    expect(r.result).toMatchObject({ width: 960, factor: 2 });
    expect(ae.project.frames[0]).toEqual({ compId: comp.id, time: 0.25, factor: [2, 2] });
    expect(comp.resolutionFactor).toEqual([4, 4]);
  });

  it("round-trips text that ES3 would otherwise choke on", () => {
    logo.name = `Logo ${String.fromCharCode(0x2028)} “quoted” \\ ünïcode`;
    const r = call<CompReading>("read_comp", { compId: comp.id });
    expect(r.result.layers[0]!.name).toBe(logo.name);
  });
});
