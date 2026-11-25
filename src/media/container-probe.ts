import crypto from "node:crypto";
import fs from "node:fs";
import type { FetchLike } from "../net/ipv4-fetch.ts";

const ALLOWED_GOOGLEVIDEO_HOST = /^[a-z0-9-]+\.googlevideo\.com$/i;
export const MAX_DASH_HEADER_PROBE_BYTES = 2 * 1024 * 1024; // 2 MiB upper cap for header/index probing

export interface DashByteRanges {
  init: string; // e.g. "0-740"
  index: string; // e.g. "741-1500"
  initStart: number;
  initEnd: number;
  indexStart: number;
  indexEnd: number;
  initHash?: string;
  indexHash?: string;
}

export interface ProbedMp4TrackMetadata {
  durationSec?: number;
  width?: number;
  height?: number;
  codec?: string;
  isVideo?: boolean;
  isAudio?: boolean;
}

export function sha256Hex(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Compute the SHA-256 hex digest of an inclusive byte range `[start, end]` in a local file.
 * Returns `null` if the file is shorter than `end + 1` or the range exceeds `MAX_DASH_HEADER_PROBE_BYTES`.
 */
export function computeFileRangeSha256(
  filePath: string,
  start: number,
  end: number,
): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }
  const length = end - start + 1;
  if (length > MAX_DASH_HEADER_PROBE_BYTES) {
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < end + 1) return null;
    const hash = crypto.createHash("sha256");
    const chunkBuf = Buffer.allocUnsafe(Math.min(64 * 1024, length));
    let remaining = length;
    let pos = start;
    while (remaining > 0) {
      const toRead = Math.min(chunkBuf.byteLength, remaining);
      const n = fs.readSync(fd, chunkBuf, 0, toRead, pos);
      if (n <= 0) return null;
      hash.update(chunkBuf.subarray(0, n));
      pos += n;
      remaining -= n;
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse ISO BMFF (MP4 / M4A) top-level boxes from the beginning of a DASH stream
 * to extract exact `initRange` (ftyp..moov) and `indexRange` (sidx).
 */
export function parseMp4DashRanges(buf: Uint8Array): DashByteRanges | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  let moovEnd: number | null = null;
  let sidxStart: number | null = null;
  let sidxEnd: number | null = null;

  while (offset + 8 <= buf.byteLength) {
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      buf[offset + 4]!,
      buf[offset + 5]!,
      buf[offset + 6]!,
      buf[offset + 7]!,
    );

    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buf.byteLength) break;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      // Extends to EOF
      break;
    }

    if (size < headerSize || !Number.isFinite(size)) break;

    const boxEnd = offset + size;

    if (type === "moov") {
      moovEnd = boxEnd;
    } else if (type === "sidx") {
      sidxStart = offset;
      sidxEnd = boxEnd;
      // Note: Even if boxEnd > buf.byteLength, we already know the exact sidx end!
      if (moovEnd !== null) {
        break;
      }
    } else if (type === "moof" || type === "mdat") {
      break;
    }

    if (boxEnd > buf.byteLength) {
      break;
    }
    offset = boxEnd;
  }

  if (moovEnd === null || sidxStart === null || sidxEnd === null) {
    return null;
  }

  const initEnd = moovEnd - 1;
  const indexStart = sidxStart;
  const indexEnd = sidxEnd - 1;

  if (initEnd < 0 || indexEnd < indexStart) {
    return null;
  }

  return {
    init: `0-${initEnd}`,
    index: `${indexStart}-${indexEnd}`,
    initStart: 0,
    initEnd,
    indexStart,
    indexEnd,
  };
}

const MAX_SIDX_BOX_BYTES = 2 * 1024 * 1024; // 2 MiB sanity cap
const MAX_MP4_TOP_LEVEL_BOXES = 250_000; // Bound synchronous top-level box walks

/**
 * Verify that an MP4/M4A file on disk contains a SINGLE global `sidx` box
 * placed after `moov` and before the first `moof`/`mdat` with valid timescale,
 * subsegment durations, and direct media references covering every complete
 * `moof`+`mdat` fragment in the file (with no per-fragment `sidx` boxes later).
 *
 * FFmpeg without `+global_sidx` emits one `sidx` per fragment; parsing only the
 * first `sidx` box would truncate DASH playback to fragment 1.
 */
