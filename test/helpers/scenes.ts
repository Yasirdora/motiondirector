/**
 * Whole-comp scenes for tests: the same six-element title card animated
 * carelessly and with care, so detectors can be checked on both.
 */
import type { CompReading } from "../../src/lens/types.js";
import { keyedTrack } from "./keyed.js";
import { ease, layer, reading, samplesFor, track, type Ease } from "./synth.js";

const TOTAL = 3;
const names = ["Logo", "Title", "Subtitle", "Rule", "Tagline", "Badge"];

function entrance(name: string, id: number, start: number, duration: number, e: Ease, withMove = true) {
  const opacity = track("opacity", samplesFor([{ from: [0], to: [100], start, duration, ease: e }], { total: TOTAL }));
  const properties = [opacity];
  if (withMove) {
    properties.push(
      track(
        "position",
        samplesFor([{ from: [960, 640 + id * 10], to: [960, 540 + id * 10], start, duration, ease: e }], { total: TOTAL }),
      ),
    );
  }
  return layer(name, properties, { id, inPoint: 0 });
}

/** Everything starts on frame 0, lasts 0.5 s and moves linearly; two layers only fade. */
export function carelessTitleCard(): CompReading {
  return reading(
    names.map((name, i) => entrance(name, i + 1, 0, 0.5, ease.linear, i < 4)),
    { name: "Title Card (careless)" },
  );
}

/** Staggered by 80 ms, eased out, primary element longer than the rest. */
export function carefulTitleCard(): CompReading {
  return reading(
    names.map((name, i) => entrance(name, i + 1, 0.1 + i * 0.08, i === 0 ? 0.8 : 0.5 + i * 0.03, ease.outCubic)),
    { name: "Title Card (careful)" },
  );
}

/** The careless card with real keys, so recipes can edit it. */
export function keyedCarelessTitleCard(): CompReading {
  return reading(
    names.map((name, i) => {
      const properties = [keyedTrack("opacity", [{ from: [0], to: [100], start: 0, duration: 0.5 }], { total: TOTAL })];
      if (i < 4) {
        properties.push(
          keyedTrack("position", [{ from: [960, 640 + i * 60], to: [960, 540 + i * 60], start: 0, duration: 0.5 }], { total: TOTAL }),
        );
      }
      return layer(name, properties, { id: i + 1, inPoint: 0 });
    }),
    { name: "Title Card (careless, keyed)" },
  );
}
