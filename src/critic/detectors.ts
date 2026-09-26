import type { CompReading, LayerEvent, MotionScore, Movement } from "../lens/types.js";

/**
 * Each detector looks for one measurable reason motion can read as careless.
 * The catalogue started from LobzyJay's "defaults to avoid" (MIT,
 * github.com/LobzyJay/motion-design-with-claude): nearly all of those tells can
 * be measured from curves, which is what these do.
 */
export type DetectorId =
  | "linear-easing"
  | "simultaneous-start"
  | "simultaneous-landing"
  | "uniform-duration"
  | "no-follow-through"
  | "ping-pong-bounce"
  | "default-wiggle"
  | "fade-only-entrance"
  | "sluggish-tail"
  | "hard-stop"
  | "heavy-overshoot"
  | "abrupt-move";

/** Which aspect of the motion a finding is about; used to ask the designer one useful question. */
export type Axis = "choreography" | "feel" | "staging";

export type Severity = "major" | "minor" | "note";

export interface Evidence {
  /** The measured movement or layer event this evidence is about, when there is one. */
  movementId?: string;
  eventId?: string;
  layerId: number;
  layerName: string;
  property?: string;
  start?: number;
  end?: number;
  detail: string;
}

export interface Finding {
  detector: DetectorId;
  axis: Axis;
  severity: Severity;
  /** How sure the measurement is that this is what a viewer perceives (0–1). */
  confidence: number;
  title: string;
  /** Why it reads that way, in a designer's words. */
  explanation: string;
  measured: Record<string, number>;
  evidence: Evidence[];
  /** Recipes that address it; see director/recipes. */
  remedies: string[];
}

export interface DetectorContext {
  score: MotionScore;
  reading: CompReading;
}

export interface Detector {
  id: DetectorId;
  /** Returns the finding, or a reason it could not judge, or null when there is nothing to report. */
  run(ctx: DetectorContext): Finding | { skipped: string } | null;
}

/** Movements big enough that a viewer registers them. */
function noticeable(m: Movement): boolean {
  if (m.kind === "opacity") return m.amplitude >= 20;
  return m.significance >= 0.01;
}

/** Movements big enough to carry the composition. */
function large(m: Movement): boolean {
  return m.kind !== "opacity" && m.kind !== "other" && m.significance >= 0.05;
}

/** A movement that runs across the whole sampled range is a loop or a drift, which is judged differently. */
function continuous(m: Movement, score: MotionScore): boolean {
  const frame = 1 / score.frameRate;
  return m.startTime <= score.range.start + frame && m.endTime >= score.range.end - frame;
}

function evidenceFor(m: Movement, detail: string): Evidence {
  return { movementId: m.id, layerId: m.layerId, layerName: m.layerName, property: m.propertyName, start: m.startTime, end: m.endTime, detail };
}

function eventEvidence(e: LayerEvent, detail: string): Evidence {
  return { eventId: e.id, layerId: e.layerId, layerName: e.layerName, start: e.startTime, end: e.endTime, detail };
}

const seconds = (s: number) => `${Math.round(s * 1000)} ms`;
const percent = (f: number) => `${Math.round(f * 100)}%`;

const linearEasing: Detector = {
  id: "linear-easing",
  run({ score }) {
    const candidates = score.movements.filter(
      (m) => noticeable(m) && m.duration >= 0.15 && !continuous(m, score) && m.shape !== "jump",
    );
    if (candidates.length === 0) return null;
    const linear = candidates.filter((m) => m.shape === "linear");
    if (linear.length === 0) return null;
    const ratio = linear.length / candidates.length;
    return {
      detector: "linear-easing",
      axis: "feel",
      severity: ratio >= 0.5 ? "major" : "minor",
      confidence: 0.9,
      title: `${linear.length} of ${candidates.length} movements travel at constant speed`,
      explanation:
        "They start at full speed and stop dead. Nothing physical moves that way, so it reads as mechanical or unconsidered.",
      measured: { linear: linear.length, movements: candidates.length, ratio: round(ratio) },
      evidence: linear.map((m) => evidenceFor(m, `linear over ${seconds(m.duration)}`)),
      remedies: ["re-ease"],
    };
  },
};

const simultaneousStart: Detector = {
  id: "simultaneous-start",
  run({ score }) {
    const { events, choreography } = score;
    if (events.length < 3) return { skipped: "needs at least three elements in motion" };
    const cluster = choreography.startClusters[0];
    if (!cluster || cluster.eventIds.length < 3 || choreography.simultaneousStartRatio < 0.5) return null;
    const members = events.filter((e) => cluster.eventIds.includes(e.id));
    return {
      detector: "simultaneous-start",
      axis: "choreography",
      severity: choreography.simultaneousStartRatio >= 0.7 ? "major" : "minor",
      confidence: 0.9,
      title: `${members.length} of ${events.length} elements start on the same frame`,
      explanation:
        "When everything moves at once the eye has no path to follow; the screen changes as a block instead of telling a sequence.",
      measured: { together: members.length, elements: events.length, at: round(cluster.time) },
      evidence: members.map((e) => eventEvidence(e, `starts at ${round(e.startTime)} s`)),
      remedies: ["stagger"],
    };
  },
};