export function hasValidGlobalMp4Sidx(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return false;
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 32) return false;

    const hdr = new Uint8Array(16);
    const hdrView = new DataView(hdr.buffer);

    let offset = 0;
    let walkedBoxes = 0;
    let sawMoov = false;
    let sidxCount = 0;
    let sidxOffset = -1;
    let sidxSize = 0;
    let sidxHeaderSize = 8;
    const fragments: Array<{ start: number; moofStart: number; end: number; hasMdat: boolean }> = [];
    let pendingStypStart: number | null = null;
    let lastMediaBoxEnd = 0;

    while (offset + 8 <= fileSize) {
      if (++walkedBoxes > MAX_MP4_TOP_LEVEL_BOXES) {
        return false;
      }
      const toRead = Math.min(16, fileSize - offset);
      const n = fs.readSync(fd, hdr, 0, toRead, offset);
      if (n < 8) return false;

      let size = hdrView.getUint32(0, false);
      const type = String.fromCharCode(hdr[4]!, hdr[5]!, hdr[6]!, hdr[7]!);
      let headerSize = 8;

      if (size === 1) {
        if (n < 16) return false;
        const hi = hdrView.getUint32(8, false);
        const lo = hdrView.getUint32(12, false);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }

      if (!Number.isFinite(size) || size < headerSize || offset + size > fileSize) {
        return false;
      }

      const boxEnd = offset + size;

      if (type === "moov") {
        if (fragments.length > 0) return false;
        sawMoov = true;
      } else if (type === "sidx") {
        sidxCount++;
        // Must have exactly one global sidx after moov and before any media fragments
        if (sidxCount > 1 || !sawMoov || fragments.length > 0 || lastMediaBoxEnd > 0) {
          return false;
        }
        sidxOffset = offset;
        sidxSize = size;
        sidxHeaderSize = headerSize;
        pendingStypStart = null;
      } else if (type === "styp") {
        if (sidxCount === 1) {
          pendingStypStart = offset;
        }
      } else if (type === "moof") {
        const fragStart = pendingStypStart !== null ? pendingStypStart : offset;
        fragments.push({ start: fragStart, moofStart: offset, end: boxEnd, hasMdat: false });
        pendingStypStart = null;
        lastMediaBoxEnd = boxEnd;
      } else if (type === "mdat") {
        // Unfragmented mdat before any moof is invalid for fragmented global-sidx DASH
        if (fragments.length === 0) return false;
        const curFrag = fragments[fragments.length - 1]!;
        curFrag.hasMdat = true;
        curFrag.end = boxEnd;
        pendingStypStart = null;
        lastMediaBoxEnd = boxEnd;
      } else {
        pendingStypStart = null;
      }

      offset = boxEnd;
    }

    if (!sawMoov || sidxCount !== 1 || fragments.length < 1 || sidxOffset < 0) {
      return false;
    }
    // Every fragment in the media section must contain media payload (mdat)
    const validBoundaries = new Set<number>();
    for (const frag of fragments) {
      if (!frag.hasMdat) return false;
      validBoundaries.add(frag.start);
      validBoundaries.add(frag.moofStart);
      validBoundaries.add(frag.end);
    }
    validBoundaries.add(lastMediaBoxEnd);

    if (sidxSize > MAX_SIDX_BOX_BYTES || sidxSize < sidxHeaderSize + 24) {
      return false;
    }

    const sidxBuf = new Uint8Array(sidxSize);
    const readSidx = fs.readSync(fd, sidxBuf, 0, sidxSize, sidxOffset);
    if (readSidx < sidxSize) return false;

    const view = new DataView(sidxBuf.buffer);
    const body = sidxHeaderSize;
    const version = sidxBuf[body]!;
    if (version !== 0 && version !== 1) return false;

    const timescale = view.getUint32(body + 8, false);
    if (timescale === 0) return false;

    let firstOffset: number;
    let refCountPos: number;
    if (version === 0) {
      if (body + 24 > sidxSize) return false;
      firstOffset = view.getUint32(body + 16, false);
      refCountPos = body + 22;
    } else {
      if (body + 32 > sidxSize) return false;
      const hi = view.getUint32(body + 20, false);
      const lo = view.getUint32(body + 24, false);
      firstOffset = hi * 0x100000000 + lo;
      refCountPos = body + 30;
    }

    const referenceCount = view.getUint16(refCountPos, false);
    const entriesStart = refCountPos + 2;
    if (referenceCount < 1 || entriesStart + referenceCount * 12 > sidxSize) {
      return false;
    }

    const sidxEnd = sidxOffset + sidxSize;
    let cursor = sidxEnd + firstOffset;
    const firstFrag = fragments[0]!;
    // First reference MUST start at the very first fragment (never skip fragment 1)
    if (cursor !== firstFrag.start && cursor !== firstFrag.moofStart) {
      return false;
    }

    let fragIdx = 0;
    for (let i = 0; i < referenceCount; i++) {
      const entryOffset = entriesStart + i * 12;
      const refWord = view.getUint32(entryOffset, false);
      const referenceType = (refWord >>> 31) & 1;
      // Single-range SegmentBase requires direct media references (reference_type === 0)
      if (referenceType !== 0) return false;
      const referencedSize = refWord & 0x7fffffff;
      const subsegmentDuration = view.getUint32(entryOffset + 4, false);
      if (referencedSize === 0 || subsegmentDuration === 0) return false;
      const refStart = cursor;
      if (!validBoundaries.has(refStart)) return false;
      cursor += referencedSize;
      if (cursor > fileSize || !validBoundaries.has(cursor)) {
        return false;
      }
      const refEnd = cursor;
      // Every sidx reference MUST cover at least one complete media fragment (reject pure padding/free refs)
      let coveredFrags = 0;
      while (fragIdx < fragments.length) {
        const f = fragments[fragIdx]!;
        if (f.end <= refStart) {
          fragIdx++;
          continue;
        }
        if ((f.start >= refStart || f.moofStart >= refStart) && f.end <= refEnd) {
          coveredFrags++;
          fragIdx++;
          continue;
        }
        break;
      }
      if (coveredFrags === 0) return false;
    }

    return cursor === lastMediaBoxEnd && fragIdx === fragments.length;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function readMp4BoxHeader(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  limit: number,
): { type: string; size: number; headerSize: number; end: number } | null {
  if (offset + 8 > limit) return null;
  let size = view.getUint32(offset, false);
  const type = String.fromCharCode(
    buf[offset + 4]!,
    buf[offset + 5]!,
    buf[offset + 6]!,
    buf[offset + 7]!,
  );
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const hi = view.getUint32(offset + 8, false);
    const lo = view.getUint32(offset + 12, false);
    size = hi * 0x100000000 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (!Number.isFinite(size) || size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, end: offset + size };
}

