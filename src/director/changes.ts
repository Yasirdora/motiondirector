import { randomUUID } from "node:crypto";
import { propertyKey } from "../lens/properties.js";
import type { CompReading, Keyframe } from "../lens/types.js";
import type { EditPlan, PropertyEdit } from "./recipes.js";
import type { Variant } from "./variants.js";

/**
 * A change moves through a small, explicit set of states. "outcome-unknown"
 * exists because a call that timed out after After Effects picked it up may or
 * may not have applied; it is resolved by reading the project, never by
 * retrying (kumo's transport marks such timeouts retryable, which can apply a
 * change twice).
 */
export type ChangeStatus =
  | "planned"
  | "rehearsing"
  | "rehearsed"
  | "applying"
  | "applied"
  | "restored"
  | "failed"
  | "outcome-unknown"
  | "discarded";

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  planned: ["rehearsing", "discarded"],
  rehearsing: ["rehearsed", "failed", "outcome-unknown"],
  rehearsed: ["applying", "discarded", "rehearsing"],
  applying: ["applied", "failed", "outcome-unknown"],
  applied: ["restored"],
  restored: [],
  failed: ["rehearsing", "discarded"],
  "outcome-unknown": ["rehearsed", "applied", "failed", "planned"],
  discarded: [],
};

export interface ChangeRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  compId: number;
  compName: string;
  /** The exact brief revision this change was made for; a revised brief needs a new approval. */
  brief: { id: string; revision: number; hash: string };
  variant: Pick<Variant, "id" | "label" | "intent">;
  plan: EditPlan;
  status: ChangeStatus;
  fingerprints: { before: string; predicted?: string; rehearsal?: string; applied?: string };
  rehearsal?: { compId: number; compName: string };
  log: { at: string; status: ChangeStatus; note: string }[];
}

export function createChange(input: {
  compId: number;
  compName: string;
  brief: ChangeRecord["brief"];
  variant: ChangeRecord["variant"];
  plan: EditPlan;
  beforeFingerprint: string;
  predictedFingerprint?: string;
  now?: Date;
}): ChangeRecord {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    createdAt: at,
    updatedAt: at,
    compId: input.compId,
    compName: input.compName,
    brief: input.brief,
    variant: input.variant,
    plan: input.plan,
    status: "planned",
    fingerprints: {
      before: input.beforeFingerprint,
      ...(input.predictedFingerprint ? { predicted: input.predictedFingerprint } : {}),
    },
    log: [{ at, status: "planned", note: input.plan.summary.join(" ") || "Planned." }],
  };
}

export class TransitionError extends Error {}

export function transition(change: ChangeRecord, to: ChangeStatus, note: string, now = new Date()): ChangeRecord {
  if (!TRANSITIONS[change.status].includes(to)) {
    throw new TransitionError(`A change that is ${change.status} cannot become ${to}.`);
  }
  const at = now.toISOString();
  return { ...change, status: to, updatedAt: at, log: [...change.log, { at, status: to, note }] };
}

/** Values read back from After Effects are floats; compare with tolerance. */
export function sameKeys(a: readonly Keyframe[], b: readonly Keyframe[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Keyframe;
    const y = b[i] as Keyframe;
    if (Math.abs(x.time - y.time) > 1e-4) return false;
    if (!close(x.value, y.value, 1e-3)) return false;
    if (x.inInterpolation !== y.inInterpolation || x.outInterpolation !== y.outInterpolation) return false;
    if (!sameEase(x.inEase, y.inEase) || !sameEase(x.outEase, y.outEase)) return false;
  }
  return true;
}

function sameEase(a: Keyframe["inEase"], b: Keyframe["inEase"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i];
    return o !== undefined && Math.abs(e.influence - o.influence) <= 0.05 && Math.abs(e.speed - o.speed) <= Math.max(1e-3, Math.abs(e.speed) * 1e-3);
  });
}

function close(a: readonly number[], b: readonly number[], tolerance: number): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) <= tolerance * Math.max(1, Math.abs(v)));
}

export interface Drift {
  layerId: number;
  layerName: string;
  propertyName: string;
  reason: string;
}

/**
 * Properties whose keys in After Effects no longer match what a change
 * expects: `before` before applying (nothing edited since planning), `after`
 * before restoring (nothing edited since applying). Any drift means someone
 * else changed the work, and it is shown to the designer rather than
 * overwritten.
 */
export function findDrift(edits: readonly PropertyEdit[], current: CompReading, expect: "before" | "after"): Drift[] {
  const drift: Drift[] = [];
  for (const edit of edits) {
    const layer = current.layers.find((l) => l.id === edit.layerId);
    if (!layer) {
      drift.push({ layerId: edit.layerId, layerName: edit.layerName, propertyName: edit.propertyName, reason: "the layer no longer exists" });
      continue;
    }
    const track = layer.properties.find((t) => propertyKey(t) === edit.property);
    const keys = track?.keys ?? [];
    if (!sameKeys(expect === "before" ? edit.before : edit.after, keys)) {
      drift.push({
        layerId: edit.layerId,
        layerName: layer.name,
        propertyName: edit.propertyName,
        reason: expect === "before" ? "its keyframes changed since the plan was made" : "its keyframes changed since the change was applied",
      });
    }
  }
  return drift;
}