const simultaneousLanding: Detector = {
  id: "simultaneous-landing",
  run({ score }) {
    const { events, choreography } = score;
    if (events.length < 3) return { skipped: "needs at least three elements in motion" };
    const cluster = choreography.endClusters[0];
    if (!cluster || cluster.eventIds.length < 3 || choreography.simultaneousEndRatio < 0.7) return null;
    const members = events.filter((e) => cluster.eventIds.includes(e.id));
    return {
      detector: "simultaneous-landing",
      axis: "choreography",
      severity: "minor",
      confidence: 0.8,
      title: `${members.length} elements land on the same frame`,
      explanation: "Everything freezes at one instant, so the end of the animation feels like a stop rather than a settle.",
      measured: { together: members.length, elements: events.length, at: round(cluster.time) },
      evidence: members.map((e) => eventEvidence(e, `lands at ${round(e.endTime)} s`)),
      remedies: ["stagger", "retime"],
    };
  },
};

const uniformDuration: Detector = {
  id: "uniform-duration",
  run({ score }) {
    const { events, choreography } = score;
    if (events.length < 3) return { skipped: "needs at least three elements in motion" };
    if (choreography.durationVariation >= 0.1) return null;
    const typical = events.reduce((a, e) => a + e.duration, 0) / events.length;
    return {
      detector: "uniform-duration",
      axis: "choreography",
      severity: "minor",
      confidence: 0.75,
      title: `Every element takes about ${seconds(typical)}`,
      explanation:
        "Duration carries weight. When the logo and a small label take the same time, nothing reads as more important.",
      measured: { variation: choreography.durationVariation, typicalSeconds: round(typical) },
      evidence: events.map((e) => eventEvidence(e, `${seconds(e.duration)}`)),
      remedies: ["retime"],
    };
  },
};

const noFollowThrough: Detector = {
  id: "no-follow-through",
  run({ score }) {
    const moves = score.movements.filter((m) => large(m) && !continuous(m, score) && m.shape !== "excursion");
    if (moves.length < 2) return { skipped: "needs at least two large movements" };
    if (moves.some((m) => m.overshoot > 0.01 || m.oscillations > 0)) return null;
    return {
      detector: "no-follow-through",
      axis: "feel",
      severity: "note",
      confidence: 0.5,
      title: "No large movement carries past its target",
      explanation:
        "Every move stops exactly where it lands. That can be the right restraint, but it is also what makes motion feel stiff or like a slideshow.",
      measured: { largeMovements: moves.length },
      evidence: moves.map((m) => evidenceFor(m, `stops with no overshoot`)),
      remedies: ["follow-through"],
    };
  },
};

const pingPongBounce: Detector = {
  id: "ping-pong-bounce",
  run({ score }) {
    const moves = score.movements.filter((m) => m.oscillations >= 2 && m.decay !== null && m.decay >= 0.85);
    if (moves.length === 0) return null;
    return {
      detector: "ping-pong-bounce",
      axis: "feel",
      severity: "major",
      confidence: 0.85,
      title: `${moves.length} bounce${moves.length > 1 ? "s" : ""} that never lose energy`,
      explanation:
        "Real bounces shrink each time. One that swings back and forth at the same size reads as a toggle or a toy, not physics.",
      measured: { count: moves.length, decay: round(Math.max(...moves.map((m) => m.decay as number))) },
      evidence: moves.map((m) =>
        evidenceFor(m, `${m.oscillations} swings, each ${percent(m.decay as number)} of the last`),
      ),
      remedies: ["soften-overshoot"],
    };
  },
};