function findChildBox(
  buf: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  targetType: string,
): { type: string; size: number; headerSize: number; offset: number; bodyStart: number; end: number } | null {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readMp4BoxHeader(buf, view, pos, end);
    if (!box) break;
    if (box.type === targetType) {
      return { ...box, offset: pos, bodyStart: pos + box.headerSize };
    }
    pos = box.end;
  }
  return null;
}

function parseSampleEntryCodec(buf: Uint8Array, view: DataView, stsdBodyStart: number, stsdEnd: number): string | undefined {
  // FullBox: version(1) + flags(3) + entry_count(4)
  if (stsdBodyStart + 8 > stsdEnd) return undefined;
  const entryCount = view.getUint32(stsdBodyStart + 4, false);
  if (entryCount < 1) return undefined;
  const entryStart = stsdBodyStart + 8;
  const entry = readMp4BoxHeader(buf, view, entryStart, stsdEnd);
  if (!entry) return undefined;

  const fourcc = entry.type;
  const hex2 = (n: number) => n.toString(16).padStart(2, "0");
  const dec2 = (n: number) => String(n).padStart(2, "0");

  if (fourcc === "avc1" || fourcc === "avc3") {
    const childStart = entryStart + 86; // 8 hdr + 78 VisualSampleEntry fields
    if (childStart < entry.end) {
      const avcc = findChildBox(buf, view, childStart, entry.end, "avcC");
      if (avcc && avcc.bodyStart + 4 <= avcc.end) {
        const p = buf[avcc.bodyStart + 1]!;
        const c = buf[avcc.bodyStart + 2]!;
        const l = buf[avcc.bodyStart + 3]!;
        return `${fourcc}.${hex2(p)}${hex2(c)}${hex2(l)}`;
      }
    }
    return "avc1.640028";
  }

  if (fourcc === "vp09") {
    const childStart = entryStart + 86;
    if (childStart < entry.end) {
      const vpcc = findChildBox(buf, view, childStart, entry.end, "vpcC");
      if (vpcc && vpcc.bodyStart + 7 <= vpcc.end) {
        const profile = buf[vpcc.bodyStart + 4]!;
        const level = buf[vpcc.bodyStart + 5]!;
        const bitDepth = (buf[vpcc.bodyStart + 6]! >> 4) & 0x0f;
        return `vp09.${dec2(profile)}.${dec2(level)}.${dec2(bitDepth || 8)}`;
      }
    }
    return "vp09.00.10.08";
  }

  if (fourcc === "av01") {
    const childStart = entryStart + 86;
    if (childStart < entry.end) {
      const av1c = findChildBox(buf, view, childStart, entry.end, "av1C");
      if (av1c && av1c.bodyStart + 3 <= av1c.end) {
        const b1 = buf[av1c.bodyStart + 1]!;
        const b2 = buf[av1c.bodyStart + 2]!;
        const profile = (b1 >> 5) & 0x07;
        const level = b1 & 0x1f;
        const tier = (b2 >> 7) & 1 ? "H" : "M";
        const highBit = (b2 >> 6) & 1;
        const twelveBit = (b2 >> 5) & 1;
        const bitDepth = highBit ? (twelveBit ? 12 : 10) : 8;
        return `av01.${profile}.${dec2(level)}${tier}.${dec2(bitDepth)}`;
      }
    }
    return "av01.0.04M.08";
  }

  if (fourcc === "mp4a") {
    // Parse exact MPEG-4 audioObjectType from `esds` (AudioSampleEntry fixed size = 36, or 52 for QT v1)
    // instead of guessing AAC-LC ("mp4a.40.2") which would clobber HE-AAC ("mp4a.40.5").
    const readDescLen = (pos: number, limit: number): { len: number; next: number } | null => {
      let len = 0;
      let i = 0;
      while (i < 4 && pos + i < limit) {
        const b = buf[pos + i]!;
        len = (len << 7) | (b & 0x7f);
        i++;
        if ((b & 0x80) === 0) return { len, next: pos + i };
      }
      return null;
    };
    const esds =
      (entryStart + 36 < entry.end ? findChildBox(buf, view, entryStart + 36, entry.end, "esds") : null) ||
      (entryStart + 52 < entry.end ? findChildBox(buf, view, entryStart + 52, entry.end, "esds") : null);
    if (esds && esds.bodyStart + 8 <= esds.end) {
      let pos = esds.bodyStart + 4; // skip FullBox version(1) + flags(3)
      const limit = esds.end;
      if (pos < limit && buf[pos] === 0x03) {
        const esLen = readDescLen(pos + 1, limit);
        if (esLen) {
          pos = esLen.next;
          if (pos + 3 <= limit) {
            const flags = buf[pos + 2]!;
            pos += 3; // ES_ID(2) + flags(1)
            if (flags & 0x80) pos += 2;
            if (flags & 0x40 && pos < limit) pos += 1 + buf[pos]!;
            if (flags & 0x20) pos += 2;
          }
        }
      }
      if (pos < limit && buf[pos] === 0x04) {
        const dcLen = readDescLen(pos + 1, limit);
        if (dcLen && dcLen.next + 13 <= limit) {
          const objectTypeIndication = buf[dcLen.next]!;
          pos = dcLen.next + 13;
          if (objectTypeIndication === 0x40) {
            if (pos < limit && buf[pos] === 0x05) {
              const dsiLen = readDescLen(pos + 1, limit);
              if (dsiLen && dsiLen.next < limit) {
                let aot = (buf[dsiLen.next]! >> 3) & 0x1f;
                if (aot === 31 && dsiLen.next + 1 < limit) {
                  aot = 32 + (((buf[dsiLen.next]! & 0x07) << 3) | ((buf[dsiLen.next + 1]! >> 5) & 0x07));
                }
                if (aot > 0) return `mp4a.40.${aot}`;
              }
            }
            return undefined;
          }
          if (objectTypeIndication > 0) {
            return `mp4a.${hex2(objectTypeIndication)}`;
          }
        }
      }
    }
    return undefined;
  }
  if (fourcc === "Opus") {
    return "opus";
  }
  if (fourcc === "hev1" || fourcc === "hvc1" || fourcc === "ac-3" || fourcc === "ec-3") {
    return fourcc;
  }
  return undefined;
}

