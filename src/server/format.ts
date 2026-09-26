import type { Brief } from "../director/brief.js";
import { currentRevision, isApproved } from "../director/brief.js";
import type { ChangeRecord } from "../director/changes.js";
import type { MotionStyle, StyleDeviation } from "../director/style.js";
import type { Interpretation } from "../critic/lexicon.js";
import type { Critique } from "../critic/critic.js";
import type { MotionScore } from "../lens/types.js";
import type { Analysis, TryVariantsResult } from "./studio.js";

/**
 * Tool output, in the order a designer needs it: what it means first, the
 * numbers behind it second, identifiers for the agent last.
 */
const ms = (s: number) => `${Math.round(s * 1000)} ms`;
const secs = (s: number) => `${s.toFixed(2)} s`;

export function formatScore(score: MotionScore): string {
  if (score.movements.length === 0) return `Nothing moves in "${score.compName}" between ${secs(score.range.start)} and ${secs(score.range.end)}.`;
  const start = Math.min(...score.movements.map((m) => m.startTime));
  const end = Math.max(...score.movements.map((m) => m.endTime));
  const layers = new Set(score.movements.map((m) => m.layerId)).size;
  const c = score.choreography;
  const lines = [
    `"${score.compName}": ${score.movements.length} movements on ${layers} layers, from ${secs(start)} to ${secs(end)}.`,
    c.simultaneousStartRatio >= 0.5 && score.events.length >= 3
      ? `${Math.round(c.simultaneousStartRatio * score.events.length)} of ${score.events.length} elements start together.`
      : c.staggerIntervals.length
        ? `Elements start in sequence, ${c.staggerIntervals.slice(0, 5).map(ms).join(", ")} apart.`
        : "",
    "",
    "Movements (layer › property: ease, duration, start):",
    ...score.movements.slice(0, 40).map(
      (m) =>
        `- ${m.layerName} › ${m.propertyName}: ${m.shape.replace(/-/g, " ")}, ${ms(m.duration)}, at ${secs(m.startTime)}${m.overshoot > 0 ? `, overshoots ${Math.round(m.overshoot * 100)}%` : ""}${m.expressionDriven ? " (expression)" : ""}`,
    ),
    score.movements.length > 40 ? `- …and ${score.movements.length - 40} more.` : "",
    ...score.notes.map((n) => `Note: ${n}`),
    score.truncated ? `Note: ${score.truncated.reason} Measured until ${secs(score.truncated.sampledUntil)}.` : "",
  ];
  return lines.filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== "")).join("\n").trim();
}

export function formatCritique(result: Critique): string {
  if (result.findings.length === 0) {
    return "The Critic found none of the usual measurable tells. That doesn't mean it feels right; it means the reason isn't one it can measure.";
  }
  return [
    "Measured reasons it may read as careless:",
    ...result.findings.map((f) => `- [${f.severity}] ${f.title}. ${f.explanation}`),
    ...(result.skipped.length ? ["", `Could not judge: ${result.skipped.map((s) => `${s.detector} (${s.reason})`).join("; ")}.`] : []),
  ].join("\n");
}

export function formatAnalysis(analysis: Analysis): string {
  return [formatScore(analysis.score), "", formatCritique(analysis.critique), "", `(comp id ${analysis.reading.compId}, measured ${analysis.readAt}, fingerprint ${analysis.score.fingerprint})`].join("\n");
}

export function formatInterpretation(meaning: Interpretation): string {
  const lines = [meaning.summary];
  if (meaning.explanations.length) {
    lines.push("", "Relevant findings:", ...meaning.explanations.map((f) => `- ${f.title} (${f.axis})`));
  }
  lines.push(
    "",
    meaning.question
      ? `Ask the designer: ${meaning.question}`
      : meaning.explanations.length
        ? "The direction is clear enough to propose a brief without asking."
        : "Ask the designer what they see, or where it happens.",
  );
  return lines.join("\n");
}

