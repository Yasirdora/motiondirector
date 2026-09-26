import { mkdirSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Keyframe, CompReading } from "../lens/types.js";
import type { AeOutcome } from "./protocol.js";
import { FrameError, hashPng, inspectPng, toEightBit, waitForPng } from "./png.js";
import type { MailboxTransport } from "./transport.js";

export interface ProjectInfo {
  afterEffects: string;
  project: { name: string; path: string | null };
  activeComp: { id: number; name: string } | null;
}

export interface CompSummary {
  id: number;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  layers: number;
}

export interface KeyEdit {
  layerId: number;
  path: string[];
  keys: Keyframe[];
  /** When given, After Effects refuses the whole edit if the current keys differ. */
  expect?: Keyframe[];
}

export interface Frame {
  time: number;
  file: string;
  width: number;
  height: number;
  /** The frame was 16-bit and was converted so image decoders accept it. */
  converted: boolean;
  /** Every pixel is transparent: nothing is visible at this time. */
  empty: boolean;
  /** Identical pixels to another frame taken for a different request; either a still moment or a stale render. */
  identicalTo: number | null;
}

/**
 * Typed access to the operations the dispatcher offers. Every method returns
 * the transport's honest outcome; nothing here retries a change.
 */
export class AfterEffects {
  private recentFrames: { key: string; hash: string; time: number }[] = [];

  constructor(private readonly transport: MailboxTransport) {}

  ping(): Promise<AeOutcome<ProjectInfo>> {
    return this.transport.call("ping", {}, { mutates: false, label: "Check", timeoutMs: 20_000 });
  }

  listComps(): Promise<AeOutcome<CompSummary[]>> {
    return this.transport.call("list_comps", {}, { mutates: false, label: "List comps", timeoutMs: 30_000 });
  }

  readComp(compId: number, range: { start?: number; end?: number } = {}): Promise<AeOutcome<CompReading>> {
    return this.transport.call("read_comp", { compId, ...range }, { mutates: false, label: "Read motion", timeoutMs: 180_000 });
  }

  duplicateComp(compId: number, label: string): Promise<AeOutcome<{ compId: number; name: string; layerMap: [number, number][] }>> {
    return this.transport.call("duplicate_comp", { compId, label }, { mutates: true, label: `Rehearse ${label}`, timeoutMs: 60_000 });
  }

  deleteRehearsal(compId: number): Promise<AeOutcome<{ deleted: boolean }>> {
    return this.transport.call("delete_rehearsal", { compId }, { mutates: true, label: "Remove rehearsal", timeoutMs: 30_000 });
  }

  setKeys(compId: number, edits: KeyEdit[], label: string): Promise<AeOutcome<{ applied: number }>> {
    return this.transport.call("set_keys", { compId, edits }, { mutates: true, label, timeoutMs: 90_000 });
  }

  /**
   * Render frames to a folder and wait until each is a complete PNG of the
   * expected size. Still frames are hints, never proof of how motion feels.
   */
  async frames(compId: number, times: number[], folder: string, factor: number): Promise<{ frames: Frame[]; problems: string[] }> {
    mkdirSync(folder, { recursive: true });
    const frames: Frame[] = [];
    const problems: string[] = [];
    for (const [i, time] of times.entries()) {
      const file = path.join(folder, `${String(i).padStart(4, "0")}.png`);
      await fs.rm(file, { force: true });
      const outcome = await this.transport.call<{ width: number; height: number }>(
        "save_frame",
        { compId, time, path: file, factor },
        { mutates: false, label: "Render frame", timeoutMs: 180_000 },
      );
      if (outcome.status !== "ok") {
        problems.push(`${time.toFixed(3)} s: ${outcome.message}`);
        continue;
      }
      try {
        const written = await waitForPng(file);
        const { info } = inspectPng(written);
        if (!info || Math.abs(info.width - outcome.value.width) > 1 || Math.abs(info.height - outcome.value.height) > 1) {
          throw new FrameError("FRAME_SIZE", `expected ${outcome.value.width}×${outcome.value.height}, got ${info?.width}×${info?.height}; After Effects may have returned an earlier render`);
        }
        const { buffer, converted, empty } = toEightBit(written);
        if (converted) await fs.writeFile(file, buffer);
        const hash = hashPng(buffer);
        const key = `${compId}@${time}@${factor}`;
        const twin = this.recentFrames.find((f) => f.hash === hash && f.key !== key);
        this.recentFrames = [...this.recentFrames.slice(-47), { key, hash, time }];
        frames.push({ time, file, width: info.width, height: info.height, converted, empty, identicalTo: twin ? twin.time : null });
      } catch (err) {
        problems.push(`${time.toFixed(3)} s: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { frames, problems };
  }
}