/**
 * Inspect top-level `moov` (and `sidx` fallback duration) of an MP4/M4A file on disk
 * to extract exact codec string, video dimensions, handler type, and duration without
 * spawning external `ffprobe`.
 */
export function probeMp4TrackMetadata(filePath: string): ProbedMp4TrackMetadata | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 24) return null;

    const hdr = new Uint8Array(16);
    const hdrView = new DataView(hdr.buffer);

    let offset = 0;
    let moovOffset = -1;
    let moovSize = 0;
    let moovHeaderSize = 8;
    let sidxOffset = -1;
    let sidxSize = 0;
    let sidxHeaderSize = 8;

    while (offset + 8 <= fileSize) {
      const toRead = Math.min(16, fileSize - offset);
      const n = fs.readSync(fd, hdr, 0, toRead, offset);
      if (n < 8) break;
      let size = hdrView.getUint32(0, false);
      const type = String.fromCharCode(hdr[4]!, hdr[5]!, hdr[6]!, hdr[7]!);
      let headerSize = 8;
      if (size === 1) {
        if (n < 16) break;
        size = hdrView.getUint32(8, false) * 0x100000000 + hdrView.getUint32(12, false);
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (!Number.isFinite(size) || size < headerSize || offset + size > fileSize) break;
      if (type === "moov" && moovOffset < 0) {
        moovOffset = offset;
        moovSize = size;
        moovHeaderSize = headerSize;
      } else if (type === "sidx" && sidxOffset < 0) {
        sidxOffset = offset;
        sidxSize = size;
        sidxHeaderSize = headerSize;
      } else if ((type === "moof" || type === "mdat") && moovOffset >= 0) {
        break;
      }
      offset += size;
    }

    if (moovOffset < 0 || moovSize <= moovHeaderSize || moovSize > 4 * 1024 * 1024) {
      return null;
    }

    const moovBuf = new Uint8Array(moovSize);
    if (fs.readSync(fd, moovBuf, 0, moovSize, moovOffset) < moovSize) {
      return null;
    }
    const view = new DataView(moovBuf.buffer);
    const moovBodyStart = moovHeaderSize;
    const moovEnd = moovSize;

    const meta: ProbedMp4TrackMetadata = {};

    // 1. mvhd duration & timescale
    let mvhdTimescale = 0;
    const mvhd = findChildBox(moovBuf, view, moovBodyStart, moovEnd, "mvhd");
    if (mvhd && mvhd.bodyStart + 20 <= mvhd.end) {
      const ver = moovBuf[mvhd.bodyStart]!;
      let dur = 0;
      if (ver === 0 && mvhd.bodyStart + 20 <= mvhd.end) {
        mvhdTimescale = view.getUint32(mvhd.bodyStart + 12, false);
        dur = view.getUint32(mvhd.bodyStart + 16, false);
      } else if (ver === 1 && mvhd.bodyStart + 32 <= mvhd.end) {
        mvhdTimescale = view.getUint32(mvhd.bodyStart + 20, false);
        dur = view.getUint32(mvhd.bodyStart + 24, false) * 0x100000000 + view.getUint32(mvhd.bodyStart + 28, false);
      }
      if (mvhdTimescale > 0 && dur > 0) {
        meta.durationSec = dur / mvhdTimescale;
      }
    }

    // 2. mvex -> mehd fragment duration if mvhd duration was 0 (empty_moov)
    if (!meta.durationSec && mvhdTimescale > 0) {
      const mvex = findChildBox(moovBuf, view, moovBodyStart, moovEnd, "mvex");
      if (mvex) {
        const mehd = findChildBox(moovBuf, view, mvex.bodyStart, mvex.end, "mehd");
        if (mehd && mehd.bodyStart + 8 <= mehd.end) {
          const ver = moovBuf[mehd.bodyStart]!;
          const fragDur =
            ver === 1 && mehd.bodyStart + 12 <= mehd.end
              ? view.getUint32(mehd.bodyStart + 4, false) * 0x100000000 + view.getUint32(mehd.bodyStart + 8, false)
              : view.getUint32(mehd.bodyStart + 4, false);
          if (fragDur > 0) {
            meta.durationSec = fragDur / mvhdTimescale;
          }
        }
      }
    }

    // 3. sidx subsegment duration sum if still 0 (common with +empty_moov+global_sidx)
    if (!meta.durationSec && sidxOffset >= 0 && sidxSize > sidxHeaderSize + 24 && sidxSize <= MAX_SIDX_BOX_BYTES) {
      const sidxBuf = new Uint8Array(sidxSize);
      if (fs.readSync(fd, sidxBuf, 0, sidxSize, sidxOffset) === sidxSize) {
        const sv = new DataView(sidxBuf.buffer);
        const sb = sidxHeaderSize;
        const ver = sidxBuf[sb]!;
        const ts = sv.getUint32(sb + 8, false);
        const refCountPos = ver === 0 ? sb + 22 : sb + 30;
        if (ts > 0 && refCountPos + 2 <= sidxSize) {
          const refCount = sv.getUint16(refCountPos, false);
          const entriesStart = refCountPos + 2;
          if (entriesStart + refCount * 12 <= sidxSize) {
            let totalSubDur = 0;
            for (let i = 0; i < refCount; i++) {
              totalSubDur += sv.getUint32(entriesStart + i * 12 + 4, false);
            }
            if (totalSubDur > 0) {
              meta.durationSec = totalSubDur / ts;
            }
          }
        }
      }
    }

    // 4. First trak: tkhd (width/height), mdia/hdlr (vide/soun), mdia/minf/stbl/stsd (codec)
    const trak = findChildBox(moovBuf, view, moovBodyStart, moovEnd, "trak");
    if (trak) {
      const tkhd = findChildBox(moovBuf, view, trak.bodyStart, trak.end, "tkhd");
      if (tkhd && tkhd.bodyStart + 84 <= tkhd.end) {
        const ver = moovBuf[tkhd.bodyStart]!;
        const dimOff = ver === 1 ? tkhd.bodyStart + 88 : tkhd.bodyStart + 76;
        if (dimOff + 8 <= tkhd.end) {
          const w = Math.round(view.getUint32(dimOff, false) / 65536);
          const h = Math.round(view.getUint32(dimOff + 4, false) / 65536);
          if (w > 0 && h > 0) {
            meta.width = w;
            meta.height = h;
          }
        }
      }
      const mdia = findChildBox(moovBuf, view, trak.bodyStart, trak.end, "mdia");
      if (mdia) {
        const hdlr = findChildBox(moovBuf, view, mdia.bodyStart, mdia.end, "hdlr");
        if (hdlr && hdlr.bodyStart + 12 <= hdlr.end) {
          const handler = String.fromCharCode(
            moovBuf[hdlr.bodyStart + 8]!,
            moovBuf[hdlr.bodyStart + 9]!,
            moovBuf[hdlr.bodyStart + 10]!,
            moovBuf[hdlr.bodyStart + 11]!,
          );
          if (handler === "vide") meta.isVideo = true;
          else if (handler === "soun") meta.isAudio = true;
        }
        const minf = findChildBox(moovBuf, view, mdia.bodyStart, mdia.end, "minf");
        const stbl = minf ? findChildBox(moovBuf, view, minf.bodyStart, minf.end, "stbl") : null;
        const stsd = stbl ? findChildBox(moovBuf, view, stbl.bodyStart, stbl.end, "stsd") : null;
        if (stsd) {
          meta.codec = parseSampleEntryCodec(moovBuf, view, stsd.bodyStart, stsd.end);
        }
      }
    }

    if (
      meta.codec === undefined &&
      meta.width === undefined &&
      meta.height === undefined &&
      meta.durationSec === undefined
    ) {
      return null;
    }
    return meta;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// EBML element IDs for WebM/Matroska
const EBML_ID_HEADER = 0x1a45dfa3;
const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_SEEK_HEAD = 0x114d9b74;
const EBML_ID_SEEK = 0x4dbb;
const EBML_ID_SEEK_ID = 0x53ab;
const EBML_ID_SEEK_POSITION = 0x53ac;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_TRACKS = 0x1654ae6b;
const EBML_ID_CUES = 0x1c53bb6b;
const EBML_ID_CLUSTER = 0x1f43b675;

function readVint(
  buf: Uint8Array,
  offset: number,
  keepMarkerBit: boolean,
): { value: number; length: number; isUnknown: boolean } | null {
  if (offset >= buf.byteLength) return null;
  const first = buf[offset]!;
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.byteLength) return null;

  const firstVal = keepMarkerBit ? first : first & (mask - 1);
  let value = firstVal;
  let allOnes = !keepMarkerBit && firstVal === mask - 1;

  for (let i = 1; i < length; i++) {
    const b = buf[offset + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }

  return { value, length, isUnknown: allOnes };
}

function readUintBE(buf: Uint8Array, offset: number, length: number): number {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = val * 256 + buf[offset + i]!;
  }
  return val;
}