export function formatBrief(brief: Brief, markdown: string): string {
  const rev = currentRevision(brief);
  return [
    markdown.trim(),
    "",
    isApproved(brief)
      ? "This revision is approved."
      : `To approve after the designer agrees: approve_brief with briefId ${brief.id}, revision ${rev.revision}, hash ${rev.hash}.`,
  ].join("\n");
}

export function formatVariants(result: TryVariantsResult): string {
  const lines = [
    `${result.completion.label}. ${result.completion.detail}`,
    "",
    `Review page (open it and watch the previews): ${result.reviewPath}`,
    "",
  ];
  for (const v of result.variants) {
    const after = v.critiqueAfter?.findings.map((f) => f.title) ?? [];
    lines.push(
      `Variant ${v.change.variant.id} · ${v.change.variant.label}: ${v.change.variant.intent}`,
      ...v.plan.summary.map((s) => `  - ${s}`),
      ...v.plan.skipped.map((s) => `  - Left alone: ${s.target} (${s.reason})`),
      `  ${v.rehearsal ? "Measured on a rehearsal copy" : "Predicted only (rehearsal did not complete)"}: ${after.length ? `still ${after.join("; ")}` : "none of the targeted tells remain"}.`,
      ...v.problems.map((p) => `  - Problem: ${p}`),
      `  changeId ${v.change.id} (${v.change.status})`,
      "",
    );
  }
  if (result.needsDesigner.length) lines.push(`Needs a creative decision (no recipe for it): ${result.needsDesigner.join("; ")}.`, "");
  lines.push("The original comp is unchanged. Nothing is applied until the designer picks a variant.");
  return lines.join("\n");
}

export function formatHistory(history: { briefs: Brief[]; changes: ChangeRecord[] }): string {
  if (history.briefs.length === 0) return "No briefs yet for this project.";
  const lines: string[] = [];
  for (const brief of history.briefs) {
    const rev = currentRevision(brief);
    lines.push(`Brief ${brief.id} for "${brief.compName}", revision ${rev.revision}${isApproved(brief) ? " (approved)" : ""}: "${brief.feedback[brief.feedback.length - 1]?.text ?? ""}"`);
    for (const change of history.changes.filter((c) => c.brief.id === brief.id)) {
      const last = change.log[change.log.length - 1];
      lines.push(`  - ${change.variant.label} (variant ${change.variant.id}, rev ${change.brief.revision}): ${change.status}, ${last?.at ?? ""}. ${last?.note ?? ""} [changeId ${change.id}]`);
    }
  }
  return lines.join("\n");
}

export function formatStyle(style: MotionStyle): string {
  const range = (r: { min: number; max: number } | null | undefined) => (r ? `${ms(r.min)}–${ms(r.max)}` : "not seen");
  return [
    `Motion style "${style.name}", learned from ${style.learnedFrom.map((c) => `"${c.compName}"`).join(", ")}:`,
    `- Easing: mostly ${style.easing.dominant?.replace(/-/g, " ") ?? "unknown"} (${Object.entries(style.easing.shares).map(([k, v]) => `${k} ${Math.round((v as number) * 100)}%`).join(", ")})`,
    `- Entrances ${range(style.durations.entrance)}, actions ${range(style.durations.action)}, exits ${range(style.durations.exit)}`,
    `- Stagger ${style.stagger ? range(style.stagger) : "none"}`,
    `- Overshoot on ${Math.round(style.overshoot.share * 100)}% of moves, up to ${Math.round(style.overshoot.max * 100)}%`,
    ...style.notes.map((n) => `Note: ${n}`),
  ].join("\n");
}

export function formatDeviations(style: MotionStyle, deviations: StyleDeviation[]): string {
  return deviations.length
    ? [`Where this comp departs from "${style.name}":`, ...deviations.map((d) => `- ${d.message}`)].join("\n")
    : `Nothing in this comp departs from "${style.name}" in what can be measured.`;
}
