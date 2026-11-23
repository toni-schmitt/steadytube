import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeFileRangeSha256,
  hasValidGlobalMp4Sidx,
  parseCuesElementHeaderAt,
  parseMp4DashRanges,
  parseWebmDashRanges,
  probeLocalFileDashRanges,
  probeMp4TrackMetadata,
  probeRemoteDashRanges,
  sha256Hex,
} from "../src/media/container-probe.ts";
import type { Ipv4FetchOptions } from "../src/net/ipv4-fetch.ts";

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

function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
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

  test("hasValidGlobalMp4Sidx accepts single global sidx and rejects per-fragment or partial sidx", () => {
    const makeSidxBox = (
      refSizes: number[],
      opts?: { version?: 0 | 1; firstOffset?: number; referenceType?: 0 | 1 },
    ): Uint8Array => {
      const version = opts?.version ?? 0;
      const fixedLen = version === 0 ? 24 : 32;
      const total = 8 + fixedLen + refSizes.length * 12;
      const buf = new Uint8Array(total);
      const view = new DataView(buf.buffer);
      view.setUint32(0, total, false);
      buf.set([0x73, 0x69, 0x64, 0x78], 4); // "sidx"
      buf[8] = version;
      view.setUint32(12, 1, false); // reference_ID
      view.setUint32(16, 1000, false); // timescale
      const firstOff = opts?.firstOffset ?? 0;
      let refCountPos: number;
      if (version === 0) {
        view.setUint32(20, 0, false); // earliest_presentation_time
        view.setUint32(24, firstOff, false); // first_offset
        refCountPos = 30;
      } else {
        view.setUint32(28, 0, false);
        view.setUint32(32, firstOff, false);
        refCountPos = 38;
      }
      view.setUint16(refCountPos, refSizes.length, false);
      const refTypeBit = (opts?.referenceType ?? 0) << 31;
      for (let i = 0; i < refSizes.length; i++) {
        const pos = refCountPos + 2 + i * 12;
        view.setUint32(pos, (refTypeBit | (refSizes[i]! & 0x7fffffff)) >>> 0, false);
        view.setUint32(pos + 4, 1000, false);
      }
      return buf;
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-sidx-"));
    try {
      const ftyp = makeMp4Box("ftyp", 16);
      const moov = makeMp4Box("moov", 120);
      const frag1 = concatBytes(makeMp4Box("moof", 40), makeMp4Box("mdat", 100));
      const frag2 = concatBytes(makeMp4Box("moof", 40), makeMp4Box("mdat", 120));

      // Valid global sidx covering both fragments (v0 and v1)
      const validV0Path = path.join(tmpDir, "valid-v0.mp4");
      fs.writeFileSync(
        validV0Path,
        concatBytes(ftyp, moov, makeSidxBox([frag1.byteLength, frag2.byteLength], { version: 0 }), frag1, frag2),
      );
      expect(hasValidGlobalMp4Sidx(validV0Path)).toBe(true);

      const validV1Path = path.join(tmpDir, "valid-v1.mp4");
      fs.writeFileSync(
        validV1Path,
        concatBytes(ftyp, moov, makeSidxBox([frag1.byteLength, frag2.byteLength], { version: 1 }), frag1, frag2),
      );
      expect(hasValidGlobalMp4Sidx(validV1Path)).toBe(true);

      // Per-fragment multi-sidx (FFmpeg without +global_sidx) -> MUST be rejected!
      const perFragPath = path.join(tmpDir, "per-frag.mp4");
      fs.writeFileSync(
        perFragPath,
        concatBytes(
          ftyp,
          moov,
          makeSidxBox([frag1.byteLength]),
          frag1,
          makeSidxBox([frag2.byteLength]),
          frag2,
        ),
      );
      expect(hasValidGlobalMp4Sidx(perFragPath)).toBe(false);

      // Single sidx covering ONLY fragment 1 while fragment 2 follows -> MUST be rejected!
      const partialPath = path.join(tmpDir, "partial.mp4");
      fs.writeFileSync(
        partialPath,
        concatBytes(ftyp, moov, makeSidxBox([frag1.byteLength]), frag1, frag2),
      );
      expect(hasValidGlobalMp4Sidx(partialPath)).toBe(false);

      // Hierarchical reference_type=1 -> MUST be rejected!
      const hierPath = path.join(tmpDir, "hier.mp4");
      fs.writeFileSync(
        hierPath,
        concatBytes(
          ftyp,
          moov,
          makeSidxBox([frag1.byteLength + frag2.byteLength], { referenceType: 1 }),
          frag1,
          frag2,
        ),
      );
      expect(hasValidGlobalMp4Sidx(hierPath)).toBe(false);

      // sidx skipping fragment 1 via firstOffset -> MUST be rejected!
      const skippedFirstPath = path.join(tmpDir, "skip-first.mp4");
      fs.writeFileSync(
        skippedFirstPath,
        concatBytes(
          ftyp,
          moov,
          makeSidxBox([frag2.byteLength], { firstOffset: frag1.byteLength }),
          frag1,
          frag2,
        ),
      );
      expect(hasValidGlobalMp4Sidx(skippedFirstPath)).toBe(false);

      // sidx with shifted reference boundary not landing on moof -> MUST be rejected!
      const shiftedPath = path.join(tmpDir, "shifted.mp4");
      fs.writeFileSync(
        shiftedPath,
        concatBytes(
          ftyp,
          moov,
          makeSidxBox([frag1.byteLength - 10, frag2.byteLength + 10]),
          frag1,
          frag2,
        ),
      );
      expect(hasValidGlobalMp4Sidx(shiftedPath)).toBe(false);

      // Real FFmpeg verification if ffmpeg is installed locally
      const ffmpegBin =
        Bun.which("ffmpeg") ||
        (fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : null);
      if (ffmpegBin) {
        const srcMp4 = path.join(tmpDir, "src.mp4");
        const badRemux = path.join(tmpDir, "bad-remux.mp4");
        const goodRemux = path.join(tmpDir, "good-remux.mp4");

        const gen = Bun.spawnSync([
          ffmpegBin,
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=2.5:size=160x90:rate=10",
          "-g",
          "10",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          srcMp4,
        ]);
        if (gen.exitCode === 0) {
          Bun.spawnSync([
            ffmpegBin,
            "-y",
            "-i",
            srcMp4,
            "-c",
            "copy",
            "-movflags",
            "+dash+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            badRemux,
          ]);
          Bun.spawnSync([
            ffmpegBin,
            "-y",
            "-i",
            srcMp4,
            "-c",
            "copy",
            "-movflags",
            "+dash+global_sidx+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            goodRemux,
          ]);
          expect(hasValidGlobalMp4Sidx(badRemux)).toBe(false);
          expect(hasValidGlobalMp4Sidx(goodRemux)).toBe(true);
          const probedRanges = probeLocalFileDashRanges(goodRemux, "video/mp4");
          expect(probedRanges).not.toBeNull();
          const probedMeta = probeMp4TrackMetadata(goodRemux);
          expect(probedMeta).not.toBeNull();
          expect(probedMeta!.codec).toMatch(/^avc1\./);
          expect(probedMeta!.width).toBe(160);
          expect(probedMeta!.height).toBe(90);
          expect(probedMeta!.durationSec).toBeGreaterThan(2);
          expect(probedMeta!.durationSec).toBeLessThan(3.5);
          // Verify SHA-256 range helper
          const fileBytes = fs.readFileSync(goodRemux);
          expect(computeFileRangeSha256(goodRemux, 0, probedRanges!.initEnd)).toBe(
            sha256Hex(fileBytes.subarray(0, probedRanges!.initEnd + 1)),
          );
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("probeRemoteDashRanges enforces googlevideo HTTPS/public-IPv4/host policy on all fetches", async () => {
    const seenOpts: Ipv4FetchOptions[] = [];
    const ebml = makeEbmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(12));
    const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const seekId = makeEbmlElement([0x53, 0xab], new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]));
    const seekPos = makeEbmlElement([0x53, 0xac], new Uint8Array([0x02, 0x00]));
    const seek = makeEbmlElement([0x4d, 0xbb], concatBytes(seekId, seekPos));
    const seekHead = makeEbmlElement([0x11, 0x4d, 0x9b, 0x74], seek);
    const tracks = makeEbmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array(20));
    const cluster = makeEbmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(10));
    const headerChunk = concatBytes(ebml, segHeader, seekHead, tracks, cluster);
    const cuesHdr = makeEbmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(100));

    let callNum = 0;
    const mockFetch = async (_url: string | URL | Request, init?: Ipv4FetchOptions) => {
      seenOpts.push(init ?? {});
      callNum++;
      if (callNum === 1) {
        return new Response(headerChunk, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headerChunk.byteLength - 1}/2000` },
        });
      }
      const cuesOffset = ebml.byteLength + segHeader.byteLength + 512;
      return new Response(cuesHdr.slice(0, 32), {
        status: 206,
        headers: { "Content-Range": `bytes ${cuesOffset}-${cuesOffset + 31}/2000` },
      });
    };

    const ranges = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251",
      "audio/webm",
      mockFetch,
    );
    expect(ranges).not.toBeNull();
    expect(seenOpts.length).toBe(2);
    for (const opts of seenOpts) {
      expect(opts.httpsOnly).toBe(true);
      expect(opts.publicIpv4Only).toBe(true);
      expect(typeof opts.allowedHost).toBe("function");
      expect(opts.allowedHost!("rr1---sn-test.googlevideo.com")).toBe(true);
      expect(opts.allowedHost!("evil.example.com")).toBe(false);
      expect(opts.allowedHost!("127.0.0.1")).toBe(false);
    }
  });
});
