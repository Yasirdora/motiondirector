import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AfterEffects } from "../src/ae/client.js";
import { encodePng, FrameError, inspectPng, toEightBit, waitForPng } from "../src/ae/png.js";
import { planPreview } from "../src/ae/preview.js";
import type { AeOutcome } from "../src/ae/protocol.js";
import type { MailboxTransport } from "../src/ae/transport.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("PNG handling", () => {
  it("knows a complete PNG from a partial one", () => {
    const png = encodePng(4, 3, 8, [255, 0, 0, 255]);
    expect(inspectPng(png)).toMatchObject({ complete: true, info: { width: 4, height: 3, bitDepth: 8 } });
    expect(inspectPng(png.subarray(0, png.length - 5)).complete).toBe(false);
    expect(inspectPng(Buffer.from("hello world")).reason).toBe("not a PNG");
  });

  it("waits for After Effects to finish writing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "md-png-"));
    const file = path.join(dir!, "f.png");
    const png = encodePng(8, 8, 8, [10, 20, 30, 255]);
    writeFileSync(file, png.subarray(0, 20));
    setTimeout(() => writeFileSync(file, png), 60);
    const got = await waitForPng(file, { pollMs: 5 });
    expect(got.equals(png)).toBe(true);
  });

  it("gives up on a write that stalled incomplete, and says so differently from a timeout", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "md-png-"));
    const file = path.join(dir!, "f.png");
    writeFileSync(file, encodePng(8, 8, 8, [1, 2, 3, 255]).subarray(0, 30));
    await expect(waitForPng(file, { stallMs: 50, pollMs: 5 })).rejects.toMatchObject({ code: "FRAME_INCOMPLETE" });
    await expect(waitForPng(path.join(dir!, "never.png"), { budgetMs: 60, pollMs: 5 })).rejects.toBeInstanceOf(FrameError);
    await expect(waitForPng(path.join(dir!, "never.png"), { budgetMs: 60, pollMs: 5 })).rejects.toMatchObject({ code: "FRAME_TIMEOUT" });
  });

  it("converts 16-bit frames to 8-bit exactly", () => {
    const sixteen = encodePng(2, 2, 16, [0xff00, 0x8000, 0x0100, 0xffff]);
    const { buffer, converted } = toEightBit(sixteen);
    expect(converted).toBe(true);
    expect(inspectPng(buffer).info?.bitDepth).toBe(8);
    // The high byte of each 16-bit sample, and nothing else, survives.
    expect(buffer.equals(encodePng(2, 2, 8, [0xff, 0x80, 0x01, 0xff]))).toBe(true);
  });

  it("says when a frame is completely transparent", () => {
    expect(toEightBit(encodePng(3, 3, 8, [0, 0, 0, 0])).empty).toBe(true);
    expect(toEightBit(encodePng(3, 3, 8, [0, 0, 0, 1])).empty).toBe(false);
  });
});

describe("planPreview", () => {
  it("renders every frame of a short range and plays it at the comp rate", () => {
    const plan = planPreview(30, 0, 3);
    expect(plan.times).toHaveLength(91);
    expect(plan.playbackFps).toBe(30);
  });

  it("keeps real speed when it has to skip frames", () => {
    const plan = planPreview(30, 0, 10, 120);
    expect(plan.step).toBe(3);
    expect(plan.playbackFps).toBe(10);
    const shownFor = plan.times.length / plan.playbackFps;
    expect(shownFor).toBeCloseTo(10, 0);
  });
});

describe("AfterEffects.frames", () => {
  function stubTransport(write: (file: string, call: number) => Buffer | null, reported = { width: 4, height: 4 }) {
    let calls = 0;
    return {
      call: async (_op: string, args: { path: string }): Promise<AeOutcome<unknown>> => {
        const png = write(args.path, calls++);
        if (png) writeFileSync(args.path, png);
        return { status: "ok", value: reported, durationMs: 1, logs: [] };
      },
    } as unknown as MailboxTransport;
  }

  it("returns verified frames and converts 16-bit ones", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "md-frames-"));
    const ae = new AfterEffects(stubTransport((_f, i) => encodePng(4, 4, 16, [i * 1000, 0, 0, 0xffff])));
    const { frames, problems } = await ae.frames(1, [0, 0.5], dir!, 1);
    expect(problems).toEqual([]);
    expect(frames.map((f) => f.converted)).toEqual([true, true]);
    expect(inspectPng(readFileSync(frames[0]!.file)).info?.bitDepth).toBe(8);
  });

  it("rejects a frame of the wrong size instead of passing off an earlier render", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "md-frames-"));
    const ae = new AfterEffects(stubTransport(() => encodePng(8, 8, 8, [1, 1, 1, 255])));
    const { frames, problems } = await ae.frames(1, [0], dir!, 1);
    expect(frames).toEqual([]);
    expect(problems[0]).toMatch(/expected 4×4, got 8×8/);
  });

  it("points out identical frames for different times", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "md-frames-"));
    const ae = new AfterEffects(stubTransport(() => encodePng(4, 4, 8, [9, 9, 9, 255])));
    const { frames } = await ae.frames(1, [0, 1], dir!, 1);
    expect(frames[0]!.identicalTo).toBeNull();
    expect(frames[1]!.identicalTo).toBe(0);
  });
});
