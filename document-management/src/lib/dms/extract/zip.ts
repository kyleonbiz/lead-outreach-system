import { Inflate } from "fflate";
import { ExtractError } from "./errors";
import type { ExtractLimits } from "./limits";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const unsafe = () => new ExtractError("unsupported", "unsafe_archive");

/**
 * Reads the central directory only. Sizes in headers are attacker-controlled,
 * so they are used for sanity checks, never to decide how much to allocate.
 * ZIP64 and encrypted archives are rejected rather than half-supported.
 */
export function listZip(data: Uint8Array, limits: ExtractLimits): Map<string, ZipEntry> {
  if (data.length < 22) throw unsafe();
  // End-of-central-directory record sits within the last 64 KB + 22 bytes.
  let eocd = -1;
  const stop = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= stop; i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unsafe();
  const total = u16(data, eocd + 10);
  const cdSize = u32(data, eocd + 12);
  const cdOffset = u32(data, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unsafe(); // ZIP64
  if (total > limits.maxZipEntries) throw unsafe();
  if (cdOffset + cdSize > data.length) throw unsafe();

  const entries = new Map<string, ZipEntry>();
  const names = new TextDecoder("utf-8", { fatal: false });
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > data.length || u32(data, p) !== 0x02014b50) throw unsafe();
    const flags = u16(data, p + 8);
    const method = u16(data, p + 10);
    const compressedSize = u32(data, p + 20);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    const localOffset = u32(data, p + 42);
    if (p + 46 + nameLen > data.length) throw unsafe();
    const name = names.decode(data.subarray(p + 46, p + 46 + nameLen));
    // First entry wins, so a duplicate name cannot shadow the one we inspected.
    if (!entries.has(name)) entries.set(name, { name, method, flags, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates one entry, enforcing size and ratio limits on the bytes actually produced. */
export function readEntry(
  data: Uint8Array,
  entry: ZipEntry,
  limits: ExtractLimits,
  budget: { remaining: number },
): Uint8Array {
  if (entry.flags & 1) throw new ExtractError("unsupported", "encrypted");
  const o = entry.localOffset;
  if (o + 30 > data.length || u32(data, o) !== 0x04034b50) throw unsafe();
  const start = o + 30 + u16(data, o + 26) + u16(data, o + 28);
  const end = start + entry.compressedSize;
  if (end > data.length || end < start) throw unsafe();
  const raw = data.subarray(start, end);

  const cap = Math.min(limits.maxEntryBytes, budget.remaining);
  const checkRatio = (produced: number) => {
    if (produced > limits.ratioFloorBytes && produced / Math.max(1, raw.length) > limits.maxRatio) throw unsafe();
  };

  if (entry.method === 0) {
    if (raw.length > cap) throw unsafe();
    budget.remaining -= raw.length;
    return raw;
  }
  if (entry.method !== 8) throw unsafe();

  const chunks: Uint8Array[] = [];
  let produced = 0;
  let failure: ExtractError | null = null;
  const inflate = new Inflate((chunk) => {
    if (failure) return;
    produced += chunk.length;
    if (produced > cap) {
      failure = unsafe();
      return;
    }
    try {
      checkRatio(produced);
    } catch (e) {
      failure = e as ExtractError;
      return;
    }
    chunks.push(chunk);
  });
  // Small input slices bound how much one push can expand (deflate maxes out near 1032:1).
  const STEP = 4096;
  try {
    for (let i = 0; i < raw.length && !failure; i += STEP) {
      inflate.push(raw.subarray(i, Math.min(i + STEP, raw.length)), i + STEP >= raw.length);
    }
  } catch {
    throw new ExtractError("failed", "parse_error");
  }
  if (failure) throw failure;
  budget.remaining -= produced;
  const out = new Uint8Array(produced);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
