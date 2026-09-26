import type { Critique } from "../critic/critic.js";
import type { Finding } from "../critic/detectors.js";
import type { Brief } from "../director/brief.js";
import { currentRevision, isApproved } from "../director/brief.js";
import type { LayerEvent, MotionScore, Movement } from "../lens/types.js";

/**
 * Everything the review page shows, as plain data. The page renders from this
 * alone, so what the designer sees is exactly what was measured, predicted or
 * checked; nothing is computed in the page that the server did not say.
 */
export type CompletionState = "ready" | "incomplete" | "failed";

export interface ReviewCheck {
  label: string;
  state: "done" | "incomplete" | "failed" | "not-checked";
  detail: string;
  /** A required check that did not finish makes the whole review incomplete. */
  required: boolean;
}

export type ReviewMovement = Pick<
  Movement,
  "id" | "layerId" | "layerName" | "propertyName" | "kind" | "startTime" | "endTime" | "duration" | "shape" | "overshoot" | "speedProfile"
>;

export interface ReviewScore {
  frameRate: number;
  range: { start: number; end: number };
  fingerprint: string;
  movements: ReviewMovement[];
  events: Pick<LayerEvent, "id" | "layerId" | "layerName" | "startTime" | "endTime" | "movementIds">[];
  notes: string[];
  truncated?: string;
}

export interface ReviewFinding {
  detector: string;
  severity: Finding["severity"];
  title: string;
  explanation: string;
  movementIds: string[];
  /** Start times the finding is about, for choreography findings. */
  times: number[];
}

export interface ReviewComparison {
  id: string;
  label: string;
  /** measured: read from After Effects. rehearsed: measured on a rehearsal copy. predicted: computed from keys, not yet measured. */
  kind: "measured" | "rehearsed" | "predicted";
  note?: string;
  summary: string[];
  score: ReviewScore;
  findings: ReviewFinding[];
  preview?: { frames: string[]; fps: number; start: number };
}

export interface ReviewData {
  title: string;
  compName: string;
  generatedAt: string;
  completion: { state: CompletionState; label: string; detail: string };
  brief?: {
    revision: number;
    approval: string;
    feedback: { text: string; revision: number }[];
    interpretation: string;
    experience: string;
    keep: string[];
    acceptance: string[];
  };
  comparisons: ReviewComparison[];
  checks: ReviewCheck[];
  /** What only the designer can judge. */
  needsDesigner: string[];
}

export function toReviewScore(score: MotionScore): ReviewScore {
  return {
    frameRate: score.frameRate,
    range: score.range,
    fingerprint: score.fingerprint,
    movements: score.movements.map((m) => ({
      id: m.id,
      layerId: m.layerId,
      layerName: m.layerName,
      propertyName: m.propertyName,
      kind: m.kind,
      startTime: m.startTime,
      endTime: m.endTime,
      duration: m.duration,
      shape: m.shape,
      overshoot: m.overshoot,
      speedProfile: m.speedProfile,
    })),
    events: score.events.map((e) => ({
      id: e.id,
      layerId: e.layerId,
      layerName: e.layerName,
      startTime: e.startTime,
      endTime: e.endTime,
      movementIds: e.movementIds,
    })),
    notes: score.notes,
    ...(score.truncated ? { truncated: `${score.truncated.reason} Measured until ${score.truncated.sampledUntil.toFixed(2)} s.` } : {}),
  };
}

export function toReviewFindings(result: Critique, score: MotionScore): ReviewFinding[] {
  return result.findings.map((f) => {
    const movementIds = new Set<string>();
    for (const e of f.evidence) {
      if (e.movementId) movementIds.add(e.movementId);
      if (e.eventId) score.events.find((ev) => ev.id === e.eventId)?.movementIds.forEach((id) => movementIds.add(id));
    }
    return {
      detector: f.detector,
      severity: f.severity,
      title: f.title,
      explanation: f.explanation,
      movementIds: [...movementIds],
      times: f.axis === "choreography" ? [...new Set(f.evidence.map((e) => e.start).filter((t): t is number => t !== undefined))] : [],
    };
  });
}

export function toReviewBrief(brief: Brief): ReviewData["brief"] {
  const rev = currentRevision(brief);
  const approval = isApproved(brief)
    ? brief.approval?.by === "designer"
      ? `Approved by you (revision ${rev.revision})`
      : `Approval recorded by the agent for you (revision ${rev.revision})`
    : brief.approval
      ? `Not approved: you approved revision ${brief.approval.revision}; this is revision ${rev.revision}`
      : "Not approved yet";
  return {
    revision: rev.revision,
    approval,
    feedback: brief.feedback.map((f) => ({ text: f.text, revision: f.revision })),
    interpretation: rev.interpretation,
    experience: rev.experience,
    keep: rev.keep,
    acceptance: rev.acceptance,
  };
}

/**
 * The review's overall state follows its checks: any failure fails it; a
 * required check that did not finish (timed out, unavailable, skipped) makes it
 * incomplete. Nothing is "verified" merely because nothing failed.
 */
export function completionFor(checks: ReviewCheck[]): ReviewData["completion"] {
  const failed = checks.filter((c) => c.state === "failed");
  if (failed.length > 0) {
    return { state: "failed", label: "Checks failed", detail: failed.map((c) => c.label).join(", ") };
  }
  const unfinished = checks.filter((c) => c.required && c.state !== "done");
  if (unfinished.length > 0) {
    return { state: "incomplete", label: "Checks incomplete", detail: `Not finished: ${unfinished.map((c) => c.label).join(", ")}` };
  }
  return { state: "ready", label: "Ready for design review", detail: "The checks that could run have run. How it feels is yours to judge." };
}
