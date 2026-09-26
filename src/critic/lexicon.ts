import type { Critique } from "./critic.js";
import type { Axis, DetectorId, Finding } from "./detectors.js";

/**
 * The Feel Lexicon: words designers use about motion, and the measurable
 * causes that commonly produce that feeling. It narrows the Critic's findings
 * to the ones that explain what the designer said; it never invents a cause
 * that was not measured in the comp.
 */
interface Term {
  words: string[];
  /** Causes, most typical first. */
  causes: DetectorId[];
  /** True for words describing a goal ("snappy") rather than a problem ("sluggish"). */
  goal?: boolean;
}

const TERMS: Term[] = [
  {
    words: ["cheap", "amateur", "amateurish", "generic", "template", "tacky", "powerpoint", "unpolished"],
    causes: ["linear-easing", "simultaneous-start", "fade-only-entrance", "uniform-duration", "default-wiggle", "ping-pong-bounce"],
  },
  { words: ["robotic", "mechanical", "computer", "digital", "rigid"], causes: ["linear-easing", "uniform-duration", "hard-stop"] },
  { words: ["stiff", "wooden", "dead", "lifeless", "static", "flat", "boring", "dull"], causes: ["no-follow-through", "uniform-duration", "linear-easing", "fade-only-entrance"] },
  { words: ["busy", "chaotic", "cluttered", "noisy", "messy", "overwhelming", "everything at once"], causes: ["simultaneous-start", "simultaneous-landing", "default-wiggle"] },
  { words: ["abrupt", "jarring", "harsh", "sudden", "jolting", "glitchy"], causes: ["abrupt-move", "hard-stop", "linear-easing"] },
  { words: ["heavy", "sluggish", "slow", "laggy", "draggy", "dragging"], causes: ["sluggish-tail", "uniform-duration"] },
  { words: ["floaty", "drifty", "mushy", "soft", "vague", "loose"], causes: ["sluggish-tail", "no-follow-through"] },
  { words: ["bouncy", "cartoony", "cartoonish", "toy", "toylike", "springy", "wobbly"], causes: ["heavy-overshoot", "ping-pong-bounce"] },
  { words: ["jittery", "shaky", "nervous", "twitchy"], causes: ["default-wiggle", "abrupt-move"] },
  { words: ["fake", "unnatural", "unrealistic"], causes: ["ping-pong-bounce", "linear-easing", "hard-stop"] },
  { words: ["premium", "polished", "elegant", "refined", "classy", "luxurious"], causes: ["linear-easing", "simultaneous-start", "fade-only-entrance", "heavy-overshoot", "default-wiggle"], goal: true },
  { words: ["snappy", "punchy", "crisp", "tight", "quick", "faster"], causes: ["sluggish-tail", "uniform-duration"], goal: true },
  { words: ["alive", "lively", "energetic", "dynamic", "playful"], causes: ["no-follow-through", "uniform-duration", "linear-easing", "simultaneous-start"], goal: true },
  { words: ["smooth", "fluid", "natural", "organic"], causes: ["linear-easing", "hard-stop", "abrupt-move", "ping-pong-bounce"], goal: true },
  { words: ["calm", "restrained", "subtle", "quiet", "minimal"], causes: ["heavy-overshoot", "default-wiggle", "simultaneous-start", "abrupt-move"], goal: true },
];

const AXIS_WORDS: Record<Axis, string> = {
  choreography: "the choreography (when each element moves)",
  feel: "the feel (how each movement accelerates and settles)",
  staging: "the staging (what kind of motion each element uses)",
};

export interface Interpretation {
  /** Lexicon words found in the feedback, as written. */
  matched: { word: string; goal: boolean }[];
  /** Findings that explain the feedback, most relevant first. Only measured causes appear here. */
  explanations: Finding[];
  /** Aspects the explanations touch. More than one means the direction is genuinely ambiguous. */
  axes: Axis[];
  /** One question to ask the designer, or null when the direction is clear enough to proceed. */
  question: string | null;
  /** Plain summary to open the reply with. */
  summary: string;
}

export function interpret(feedback: string, result: Critique): Interpretation {
  const text = ` ${feedback.toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ")} `;
  const matched: Interpretation["matched"] = [];
  const causeRank = new Map<DetectorId, number>();

  for (const term of TERMS) {
    for (const word of term.words) {
      if (text.includes(` ${word} `)) {
        matched.push({ word, goal: Boolean(term.goal) });
        term.causes.forEach((cause, i) => {
          const rank = causeRank.get(cause);
          causeRank.set(cause, rank === undefined ? i : Math.min(rank, i));
        });
        break;
      }
    }
  }

  const explanations = result.findings
    .filter((f) => causeRank.has(f.detector))
    .sort((a, b) => (causeRank.get(a.detector) as number) - (causeRank.get(b.detector) as number));
  const axes = [...new Set(explanations.map((f) => f.axis))];

  return {
    matched,
    explanations,
    axes,
    question: questionFor(matched, explanations, axes),
    summary: summaryFor(feedback, matched, explanations, result),
  };
}

function summaryFor(
  feedback: string,
  matched: Interpretation["matched"],
  explanations: Finding[],
  result: Critique,
): string {
  if (matched.length === 0) {
    return result.findings.length > 0
      ? `I don't have a measured meaning for "${feedback.trim()}" yet. Here is what I can measure in the comp; tell me which of these is closest to what you mean.`
      : `I don't have a measured meaning for "${feedback.trim()}", and none of the usual causes show up in the curves. Describe what you see, or point me at the moment it happens.`;
  }
  const words = matched.map((m) => `"${m.word}"`).join(" and ");
  if (explanations.length === 0) {
    return `None of the usual measurable causes of ${words} show up in this comp. It may come from design, colour or content rather than motion, or from something I can't measure; tell me where you see it.`;
  }
  const top = explanations.slice(0, 2).map((f) => lowerFirst(f.title));
  return `The measurable reasons it may read as ${words}: ${top.join(", and ")}.`;
}

function questionFor(matched: Interpretation["matched"], explanations: Finding[], axes: Axis[]): string | null {
  if (matched.length === 0 || explanations.length === 0) return null;
  if (axes.length < 2) return null;
  const options = axes.map((axis) => AXIS_WORDS[axis]);
  const list = options.length === 2 ? `${options[0]} or ${options[1]}` : `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;
  return `Should I work on ${list}, or all of it?`;
}

function lowerFirst(s: string): string {
  return /^[0-9]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** Every word the lexicon knows, for guidance and tests. */
export function knownWords(): string[] {
  return TERMS.flatMap((t) => t.words);
}
