import path from "node:path";
import type { AfterEffects, CompSummary, ProjectInfo } from "../ae/client.js";
import { planPreview } from "../ae/preview.js";
import type { AeOutcome } from "../ae/protocol.js";
import { critique, type Critique } from "../critic/critic.js";
import type { Axis, DetectorId } from "../critic/detectors.js";
import { interpret, type Interpretation } from "../critic/lexicon.js";
import {
  approveBrief,
  briefToMarkdown,
  createBrief,
  currentRevision,
  isApproved,
  reviseBrief,
  type Approver,
  type Brief,
  type BriefContent,
} from "../director/brief.js";
import { createChange, findDrift, transition, type ChangeRecord } from "../director/changes.js";
import { predictScore } from "../director/predict.js";
import { planVariant, type EditPlan } from "../director/recipes.js";
import { projectKey, Store } from "../director/store.js";
import { checkStyle, learnStyle, type MotionStyle, type StyleDeviation } from "../director/style.js";
import { suggestVariants } from "../director/variants.js";
import { buildScore } from "../lens/score.js";
import type { CompReading, MotionScore } from "../lens/types.js";
import { completionFor, toReviewBrief, toReviewFindings, toReviewScore, type ReviewCheck, type ReviewComparison, type ReviewData } from "../review/data.js";
import { writeReviewPage } from "../review/page.js";

/** A plain-language failure the tools report as is. */
export class StudioError extends Error {
  constructor(
    message: string,
    readonly hint = "",
  ) {
    super(message);
  }
}

export interface Analysis {
  reading: CompReading;
  score: MotionScore;
  critique: Critique;
  readAt: string;
}

export interface VariantResult {
  change: ChangeRecord;
  plan: EditPlan;
  predicted: MotionScore;
  rehearsal: MotionScore | null;
  critiqueAfter: Critique | null;
  problems: string[];
}

export interface TryVariantsResult {
  brief: Brief;
  before: Analysis;
  variants: VariantResult[];
  needsDesigner: string[];
  reviewPath: string;
  completion: ReviewData["completion"];
}

export interface StudioOptions {
  store?: Store;
  readOnly?: boolean;
  /** Render real-speed previews when rehearsing (slower, but the designer can watch them). */
  previews?: boolean;
  now?: () => Date;
}

/**
 * The whole direction loop, independent of MCP: read and critique a comp,
 * interpret feedback, keep the brief, rehearse variants on copies, review,
 * apply with verification, and restore. Tools are thin wrappers around this.
 */