function findCuesPositionInSeekHead(buf: Uint8Array, start: number, end: number): number | null {
  let pos = start;
  const limit = Math.min(end, buf.byteLength);

  while (pos < limit) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    const size = readVint(buf, pos + id.length, false);
    if (!size) break;
    const dataStart = pos + id.length + size.length;
    const elemEnd = size.isUnknown ? limit : Math.min(dataStart + size.value, limit);

    if (id.value === EBML_ID_SEEK) {
      let seekPos = dataStart;
      let targetId: number | null = null;
      let targetOffset: number | null = null;

      while (seekPos < elemEnd) {
        const subId = readVint(buf, seekPos, true);
        if (!subId) break;
        const subSize = readVint(buf, seekPos + subId.length, false);
        if (!subSize) break;
        const subData = seekPos + subId.length + subSize.length;
        const subEnd = subData + subSize.value;
        if (subEnd > elemEnd) break;

        if (subId.value === EBML_ID_SEEK_ID && subSize.value <= 4) {
          targetId = readUintBE(buf, subData, subSize.value);
        } else if (subId.value === EBML_ID_SEEK_POSITION && subSize.value <= 8) {
          targetOffset = readUintBE(buf, subData, subSize.value);
        }
        seekPos = subEnd;
      }

      if (targetId === EBML_ID_CUES && targetOffset !== null) {
        return targetOffset;
      }
    }

    if (elemEnd <= pos) break;
    pos = elemEnd;
  }
  return null;
}

