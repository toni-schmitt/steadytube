import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCuesElementHeaderAt,
  parseMp4DashRanges,
  parseWebmDashRanges,
  probeLocalFileDashRanges,
} from "../src/media/container-probe.ts";

function makeMp4Box(type: string, payloadSize: number): Uint8Array {
  const total = 8 + payloadSize;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, total, false);
  for (let i = 0; i < 4; i++) {
    buf[4 + i] = type.charCodeAt(i);
  }
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function encodeEbmlSize(size: number): Uint8Array {
  if (size < 0x7f) {
    return new Uint8Array([0x80 | size]);
  }
  if (size < 0x3fff) {
    return new Uint8Array([0x40 | (size >> 8), size & 0xff]);
  }
  return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff]);
}

function makeEbmlElement(idBytes: number[], payload: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array(idBytes), encodeEbmlSize(payload.byteLength), payload);
}

describe("container-probe", () => {
  test("parses MP4 ftyp + moov + sidx ranges accurately", () => {
    const ftyp = makeMp4Box("ftyp", 20); // 28 bytes (0..27)
    const moov = makeMp4Box("moov", 700); // 708 bytes (28..735)
    const sidx = makeMp4Box("sidx", 120); // 128 bytes (736..863)
    const moof = makeMp4Box("moof", 64);
    const data = concatBytes(ftyp, moov, sidx, moof);

    const ranges = parseMp4DashRanges(data);
    expect(ranges).not.toBeNull();
    expect(ranges!.init).toBe("0-735");
    expect(ranges!.index).toBe("736-863");
  });

  test("parses MP4 sidx even when sidx body extends past initial probe buffer", () => {
    const ftyp = makeMp4Box("ftyp", 16); // 24 bytes (0..23)
    const moov = makeMp4Box("moov", 600); // 608 bytes (24..631)
    // Declare a 40KB sidx box header, but only include first 16 bytes in the buffer
    const sidxHeader = new Uint8Array(16);
    new DataView(sidxHeader.buffer).setUint32(0, 40960, false);
    sidxHeader.set([0x73, 0x69, 0x64, 0x78], 4); // "sidx"

    const partial = concatBytes(ftyp, moov, sidxHeader);
    const ranges = parseMp4DashRanges(partial);
    expect(ranges).not.toBeNull();
    expect(ranges!.init).toBe("0-631");
    expect(ranges!.index).toBe(`632-${632 + 40960 - 1}`);
  });

  test("parses WebM EBML + Segment + Info + Tracks + inline Cues", () => {
    const ebml = makeEbmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(24));
    const info = makeEbmlElement([0x15, 0x49, 0xa9, 0x66], new Uint8Array(30));
    const tracks = makeEbmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array(50));
    const cues = makeEbmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(80));
    const cluster = makeEbmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(40));

    // Segment with unknown size (0x01ffffffffffffff)
    const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const full = concatBytes(ebml, segHeader, info, tracks, cues, cluster);

    const parsed = parseWebmDashRanges(full);
    expect(parsed.ranges).not.toBeNull();
    const expectedInitEnd = ebml.byteLength + segHeader.byteLength + info.byteLength + tracks.byteLength - 1;
    const expectedCuesStart = expectedInitEnd + 1;
    const expectedCuesEnd = expectedCuesStart + cues.byteLength - 1;
    expect(parsed.ranges!.init).toBe(`0-${expectedInitEnd}`);
    expect(parsed.ranges!.index).toBe(`${expectedCuesStart}-${expectedCuesEnd}`);
  });

  test("extracts Cues offset from SeekHead when Cues is at end of WebM file", () => {
    const ebml = makeEbmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(12));
    const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    // Seek entry pointing to Cues (0x1c53bb6b) at relative segment offset 0x0200 (512)
    const seekId = makeEbmlElement([0x53, 0xab], new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]));
    const seekPos = makeEbmlElement([0x53, 0xac], new Uint8Array([0x02, 0x00]));
    const seek = makeEbmlElement([0x4d, 0xbb], concatBytes(seekId, seekPos));
    const seekHead = makeEbmlElement([0x11, 0x4d, 0x9b, 0x74], seek);
    const tracks = makeEbmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array(20));
    const cluster = makeEbmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(10));

    const headerChunk = concatBytes(ebml, segHeader, seekHead, tracks, cluster);
    const parsed = parseWebmDashRanges(headerChunk);
    expect(parsed.ranges).toBeNull();
    expect(parsed.cuesOffset).toBe(ebml.byteLength + segHeader.byteLength + 512);
    expect(parsed.initEnd).toBe(ebml.byteLength + segHeader.byteLength + seekHead.byteLength + tracks.byteLength - 1);

    // Now simulate probing 16 bytes at cuesOffset
    const cuesHdr = makeEbmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(200));
    const resolved = parseCuesElementHeaderAt(cuesHdr.slice(0, 16), parsed.cuesOffset!, parsed.initEnd!);
    expect(resolved).not.toBeNull();
    expect(resolved!.init).toBe(`0-${parsed.initEnd}`);
    expect(resolved!.index).toBe(`${parsed.cuesOffset}-${parsed.cuesOffset! + cuesHdr.byteLength - 1}`);
  });

  test("probes local MP4 file on disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-probe-"));
    const mp4Path = path.join(tmpDir, "sample.mp4");
    const data = concatBytes(
      makeMp4Box("ftyp", 20),
      makeMp4Box("moov", 200),
      makeMp4Box("sidx", 60),
      makeMp4Box("moof", 100),
    );
    fs.writeFileSync(mp4Path, data);
    try {
      const ranges = probeLocalFileDashRanges(mp4Path, "video/mp4");
      expect(ranges).not.toBeNull();
      expect(ranges!.init).toBe("0-235");
      expect(ranges!.index).toBe("236-303");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