export class Studio {
  private readonly store: Store;
  private readonly readOnly: boolean;
  private readonly previews: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly ae: AfterEffects,
    options: StudioOptions = {},
  ) {
    this.store = options.store ?? new Store();
    this.readOnly = options.readOnly ?? false;
    this.previews = options.previews ?? true;
    this.now = options.now ?? (() => new Date());
  }

  // ---------- setup and reading ----------

  async checkSetup(): Promise<{ info: ProjectInfo; comps: CompSummary[] }> {
    const info = unwrap(await this.ae.ping());
    const comps = unwrap(await this.ae.listComps());
    return { info, comps };
  }

  /** A comp by id, by name, or the active one. */
  async resolveComp(comp?: number | string): Promise<{ id: number; name: string }> {
    if (typeof comp === "number") return { id: comp, name: String(comp) };
    if (typeof comp === "string" && comp.trim()) {
      const comps = unwrap(await this.ae.listComps());
      const wanted = comp.trim().toLowerCase();
      const exact = comps.filter((c) => c.name.toLowerCase() === wanted);
      const match = exact.length ? exact : comps.filter((c) => c.name.toLowerCase().includes(wanted));
      if (match.length === 1) return { id: (match[0] as CompSummary).id, name: (match[0] as CompSummary).name };
      if (match.length === 0) throw new StudioError(`There is no comp called "${comp}".`, `Comps in this project: ${comps.map((c) => c.name).join(", ") || "none"}.`);
      throw new StudioError(`More than one comp matches "${comp}": ${match.map((c) => c.name).join(", ")}.`, "Use the exact name.");
    }
    const { activeComp } = unwrap(await this.ae.ping());
    if (!activeComp) throw new StudioError("No comp is open in After Effects.", "Open the comp you want to work on, or name it.");
    return activeComp;
  }

  async analyse(comp?: number | string, range: { start?: number; end?: number } = {}): Promise<Analysis> {
    const { id } = await this.resolveComp(comp);
    const reading = unwrap(await this.ae.readComp(id, range));
    const score = buildScore(reading);
    const analysis: Analysis = { reading, score, critique: critique(score, reading), readAt: this.now().toISOString() };
    return analysis;
  }

  interpret(feedback: string, analysis: Analysis): Interpretation {
    return interpret(feedback, analysis.critique);
  }

  // ---------- briefs ----------

  async createBrief(input: { comp?: number | string; feedback: string; content: Partial<BriefContent> }): Promise<Brief> {
    const { id, name } = await this.resolveComp(input.comp);
    const brief = createBrief({ compId: id, compName: name, feedback: input.feedback, content: input.content, now: this.now() });
    await this.saveBrief(brief);
    return brief;
  }

  async reviseBrief(briefId: string, input: { feedback?: string; changes: Partial<BriefContent>; note: string }): Promise<Brief> {
    const brief = await this.brief(briefId);
    const revised = reviseBrief(brief, { ...input, now: this.now() });
    await this.saveBrief(revised);
    return revised;
  }

  async approveBrief(briefId: string, revision: number, hash: string, by: Approver): Promise<Brief> {
    const approved = approveBrief(await this.brief(briefId), revision, hash, by, this.now());
    await this.saveBrief(approved);
    return approved;
  }

  async brief(briefId: string): Promise<Brief> {
    const brief = this.store.read<Brief>(await this.project(), "briefs", briefId);
    if (!brief) throw new StudioError(`There is no brief ${briefId} for this project.`, "Use history to see the briefs that exist.");
    return brief;
  }

  briefMarkdown(brief: Brief): string {
    return briefToMarkdown(brief);
  }

  // ---------- variants ----------

  /**
   * Plan up to three variants for an approved brief, predict each, rehearse
   * each on a copy of the comp, and write a review page. The original comp is
   * not touched.
   */
  async tryVariants(briefId: string, options: { axes?: Axis[]; findings?: DetectorId[] } = {}): Promise<TryVariantsResult> {
    this.assertWritable();
    const brief = await this.brief(briefId);
    if (!isApproved(brief)) {
      throw new StudioError(
        `Revision ${currentRevision(brief).revision} of this brief is not approved yet.`,
        "Show the designer the brief and approve it before trying changes.",
      );
    }
    const before = await this.analyse(brief.compId);
    const { variants, needsDesigner } = suggestVariants(before.critique, before.score, options);
    if (variants.length === 0) {
      throw new StudioError(
        "None of the measured findings can be changed by a recipe.",
        needsDesigner.length
          ? `These need a creative decision: ${needsDesigner.map((f) => f.title).join("; ")}.`
          : "The Critic found nothing to fix; ask the designer what they see.",
      );
    }

    const rev = currentRevision(brief);
    const project = await this.project();
    const results: VariantResult[] = [];
    for (const variant of variants) {
      const plan = planVariant(before.reading, before.score, `Variant ${variant.id} · ${variant.label}`, variant.steps);
      const predicted = predictScore(before.reading, plan);
      let change = createChange({
        compId: brief.compId,
        compName: brief.compName,
        brief: { id: brief.id, revision: rev.revision, hash: rev.hash },
        variant: { id: variant.id, label: variant.label, intent: variant.intent },
        plan,
        beforeFingerprint: before.score.fingerprint,
        predictedFingerprint: predicted.score.fingerprint,
        now: this.now(),
      });
      this.store.write(project, "changes", change.id, change);
      const outcome = await this.rehearse(change, plan);
      change = outcome.change;
      this.store.write(project, "changes", change.id, change);
      results.push({
        change,
        plan,
        predicted: predicted.score,
        rehearsal: outcome.analysis?.score ?? null,
        critiqueAfter: outcome.analysis?.critique ?? critique(predicted.score, predicted.reading),
        problems: outcome.problems,
      });
    }

    const review = await this.writeReview(brief, before, results, needsDesigner.map((f) => `${f.title}: ${f.explanation}`));
    return { brief, before, variants: results, needsDesigner: needsDesigner.map((f) => f.title), ...review };
  }

  private async rehearse(change: ChangeRecord, plan: EditPlan): Promise<{ change: ChangeRecord; analysis: Analysis | null; problems: string[] }> {
    let current = transition(change, "rehearsing", "Rehearsing on a copy of the comp.", this.now());
    const copy = await this.ae.duplicateComp(change.compId, `Variant ${change.variant.id}`);
    if (copy.status !== "ok") return this.rehearsalFailed(current, copy, "Could not make a rehearsal copy");
    const layerMap = new Map(copy.value.layerMap);
    const edits = plan.edits.map((e) => ({ layerId: layerMap.get(e.layerId) ?? -1, path: e.path, keys: e.after, expect: e.before }));
    if (edits.some((e) => e.layerId < 0)) {
      return this.rehearsalFailed(current, null, "The rehearsal copy's layers did not match the original");
    }
    const applied = await this.ae.setKeys(copy.value.compId, edits, `Rehearse variant ${change.variant.id}`);
    if (applied.status !== "ok") return this.rehearsalFailed(current, applied, "Could not rehearse the change");
    const read = await this.ae.readComp(copy.value.compId, {});
    if (read.status !== "ok") return this.rehearsalFailed(current, read, "Could not measure the rehearsal");

    // Read with the original's layer ids so the rehearsal lines up with it.
    const reverse = new Map([...layerMap].map(([from, to]) => [to, from]));
    const reading: CompReading = { ...read.value, layers: read.value.layers.map((l) => ({ ...l, id: reverse.get(l.id) ?? l.id })) };
    const score = buildScore(reading);
    const analysis: Analysis = { reading, score, critique: critique(score, reading), readAt: this.now().toISOString() };
    const problems = findDrift(plan.edits, reading, "after").map((d) => `${d.layerName} › ${d.propertyName}: After Effects holds different keys than planned`);
    current = { ...current, rehearsal: { compId: copy.value.compId, compName: copy.value.name }, fingerprints: { ...current.fingerprints, rehearsal: score.fingerprint } };
    current = problems.length
      ? transition(current, "failed", `The rehearsal did not match the plan: ${problems.join("; ")}`, this.now())
      : transition(current, "rehearsed", "Rehearsed on a copy and measured.", this.now());
    return { change: current, analysis, problems };
  }

  private rehearsalFailed(change: ChangeRecord, outcome: AeOutcome | null, what: string): { change: ChangeRecord; analysis: null; problems: string[] } {
    const detail = outcome && outcome.status !== "ok" ? `${outcome.message} ${outcome.hint}`.trim() : "";
    const note = `${what}${detail ? `: ${detail}` : "."}`;
    const status = outcome?.status === "unknown" ? "outcome-unknown" : "failed";
    return { change: transition(change, status, note, this.now()), analysis: null, problems: [note] };
  }

  private async writeReview(brief: Brief, before: Analysis, results: VariantResult[], needsDesigner: string[]): Promise<{ reviewPath: string; completion: ReviewData["completion"] }> {
    const project = await this.project();
    const rev = currentRevision(brief);
    const folder = path.join(this.store.root, "projects", project, "reviews", `${brief.id}-rev${rev.revision}`);
    const comparisons: ReviewComparison[] = [];
    const checks: ReviewCheck[] = [];

    const nowPreview = await this.preview(before.reading.compId, before.score, folder, "now", checks);
    comparisons.push({
      id: "now",
      label: "Now",
      kind: "measured",
      summary: [],
      score: toReviewScore(before.score),
      findings: toReviewFindings(before.critique, before.score),
      ...(nowPreview ? { preview: nowPreview } : {}),
    });

    for (const r of results) {
      const measured = r.rehearsal !== null;
      checks.push({
        label: `Rehearse variant ${r.change.variant.id} on a copy and measure it`,
        state: r.change.status === "rehearsed" ? "done" : r.change.status === "outcome-unknown" ? "incomplete" : "failed",
        detail: r.change.status === "rehearsed" ? "The copy holds exactly the planned keys." : r.problems.join(" "),
        required: true,
      });
      const score = r.rehearsal ?? r.predicted;
      const preview =
        measured && r.change.rehearsal ? await this.preview(r.change.rehearsal.compId, score, folder, `variant-${r.change.variant.id}`, checks) : null;
      comparisons.push({
        id: r.change.id,
        label: `Variant ${r.change.variant.id} · ${r.change.variant.label}`,
        kind: measured ? "rehearsed" : "predicted",
        note: r.change.variant.intent,
        summary: [...r.plan.summary, ...r.plan.skipped.map((s) => `Left alone: ${s.target} (${s.reason}).`)],
        score: toReviewScore(score),
        findings: r.critiqueAfter ? toReviewFindings(r.critiqueAfter, score) : [],
        ...(preview ? { preview } : {}),
      });
    }
    checks.push({
      label: "Judge how it feels",
      state: "not-checked",
      detail: "Measurements explain what changed; whether it feels right is the designer's call.",
      required: false,
    });

    const completion = completionFor(checks);
    const data: ReviewData = {
      title: `${brief.compName}: variants for revision ${rev.revision}`,
      compName: brief.compName,
      generatedAt: this.now().toISOString(),
      completion,
      brief: toReviewBrief(brief),
      comparisons,
      checks,
      needsDesigner: ["Which variant, if any, matches what you meant.", ...needsDesigner],
    };
    return { reviewPath: writeReviewPage(folder, data), completion };
  }

  private async preview(compId: number, score: MotionScore, folder: string, name: string, checks: ReviewCheck[]): Promise<ReviewComparison["preview"] | null> {
    if (!this.previews) return null;
    const start = score.movements.length ? Math.min(...score.movements.map((m) => m.startTime)) : score.range.start;
    const end = score.movements.length ? Math.max(...score.movements.map((m) => m.endTime)) : score.range.end;
    const plan = planPreview(score.frameRate, Math.max(score.range.start, start - 0.1), Math.min(score.range.end, end + 0.2), 90);
    const factor = Math.max(1, Math.ceil(Math.max(score.width, score.height) / 640));
    const { frames, problems } = await this.ae.frames(compId, plan.times, path.join(folder, `frames-${name}`), factor);
    const complete = frames.length === plan.times.length;
    checks.push({
      label: `Render a real-speed preview (${name === "now" ? "now" : name.replace("variant-", "variant ")})`,
      state: complete ? "done" : frames.length ? "incomplete" : "failed",
      detail: complete ? `${frames.length} frames at ${plan.playbackFps} fps.` : `${frames.length} of ${plan.times.length} frames rendered. ${problems.slice(0, 2).join(" ")}`,
      required: false,
    });
    if (!complete) return null;
    return { frames: frames.map((f) => path.relative(folder, f.file).split(path.sep).join("/")), fps: plan.playbackFps, start: plan.times[0] ?? 0 };
  }

  // ---------- applying and restoring ----------

  async apply(changeId: string): Promise<{ change: ChangeRecord; message: string }> {
    this.assertWritable();
    const project = await this.project();
    let change = await this.change(changeId);
    const brief = await this.brief(change.brief.id);
    const rev = currentRevision(brief);
    if (!isApproved(brief) || rev.revision !== change.brief.revision || rev.hash !== change.brief.hash) {
      throw new StudioError(
        `This change was made for revision ${change.brief.revision} of the brief, and the approved direction is now different.`,
        "Try variants again for the current revision; an approval never carries over to a revised brief.",
      );
    }
    if (change.status !== "rehearsed") {
      throw new StudioError(`This change is ${change.status}, so it can't be applied.`, "Only a change that was rehearsed and measured can be applied.");
    }

    const current = await this.analyse(change.compId);
    const drift = findDrift(change.plan.edits, current.reading, "before");
    if (drift.length) {
      throw new StudioError(
        `Nothing was applied: ${drift.map((d) => `${d.layerName} › ${d.propertyName} (${d.reason})`).join("; ")}.`,
        "Someone changed these since the variants were made. Try variants again so nothing is overwritten.",
      );
    }

    change = transition(change, "applying", "Applying to the original comp.", this.now());
    this.store.write(project, "changes", change.id, change);
    const edits = change.plan.edits.map((e) => ({ layerId: e.layerId, path: e.path, keys: e.after, expect: e.before }));
    const outcome = await this.ae.setKeys(change.compId, edits, `${change.variant.label} (variant ${change.variant.id})`);
    change = await this.settle(change, outcome, "after", "applied", "Applied as one undo step and verified by reading the comp back.");
    this.store.write(project, "changes", change.id, change);
    return { change, message: messageFor(change) };
  }

  async restore(changeId: string): Promise<{ change: ChangeRecord; message: string }> {
    this.assertWritable();
    const project = await this.project();
    let change = await this.change(changeId);
    if (change.status !== "applied") {
      throw new StudioError(`This change is ${change.status}, so there is nothing to restore.`);
    }
    const current = await this.analyse(change.compId);
    const drift = findDrift(change.plan.edits, current.reading, "after");
    if (drift.length) {
      throw new StudioError(
        `Nothing was restored: ${drift.map((d) => `${d.layerName} › ${d.propertyName}`).join(", ")} changed after this change was applied.`,
        "Restoring would overwrite that work. Undo it in After Effects first, or decide together what to keep.",
      );
    }
    const edits = change.plan.edits.map((e) => ({ layerId: e.layerId, path: e.path, keys: e.before, expect: e.after }));
    const outcome = await this.ae.setKeys(change.compId, edits, `Restore before ${change.variant.label}`);
    if (outcome.status === "failed") throw new StudioError(`Nothing was restored: ${outcome.message}`, outcome.hint);
    const read = await this.analyse(change.compId);
    const remaining = findDrift(change.plan.edits, read.reading, "before");
    if (remaining.length) {
      throw new StudioError(
        `The restore could not be confirmed: ${remaining.map((d) => `${d.layerName} › ${d.propertyName}`).join(", ")} ${outcome.status === "unknown" ? "may not have been" : "were not"} put back.`,
        "Check these in After Effects; ⌘Z undoes the last Motion Director step.",
      );
    }
    change = transition(change, "restored", "Restored exactly as it was before the change, verified by reading the comp back.", this.now());
    this.store.write(project, "changes", change.id, change);
    return { change, message: "Restored. Every property the change touched is back to exactly what it was, checked by reading the comp again." };
  }

  /**
   * After a change is sent, find out what actually happened by reading the
   * comp: an unknown outcome is resolved by looking, never by retrying.
   */
  private async settle(change: ChangeRecord, outcome: AeOutcome, expect: "after", done: "applied", note: string): Promise<ChangeRecord> {
    if (outcome.status === "failed") return transition(change, "failed", `${outcome.message} ${outcome.hint}`.trim(), this.now());
    const read = await this.ae.readComp(change.compId, {});
    if (read.status !== "ok") {
      return transition(change, "outcome-unknown", `Sent, but the comp could not be read back to confirm: ${read.message}`, this.now());
    }
    const score = buildScore(read.value);
    const missing = findDrift(change.plan.edits, read.value, expect);
    if (missing.length === 0) {
      const applied = transition(change, done, note, this.now());
      return { ...applied, fingerprints: { ...applied.fingerprints, applied: score.fingerprint } };
    }
    if (findDrift(change.plan.edits, read.value, "before").length === 0) {
      return transition(change, outcome.status === "unknown" ? "outcome-unknown" : "failed", "The comp is unchanged: the change did not apply.", this.now());
    }
    return transition(change, "outcome-unknown", `The comp matches neither the plan nor the original: ${missing.map((d) => `${d.layerName} › ${d.propertyName}`).join(", ")}.`, this.now());
  }

  async discardRehearsals(briefId: string): Promise<string[]> {
    this.assertWritable();
    const project = await this.project();
    const removed: string[] = [];
    for (const change of this.store.list<ChangeRecord>(project, "changes")) {
      if (change.brief.id !== briefId || !change.rehearsal) continue;
      const outcome = await this.ae.deleteRehearsal(change.rehearsal.compId);
      if (outcome.status === "ok") removed.push(change.rehearsal.compName);
      if (outcome.status === "ok" && (change.status === "rehearsed" || change.status === "failed")) {
        const { rehearsal: _dropped, ...rest } = change;
        this.store.write(project, "changes", change.id, transition(rest as ChangeRecord, "discarded", "Rehearsal copy removed.", this.now()));
      }
    }
    return removed;
  }

  async change(changeId: string): Promise<ChangeRecord> {
    const change = this.store.read<ChangeRecord>(await this.project(), "changes", changeId);
    if (!change) throw new StudioError(`There is no change ${changeId} for this project.`, "Use history to see the changes that exist.");
    return change;
  }

  async history(): Promise<{ briefs: Brief[]; changes: ChangeRecord[] }> {
    const project = await this.project();
    return { briefs: this.store.list<Brief>(project, "briefs"), changes: this.store.list<ChangeRecord>(project, "changes") };
  }

  // ---------- motion style ----------

  async learnStyle(name: string, comps: (number | string)[]): Promise<MotionStyle> {
    const scores: MotionScore[] = [];
    for (const comp of comps.length ? comps : [undefined]) scores.push((await this.analyse(comp)).score);
    const style = learnStyle(name, scores, this.now());
    this.store.write(await this.project(), "styles", slug(name), style);
    return style;
  }

  async checkStyle(name: string, comp?: number | string): Promise<{ style: MotionStyle; deviations: StyleDeviation[] }> {
    const style = this.store.read<MotionStyle>(await this.project(), "styles", slug(name));
    if (!style) throw new StudioError(`There is no motion style called "${name}" yet.`, "Learn one from comps the designer likes first.");
    return { style, deviations: checkStyle(style, (await this.analyse(comp)).score) };
  }

  // ---------- helpers ----------

  private async saveBrief(brief: Brief): Promise<void> {
    this.store.write(await this.project(), "briefs", brief.id, brief);
  }

  private projectKeyCache: string | null = null;

  private async project(): Promise<string> {
    if (this.projectKeyCache) return this.projectKeyCache;
    const info = unwrap(await this.ae.ping());
    this.projectKeyCache = projectKey(info.project.path, info.project.name);
    return this.projectKeyCache;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new StudioError("Motion Director is in read-only mode, so it will not change the project.", "Unset MOTION_DIRECTOR_READONLY to allow changes.");
  }
}

function unwrap<T>(outcome: AeOutcome<T>): T {
  if (outcome.status === "ok") return outcome.value;
  throw new StudioError(outcome.message, outcome.hint);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "style";
}

function messageFor(change: ChangeRecord): string {
  switch (change.status) {
    case "applied":
      return "Applied to the original comp as one undo step, and verified: After Effects now holds exactly the planned keys.";
    case "failed":
      return `Not applied. ${change.log[change.log.length - 1]?.note ?? ""}`.trim();
    default:
      return `The outcome is not certain yet. ${change.log[change.log.length - 1]?.note ?? ""} Don't repeat the change; read the comp to check.`.trim();
  }
}