export interface WebmProbeResult {
  ranges: DashByteRanges | null;
  /** If Cues is located outside the initial buffer, absolute byte offset to probe its header */
  cuesOffset?: number;
  initEnd?: number;
}

/**
 * Parse WebM/Matroska EBML header, Segment, Tracks, and Cues to extract
 * DASH `initRange` and `indexRange`.
 */
export function parseWebmDashRanges(buf: Uint8Array): WebmProbeResult {
  let pos = 0;

  // 1. EBML header
  const ebmlId = readVint(buf, pos, true);
  if (!ebmlId || ebmlId.value !== EBML_ID_HEADER) return { ranges: null };
  const ebmlSize = readVint(buf, pos + ebmlId.length, false);
  if (!ebmlSize || ebmlSize.isUnknown) return { ranges: null };
  pos = pos + ebmlId.length + ebmlSize.length + ebmlSize.value;

  // 2. Segment element
  const segId = readVint(buf, pos, true);
  if (!segId || segId.value !== EBML_ID_SEGMENT) return { ranges: null };
  const segSize = readVint(buf, pos + segId.length, false);
  if (!segSize) return { ranges: null };
  const segmentDataStart = pos + segId.length + segSize.length;
  pos = segmentDataStart;

  let initEnd: number | null = null;
  let cuesStart: number | null = null;
  let cuesEnd: number | null = null;
  let seekHeadCuesRel: number | null = null;

  while (pos < buf.byteLength) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    const size = readVint(buf, pos + id.length, false);
    if (!size) break;

    const dataStart = pos + id.length + size.length;
    const elemEnd = size.isUnknown ? buf.byteLength : dataStart + size.value;

    if (id.value === EBML_ID_SEEK_HEAD && elemEnd <= buf.byteLength) {
      seekHeadCuesRel = findCuesPositionInSeekHead(buf, dataStart, elemEnd);
    } else if (id.value === EBML_ID_INFO || id.value === EBML_ID_TRACKS) {
      initEnd = elemEnd - 1;
    } else if (id.value === EBML_ID_CUES) {
      cuesStart = pos;
      cuesEnd = elemEnd - 1;
      if (initEnd === null) {
        initEnd = pos - 1;
      }
      break;
    } else if (id.value === EBML_ID_CLUSTER) {
      if (initEnd === null) {
        initEnd = pos - 1;
      }
      break;
    }

    if (elemEnd > buf.byteLength || elemEnd <= pos) break;
    pos = elemEnd;
  }

  if (initEnd !== null && cuesStart !== null && cuesEnd !== null && cuesEnd >= cuesStart) {
    return {
      ranges: {
        init: `0-${initEnd}`,
        index: `${cuesStart}-${cuesEnd}`,
        initStart: 0,
        initEnd,
        indexStart: cuesStart,
        indexEnd: cuesEnd,
      },
    };
  }

  if (initEnd !== null && seekHeadCuesRel !== null) {
    return {
      ranges: null,
      cuesOffset: segmentDataStart + seekHeadCuesRel,
      initEnd,
    };
  }

  if (initEnd !== null) {
    return {
      ranges: null,
      initEnd,
    };
  }

  return { ranges: null };
}