const WIGGLE = /wiggle\s*\(\s*([\d.]+)\s*,\s*([\d.]+)/;

const defaultWiggle: Detector = {
  id: "default-wiggle",
  run({ reading }) {
    const evidence: Evidence[] = [];
    for (const layer of reading.layers) {
      if (!layer.enabled) continue;
      for (const track of layer.properties) {
        const match = track.expression?.enabled ? WIGGLE.exec(track.expression.text) : null;
        if (!match) continue;
        const frequency = Number(match[1]);
        const amplitude = Number(match[2]);
        if (frequency >= 2 && amplitude >= 10) {
          evidence.push({
            layerId: layer.id,
            layerName: layer.name,
            property: track.name,
            detail: `wiggle(${frequency}, ${amplitude})`,
          });
        }
      }
    }
    if (evidence.length === 0) return null;
    return {
      detector: "default-wiggle",
      axis: "staging",
      severity: "minor",
      confidence: 0.7,
      title: `${evidence.length} fast, large wiggle${evidence.length > 1 ? "s" : ""}`,
      explanation:
        "A quick, wide wiggle is random jitter unrelated to anything else moving. It reads as a placeholder for organic motion rather than a design.",
      measured: { count: evidence.length },
      evidence,
      remedies: [],
    };
  },
};

const fadeOnlyEntrance: Detector = {
  id: "fade-only-entrance",
  run({ score }) {
    const entrances = score.events.filter((e) => e.role === "entrance");
    if (entrances.length < 2) return { skipped: "needs at least two entrances" };
    const fadeOnly = entrances.filter((e) => e.kinds.length === 1 && e.kinds[0] === "opacity");
    if (fadeOnly.length < 2 || fadeOnly.length / entrances.length < 0.3) return null;
    return {
      detector: "fade-only-entrance",
      axis: "staging",
      severity: "minor",
      confidence: 0.7,
      title: `${fadeOnly.length} of ${entrances.length} elements only fade in`,
      explanation:
        "A pure fade says nothing about where something came from or how it relates to the rest. A small move or scale alongside it gives it direction and weight.",
      measured: { fadeOnly: fadeOnly.length, entrances: entrances.length },
      evidence: fadeOnly.map((e) => eventEvidence(e, "opacity only")),
      remedies: [],
    };
  },
};

const sluggishTail: Detector = {
  id: "sluggish-tail",
  run({ score }) {
    const moves = score.movements.filter((m) => noticeable(m) && m.duration >= 0.4 && m.tailFraction >= 0.45);
    if (moves.length === 0) return null;
    return {
      detector: "sluggish-tail",
      axis: "feel",
      severity: "minor",
      confidence: 0.75,
      title: `${moves.length} movement${moves.length > 1 ? "s" : ""} creep into place`,
      explanation:
        "Most of the time is spent crawling over the last few pixels, which reads as heavy, floaty or slow to settle.",
      measured: { count: moves.length, worstTail: round(Math.max(...moves.map((m) => m.tailFraction))) },
      evidence: moves.map((m) => evidenceFor(m, `${percent(m.tailFraction)} of the time on the last 5%`)),
      remedies: ["re-ease", "retime"],
    };
  },
};

const hardStop: Detector = {
  id: "hard-stop",
  run({ score }) {
    const moves = score.movements.filter(
      (m) => noticeable(m) && m.significance >= 0.03 && m.shape === "ease-in" && m.overshoot === 0,
    );
    if (moves.length === 0) return null;
    return {
      detector: "hard-stop",
      axis: "feel",
      severity: "minor",
      confidence: 0.6,
      title: `${moves.length} movement${moves.length > 1 ? "s" : ""} accelerate into a dead stop`,
      explanation:
        "Speeding up and then halting at full speed reads as a collision. Right for an impact, jarring anywhere else.",
      measured: { count: moves.length },
      evidence: moves.map((m) => evidenceFor(m, `arrives at ${percent(m.endSpeedRatio)} of peak speed`)),
      remedies: ["re-ease"],
    };
  },
};

const heavyOvershoot: Detector = {
  id: "heavy-overshoot",
  run({ score }) {
    const moves = score.movements.filter((m) => noticeable(m) && m.overshoot >= 0.2);
    if (moves.length === 0) return null;
    return {
      detector: "heavy-overshoot",
      axis: "feel",
      severity: "minor",
      confidence: 0.8,
      title: `${moves.length} movement${moves.length > 1 ? "s" : ""} overshoot by a fifth or more`,
      explanation: "A large overshoot reads as bouncy or cartoonish; subtle follow-through is usually under 10%.",
      measured: { count: moves.length, worst: round(Math.max(...moves.map((m) => m.overshoot))) },
      evidence: moves.map((m) => evidenceFor(m, `overshoots by ${percent(m.overshoot)}`)),
      remedies: ["soften-overshoot"],
    };
  },
};

const abruptMove: Detector = {
  id: "abrupt-move",
  run({ score }) {
    const moves = score.movements.filter((m) => large(m) && m.shape !== "jump" && m.duration < 0.12);
    if (moves.length === 0) return null;
    return {
      detector: "abrupt-move",
      axis: "feel",
      severity: "minor",
      confidence: 0.7,
      title: `${moves.length} large movement${moves.length > 1 ? "s" : ""} over in under 120 ms`,
      explanation: "A big move in three frames or fewer is hard to follow and reads as a glitch or a jolt.",
      measured: { count: moves.length },
      evidence: moves.map((m) => evidenceFor(m, `${seconds(m.duration)}`)),
      remedies: ["retime"],
    };
  },
};

export const DETECTORS: readonly Detector[] = [
  linearEasing,
  simultaneousStart,
  simultaneousLanding,
  uniformDuration,
  noFollowThrough,
  pingPongBounce,
  defaultWiggle,
  fadeOnlyEntrance,
  sluggishTail,
  hardStop,
  heavyOvershoot,
  abruptMove,
];

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
