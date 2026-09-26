import type { CompReading, MotionScore } from "../lens/types.js";
import { DETECTORS, type DetectorId, type Finding, type Severity } from "./detectors.js";

export interface Critique {
  compName: string;
  /** The score fingerprint this critique was measured from. */
  fingerprint: string;
  findings: Finding[];
  /** Detectors that could not judge this comp, and why. Never silently dropped. */
  skipped: { detector: DetectorId; reason: string }[];
  measured: { movements: number; events: number };
}

const SEVERITY_RANK: Record<Severity, number> = { major: 0, minor: 1, note: 2 };

export function critique(score: MotionScore, reading: CompReading): Critique {
  const findings: Finding[] = [];
  const skipped: Critique["skipped"] = [];
  for (const detector of DETECTORS) {
    const result = detector.run({ score, reading });
    if (result === null) continue;
    if ("skipped" in result) skipped.push({ detector: detector.id, reason: result.skipped });
    else findings.push(result);
  }
  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence,
  );
  return {
    compName: score.compName,
    fingerprint: score.fingerprint,
    findings,
    skipped,
    measured: { movements: score.movements.length, events: score.events.length },
  };
}
