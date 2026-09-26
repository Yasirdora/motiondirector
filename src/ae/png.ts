import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Just enough PNG to handle frames from After Effects safely.
 *
 * `saveFrameToPng` returns before the file is written, and "the file stopped
 * growing" is not the same as "the file is finished" (Engine Room's issue
 * #45): a PNG is finished when its chunks add up exactly to a final IEND.
 * 16-bit projects produce 16-bit PNGs that many image decoders reject, so
 * those are converted to 8 bits per channel.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export class FrameError extends Error {
  constructor(
    readonly code: "FRAME_TIMEOUT" | "FRAME_INCOMPLETE" | "FRAME_SIZE",
    message: string,
  ) {
    super(message);
  }
}

/** Walk the chunks: complete means signature, IHDR first, and an IEND that ends the file exactly. */
export function inspectPng(buffer: Buffer): { complete: boolean; info: PngInfo | null; reason: string } {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    return { complete: false, info: null, reason: "not a PNG" };
  }
  let offset = 8;
  let info: PngInfo | null = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return { complete: false, info, reason: `chunk ${type} runs past the end of the file` };
    if (type === "IHDR") {
      info = {
        width: buffer.readUInt32BE(offset + 8),
        height: buffer.readUInt32BE(offset + 12),
        bitDepth: buffer.readUInt8(offset + 16),
        colorType: buffer.readUInt8(offset + 17),
        interlace: buffer.readUInt8(offset + 20),
      };
    }
    if (type === "IEND") {
      return end === buffer.length
        ? { complete: info !== null, info, reason: info ? "" : "no IHDR" }
        : { complete: false, info, reason: "data after IEND" };
    }
    offset = end;
  }
  return { complete: false, info, reason: "no IEND yet" };
}

/**
 * Wait until After Effects has finished writing a frame. Two failures stay
 * apart because their remedies differ: a frame that never arrived in time
 * (rendering again immediately would only wait again) and one that stopped
 * changing without being a whole PNG (rendering again can fix it).
 */
export async function waitForPng(
  file: string,
  options: { budgetMs?: number; stallMs?: number; pollMs?: number } = {},
): Promise<Buffer> {
  const budget = options.budgetMs ?? 120_000;
  const stall = options.stallMs ?? 6_000;
  const poll = options.pollMs ?? 40;
  const deadline = Date.now() + budget;
  let lastSize = -1;
  let lastChange = Date.now();
  let reason = "After Effects has not written the frame yet";
  while (Date.now() < deadline) {
    let buffer: Buffer | null = null;
    try {
      buffer = await fs.readFile(file);
    } catch {
      buffer = null;
    }
    if (buffer) {
      if (buffer.length !== lastSize) {
        lastSize = buffer.length;
        lastChange = Date.now();
      }
      const check = inspectPng(buffer);
      if (check.complete) return buffer;
      reason = check.reason;
      if (check.reason === "not a PNG" && buffer.length >= 8) throw new FrameError("FRAME_INCOMPLETE", "After Effects wrote something that is not a PNG.");
      if (Date.now() - lastChange > stall) throw new FrameError("FRAME_INCOMPLETE", `The frame stopped changing before it was complete (${reason}).`);
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new FrameError("FRAME_TIMEOUT", `The frame did not finish rendering in time (${reason}).`);
}

/** 16-bit RGB/RGBA to 8-bit, taking the high byte (exact, since 8→16 promotion multiplies by 257). */
export function toEightBit(buffer: Buffer): { buffer: Buffer; converted: boolean; empty: boolean } {
  const { info } = inspectPng(buffer);
  if (!info || info.interlace !== 0 || (info.colorType !== 2 && info.colorType !== 6)) {
    return { buffer, converted: false, empty: false };
  }
  const channels = info.colorType === 6 ? 4 : 3;
  const pixels = decode(buffer, info, channels);
  const empty = channels === 4 && isFullyTransparent(pixels, info.bitDepth);
  if (info.bitDepth === 8) return { buffer, converted: false, empty };
  if (info.bitDepth !== 16) return { buffer, converted: false, empty };

  const rowIn = info.width * channels * 2;
  const rowOut = info.width * channels;
  const raw = Buffer.alloc((rowOut + 1) * info.height);
  for (let y = 0; y < info.height; y++) {
    raw[y * (rowOut + 1)] = 0;
    for (let x = 0; x < rowOut; x++) raw[y * (rowOut + 1) + 1 + x] = pixels[y * rowIn + x * 2] as number;
  }
  return { buffer: encode(info.width, info.height, info.colorType, raw), converted: true, empty };
}

export function hashPng(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function decode(buffer: Buffer, info: PngInfo, channels: number): Buffer {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const data = inflateSync(Buffer.concat(idat));
  const bpp = channels * (info.bitDepth / 8);
  const stride = info.width * bpp;
  const out = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const filter = data[y * (stride + 1)] as number;
    const line = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[y * stride + x - bpp] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] as number) : 0;
      const raw = line[x] as number;
      let value: number;
      switch (filter) {
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: value = raw + paeth(a, b, c); break;
        default: value = raw;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function isFullyTransparent(pixels: Buffer, bitDepth: number): boolean {
  const step = bitDepth === 16 ? 8 : 4;
  const alpha = bitDepth === 16 ? 6 : 3;
  for (let i = alpha; i < pixels.length; i += step) if (pixels[i] !== 0) return false;
  return true;
}

function encode(width: number, height: number, colorType: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colorType, 9);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a PNG from raw pixels (tests and synthetic frames). */
export function encodePng(width: number, height: number, bitDepth: 8 | 16, rgba: number[]): Buffer {
  const bytes = bitDepth / 8;
  const stride = width * 4 * bytes;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width * 4; x++) {
      const v = rgba[(y * width * 4 + x) % rgba.length] as number;
      if (bytes === 2) raw.writeUInt16BE(v, y * (stride + 1) + 1 + x * 2);
      else raw[y * (stride + 1) + 1 + x] = v;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(bitDepth, 8);
  header.writeUInt8(6, 9);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
