import { createHash, randomUUID } from "node:crypto";

/**
 * The motion brief: what the designer said, what we agreed it means, and how
 * we will know it worked. The designer's words are kept verbatim and are never
 * edited; the interpretation is revised in numbered revisions, each carrying
 * forward everything not explicitly changed.
 */
export interface BriefContent {
  /** What we agreed the feedback means. */
  interpretation: string;
  /** The experience we want the viewer to have. */
  experience: string;
  /** What must not change. */
  keep: string[];
  /** Observable criteria, checkable against a Motion Score or by eye. */
  acceptance: string[];
  references: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface BriefRevision extends BriefContent {
  revision: number;
  createdAt: string;
  /** What changed in this revision, e.g. "hover softened; selection kept from rev 1". */
  note: string;
  hash: string;
}

/**
 * Who approved. An MCP tool call cannot prove a human pressed a button, so an
 * approval is either confirmed by the designer through the client (MCP
 * elicitation) or recorded by the agent on the designer's behalf, and the
 * review says which.
 */
export type Approver = "designer" | "agent-on-behalf-of-designer";

export interface Brief {
  id: string;
  compId: number;
  compName: string;
  createdAt: string;
  /** Every piece of feedback, verbatim, with the revision it led to. */
  feedback: { text: string; at: string; revision: number }[];
  revisions: BriefRevision[];
  approval: { revision: number; hash: string; at: string; by: Approver } | null;
}

const EMPTY: BriefContent = {
  interpretation: "",
  experience: "",
  keep: [],
  acceptance: [],
  references: [],
  decisions: [],
  openQuestions: [],
};

export function createBrief(input: {
  compId: number;
  compName: string;
  feedback: string;
  content: Partial<BriefContent>;
  now?: Date;
}): Brief {
  const at = (input.now ?? new Date()).toISOString();
  const content = { ...EMPTY, ...clean(input.content) };
  return {
    id: randomUUID(),
    compId: input.compId,
    compName: input.compName,
    createdAt: at,
    feedback: input.feedback.trim() ? [{ text: input.feedback, at, revision: 1 }] : [],
    revisions: [{ ...content, revision: 1, createdAt: at, note: "First revision.", hash: hashContent(content) }],
    approval: null,
  };
}

/** A new revision that carries forward every field not given in `changes`. */
export function reviseBrief(
  brief: Brief,
  input: { feedback?: string; changes: Partial<BriefContent>; note: string; now?: Date },
): Brief {
  const at = (input.now ?? new Date()).toISOString();
  const previous = currentRevision(brief);
  const content: BriefContent = { ...pickContent(previous), ...clean(input.changes) };
  const revision = previous.revision + 1;
  return {
    ...brief,
    feedback: input.feedback?.trim()
      ? [...brief.feedback, { text: input.feedback, at, revision }]
      : brief.feedback,
    revisions: [...brief.revisions, { ...content, revision, createdAt: at, note: input.note, hash: hashContent(content) }],
    // Approval belongs to one exact revision; a new revision needs its own.
    approval: brief.approval,
  };
}

export function currentRevision(brief: Brief): BriefRevision {
  const last = brief.revisions[brief.revisions.length - 1];
  if (!last) throw new Error("A brief always has at least one revision.");
  return last;
}

export class ApprovalError extends Error {}

export function approveBrief(brief: Brief, revision: number, hash: string, by: Approver, now = new Date()): Brief {
  const current = currentRevision(brief);
  if (revision !== current.revision) {
    throw new ApprovalError(`Revision ${revision} is not the current one (the brief is at revision ${current.revision}). Review the latest revision first.`);
  }
  if (hash !== current.hash) {
    throw new ApprovalError(`Revision ${revision} has changed since it was shown. Review it again before approving.`);
  }
  return { ...brief, approval: { revision, hash, at: now.toISOString(), by } };
}

/** Approved means: the current revision, exactly as it is now, was approved. */
export function isApproved(brief: Brief): boolean {
  const current = currentRevision(brief);
  return Boolean(brief.approval && brief.approval.revision === current.revision && brief.approval.hash === current.hash);
}

export function hashContent(content: BriefContent): string {
  const canonical = JSON.stringify([
    content.interpretation,
    content.experience,
    content.keep,
    content.acceptance,
    content.references,
    content.decisions,
    content.openQuestions,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A readable rendering for the designer; the designer's words are quoted exactly. */
export function briefToMarkdown(brief: Brief): string {
  const rev = currentRevision(brief);
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  const approval = isApproved(brief)
    ? `Approved (revision ${rev.revision}${brief.approval?.by === "designer" ? ", by the designer" : ", recorded by the agent on the designer's behalf"})`
    : brief.approval
      ? `Not approved: revision ${brief.approval.revision} was approved, the brief is now at revision ${rev.revision}`
      : "Not approved yet";
  return [
    `# Motion brief — ${brief.compName}`,
    `Revision ${rev.revision} · ${approval}`,
    "",
    "## In the designer's words",
    ...(brief.feedback.length ? brief.feedback.map((f) => `> ${f.text.replace(/\n/g, "\n> ")}  \n> — revision ${f.revision}`) : ["(none yet)"]),
    "",
    "## What we agreed it means",
    rev.interpretation || "(not yet agreed)",
    "",
    "## The experience we want",
    rev.experience || "(not yet described)",
    "",
    "## Must not change",
    list(rev.keep),
    "",
    "## How we'll know it worked",
    list(rev.acceptance),
    "",
    "## Decisions",
    list(rev.decisions),
    "",
    "## References",
    list(rev.references),
    "",
    "## Open questions and assumptions",
    list(rev.openQuestions),
    "",
    "## Revisions",
    ...brief.revisions.map((r) => `- ${r.revision}: ${r.note}`),
    "",
  ].join("\n");
}

function pickContent(r: BriefContent): BriefContent {
  return {
    interpretation: r.interpretation,
    experience: r.experience,
    keep: [...r.keep],
    acceptance: [...r.acceptance],
    references: [...r.references],
    decisions: [...r.decisions],
    openQuestions: [...r.openQuestions],
  };
}

function clean(content: Partial<BriefContent>): Partial<BriefContent> {
  const out: Partial<BriefContent> = {};
  for (const [k, v] of Object.entries(content) as [keyof BriefContent, unknown][]) {
    if (v === undefined) continue;
    if (Array.isArray(v)) (out as Record<string, unknown>)[k] = v.map((s) => String(s).trim()).filter(Boolean);
    else (out as Record<string, unknown>)[k] = String(v).trim();
  }
  return out;
}