export function parseCuesElementHeaderAt(
  buf: Uint8Array,
  cuesOffset: number,
  initEnd: number,
): DashByteRanges | null {
  const id = readVint(buf, 0, true);
  if (!id || id.value !== EBML_ID_CUES) return null;
  const size = readVint(buf, id.length, false);
  if (!size || size.isUnknown) return null;
  const indexStart = cuesOffset;
  const indexEnd = cuesOffset + id.length + size.length + size.value - 1;
  if (indexEnd < indexStart) return null;
  return {
    init: `0-${initEnd}`,
    index: `${indexStart}-${indexEnd}`,
    initStart: 0,
    initEnd,
    indexStart,
    indexEnd,
  };
}

/**
 * Probe DASH init/index byte ranges from a local file on disk (used for Tier 3 ephemeral buffers).
 */
export function probeLocalFileDashRanges(
  filePath: string,
  mimeType: string,
  maxHeaderReadBytes = 65536,
  knownCuesOffset?: number,
): DashByteRanges | null {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const cap = Math.max(65536, Math.min(maxHeaderReadBytes, MAX_DASH_HEADER_PROBE_BYTES));
    const readLen = Math.min(stat.size, cap);
    if (readLen < 16) return null;
    const buf = new Uint8Array(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);

    if (mimeType.includes("webm")) {
      const parsed = parseWebmDashRanges(buf);
      if (parsed.ranges) {
        return parsed.ranges.indexEnd < stat.size ? parsed.ranges : null;
      }
      const cuesOffset = parsed.cuesOffset ?? knownCuesOffset;
      if (cuesOffset !== undefined && parsed.initEnd !== undefined && cuesOffset >= 0 && cuesOffset < stat.size) {
        const hdrBuf = new Uint8Array(Math.min(32, stat.size - cuesOffset));
        fs.readSync(fd, hdrBuf, 0, hdrBuf.byteLength, cuesOffset);
        const resolved = parseCuesElementHeaderAt(hdrBuf, cuesOffset, parsed.initEnd);
        if (resolved && resolved.indexEnd < stat.size) {
          return resolved;
        }
      }
      return null;
    }

    const mp4 = parseMp4DashRanges(buf);
    return mp4 && mp4.indexEnd < stat.size ? mp4 : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function hasDisallowedContentEncoding(res: Response): boolean {
  const ce = (res.headers.get("content-encoding") || "").trim().toLowerCase();
  return ce.length > 0 && ce !== "identity";
}

function parseStrictPartialContentRange(
  header: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === "*" ? null : Number(m[3]);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    (total !== null && (!Number.isFinite(total) || end >= total))
  ) {
    return null;
  }
  return { start, end, total };
}

/**
 * Probe DASH init/index byte ranges from an upstream HTTP(S) URL over IPv4
 * using a strictly bounded byte-range GET (bytes=0-16383).
 */
