import fs from "node:fs";
import type { FetchLike } from "../net/ipv4-fetch.ts";

export interface DashByteRanges {
  init: string; // e.g. "0-740"
  index: string; // e.g. "741-1500"
  initStart: number;
  initEnd: number;
  indexStart: number;
  indexEnd: number;
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
): DashByteRanges | null {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const readLen = Math.min(stat.size, 65536);
    if (readLen < 16) return null;
    const buf = new Uint8Array(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);

    if (mimeType.includes("webm")) {
      const parsed = parseWebmDashRanges(buf);
      if (parsed.ranges) return parsed.ranges;
      if (parsed.cuesOffset !== undefined && parsed.initEnd !== undefined && parsed.cuesOffset < stat.size) {
        const hdrBuf = new Uint8Array(Math.min(32, stat.size - parsed.cuesOffset));
        fs.readSync(fd, hdrBuf, 0, hdrBuf.byteLength, parsed.cuesOffset);
        return parseCuesElementHeaderAt(hdrBuf, parsed.cuesOffset, parsed.initEnd);
      }
      return null;
    }

    return parseMp4DashRanges(buf);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Probe DASH init/index byte ranges from an upstream HTTP(S) URL over IPv4
 * using a tiny byte-range GET (bytes=0-16383).
 */
export async function probeRemoteDashRanges(
  url: string,
  mimeType: string,
  fetchFn: FetchLike,
  extraHeaders?: Record<string, string>,
): Promise<DashByteRanges | null> {
  const headers: Record<string, string> = {
    ...(extraHeaders || {}),
    Range: "bytes=0-16383",
    "Accept-Encoding": "identity",
  };

  const res = await fetchFn(url, { method: "GET", headers });
  if (!res.ok && res.status !== 206) {
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 16) return null;

  if (mimeType.includes("webm")) {
    const parsed = parseWebmDashRanges(buf);
    if (parsed.ranges) return parsed.ranges;
    if (parsed.cuesOffset !== undefined && parsed.initEnd !== undefined) {
      const cuesRes = await fetchFn(url, {
        method: "GET",
        headers: {
          ...(extraHeaders || {}),
          Range: `bytes=${parsed.cuesOffset}-${parsed.cuesOffset + 31}`,
          "Accept-Encoding": "identity",
        },
      });
      if (cuesRes.ok || cuesRes.status === 206) {
        const hdrBuf = new Uint8Array(await cuesRes.arrayBuffer());
        return parseCuesElementHeaderAt(hdrBuf, parsed.cuesOffset, parsed.initEnd);
      }
    }
    return null;
  }

  return parseMp4DashRanges(buf);
}
