/**
 * Which frames to render for a preview, and the rate to play them back at so
 * the preview runs at true speed.
 *
 * A preview that samples N frames and plays them at a fixed rate gets timing
 * wrong by exactly the ratio between the two (solomon's ae_review_motion
 * plays 16 samples at 12 fps, so a 2-second move plays in 1.3 s). Here the
 * playback rate is always samples ÷ duration, so what the designer sees is
 * how long the motion really takes.
 */
export interface PreviewPlan {
  times: number[];
  /** Frames per second to play `times` back at; real time by construction. */
  playbackFps: number;
  /** Every how many comp frames one is rendered. */
  step: number;
}

export function planPreview(frameRate: number, start: number, end: number, maxFrames = 120): PreviewPlan {
  const total = Math.max(1, Math.floor((end - start) * frameRate + 1e-6) + 1);
  const step = Math.max(1, Math.ceil(total / maxFrames));
  const times: number[] = [];
  for (let f = 0; f < total; f += step) times.push(round(start + f / frameRate));
  return { times, playbackFps: round(frameRate / step), step };
}

function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