export async function probeRemoteDashRanges(
  url: string,
  mimeType: string,
  fetchFn: FetchLike,
  extraHeaders?: Record<string, string>,
): Promise<DashByteRanges | null> {
  const MAX_HEADER_PROBE = 16384;
  const headers: Record<string, string> = {
    ...(extraHeaders || {}),
    Range: `bytes=0-${MAX_HEADER_PROBE - 1}`,
    "Accept-Encoding": "identity",
  };

  const res = await fetchFn(url, {
    method: "GET",
    headers,
    timeoutMs: 8_000,
    signal: AbortSignal.timeout(8_000),
    httpsOnly: true,
    publicIpv4Only: true,
    allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
  });

  // Only parse partial responses (or bounded byte 0 prefix); reject compressed raw bodies
  if ((res.status !== 206 && res.status !== 200) || hasDisallowedContentEncoding(res)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  let validPrefixEnd: number | null = null;
  if (res.status === 206) {
    const cr = parseStrictPartialContentRange(res.headers.get("content-range"));
    if (!cr || cr.start !== 0) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const cl = res.headers.get("content-length");
    const expectedLen = cr.end - cr.start + 1;
    if (cl !== null && (!/^\d+$/.test(cl.trim()) || Number(cl.trim()) !== expectedLen)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    validPrefixEnd = cr.end;
  }

  const buf = await readBoundedBytes(res, MAX_HEADER_PROBE);
  if (buf.byteLength < 16) return null;
  if (validPrefixEnd !== null && buf.byteLength !== Math.min(MAX_HEADER_PROBE, validPrefixEnd + 1)) {
    return null;
  }

  const attachHashes = (ranges: DashByteRanges | null): DashByteRanges | null => {
    if (!ranges) return null;
    if (ranges.initEnd < buf.byteLength) {
      ranges.initHash = sha256Hex(buf.subarray(ranges.initStart, ranges.initEnd + 1));
    }
    if (ranges.indexEnd < buf.byteLength) {
      ranges.indexHash = sha256Hex(buf.subarray(ranges.indexStart, ranges.indexEnd + 1));
    }
    return ranges;
  };

  if (mimeType.includes("webm")) {
    const parsed = parseWebmDashRanges(buf);
    if (parsed.ranges) return attachHashes(parsed.ranges);
    if (parsed.cuesOffset !== undefined && parsed.initEnd !== undefined) {
      const cuesRes = await fetchFn(url, {
        method: "GET",
        headers: {
          ...(extraHeaders || {}),
          Range: `bytes=${parsed.cuesOffset}-${parsed.cuesOffset + 31}`,
          "Accept-Encoding": "identity",
        },
        timeoutMs: 8_000,
        signal: AbortSignal.timeout(8_000),
        httpsOnly: true,
        publicIpv4Only: true,
        allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
      });
      if (cuesRes.status === 206 && !hasDisallowedContentEncoding(cuesRes)) {
        const cr = parseStrictPartialContentRange(cuesRes.headers.get("content-range"));
        const rawCl = cuesRes.headers.get("content-length");
        const expectedLen = cr ? cr.end - cr.start + 1 : 0;
        const clOk = rawCl === null || (/^\d+$/.test(rawCl.trim()) && Number(rawCl.trim()) === expectedLen);
        if (cr && cr.start === parsed.cuesOffset && clOk) {
          const hdrBuf = await readBoundedBytes(cuesRes, 32);
          if (hdrBuf.byteLength === Math.min(32, expectedLen)) {
            return attachHashes(parseCuesElementHeaderAt(hdrBuf, parsed.cuesOffset, parsed.initEnd));
          }
          return null;
        }
      }
      await cuesRes.body?.cancel().catch(() => {});
    }
    return null;
  }

  return attachHashes(parseMp4DashRanges(buf));
}

/**
 * Fetch bounded byte ranges for `init` and/or `index` from a candidate remote URL
 * over IPv4 and verify their SHA-256 digests match the already-verified digests of
 * the active playback representation before accepting a remote recovery replacement.
 */
export async function verifyRemoteDashRangeDigests(
  url: string,
  expected: {
    initRange?: { start: number; end: number };
    indexRange?: { start: number; end: number };
    initHash?: string;
    indexHash?: string;
    expectedTotal?: number;
  },
  fetchFn: FetchLike,
  extraHeaders?: Record<string, string>,
): Promise<{ initHash?: string; indexHash?: string } | null> {
  const fetchExactRangeHash = async (start: number, end: number): Promise<string | null> => {
    const len = end - start + 1;
    if (len <= 0 || len > MAX_DASH_HEADER_PROBE_BYTES) return null;
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        ...(extraHeaders || {}),
        Range: `bytes=${start}-${end}`,
        "Accept-Encoding": "identity",
      },
      timeoutMs: 8_000,
      signal: AbortSignal.timeout(8_000),
      httpsOnly: true,
      publicIpv4Only: true,
      allowedHost: (h) => ALLOWED_GOOGLEVIDEO_HOST.test(h),
    });
    if (res.status !== 206 || hasDisallowedContentEncoding(res)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const parsedCr = parseStrictPartialContentRange(res.headers.get("content-range"));
    if (!parsedCr || parsedCr.start !== start || parsedCr.end !== end) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const rawCl = res.headers.get("content-length");
    if (rawCl !== null && (!/^\d+$/.test(rawCl.trim()) || Number(rawCl.trim()) !== len)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (
      expected.expectedTotal &&
      expected.expectedTotal > 0 &&
      (parsedCr.total === null || parsedCr.total !== expected.expectedTotal)
    ) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readBoundedBytes(res, len + 1);
    if (bytes.byteLength !== len) return null;
    return sha256Hex(bytes);
  };

  if (!expected.initHash && !expected.indexHash) {
    return null;
  }

  let initHash: string | undefined;
  let indexHash: string | undefined;

  if (expected.initHash) {
    if (!expected.initRange) return null;
    const actual = await fetchExactRangeHash(expected.initRange.start, expected.initRange.end);
    if (!actual || actual !== expected.initHash) return null;
    initHash = actual;
  }
  if (expected.indexHash) {
    if (!expected.indexRange) return null;
    const actual = await fetchExactRangeHash(expected.indexRange.start, expected.indexRange.end);
    if (!actual || actual !== expected.indexHash) return null;
    indexHash = actual;
  }

  return { initHash, indexHash };
}
