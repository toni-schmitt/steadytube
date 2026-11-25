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
  verifyRemoteDashRangeDigests,
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

      // sidx with timescale=0 -> MUST be rejected!
      const zeroTsSidx = makeSidxBox([frag1.byteLength, frag2.byteLength]);
      new DataView(zeroTsSidx.buffer).setUint32(16, 0, false);
      const zeroTsPath = path.join(tmpDir, "zero-timescale.mp4");
      fs.writeFileSync(zeroTsPath, concatBytes(ftyp, moov, zeroTsSidx, frag1, frag2));
      expect(hasValidGlobalMp4Sidx(zeroTsPath)).toBe(false);

      // sidx with subsegment_duration=0 -> MUST be rejected!
      const zeroDurSidx = makeSidxBox([frag1.byteLength, frag2.byteLength]);
      new DataView(zeroDurSidx.buffer).setUint32(36, 0, false);
      const zeroDurPath = path.join(tmpDir, "zero-subdur.mp4");
      fs.writeFileSync(zeroDurPath, concatBytes(ftyp, moov, zeroDurSidx, frag1, frag2));
      expect(hasValidGlobalMp4Sidx(zeroDurPath)).toBe(false);

      // Fragment consisting solely of moof without mdat -> MUST be rejected!
      const emptyMoof = makeMp4Box("moof", 40);
      const noMdatPath = path.join(tmpDir, "no-mdat.mp4");
      fs.writeFileSync(
        noMdatPath,
        concatBytes(ftyp, moov, makeSidxBox([emptyMoof.byteLength]), emptyMoof),
      );
      expect(hasValidGlobalMp4Sidx(noMdatPath)).toBe(false);

      // Middle sidx reference covering only a `free` padding box (no media fragment) -> MUST be rejected!
      const freePad = makeMp4Box("free", 32);
      const freeRefPath = path.join(tmpDir, "free-ref.mp4");
      fs.writeFileSync(
        freeRefPath,
        concatBytes(
          ftyp,
          moov,
          makeSidxBox([frag1.byteLength, freePad.byteLength, frag2.byteLength]),
          frag1,
          freePad,
          frag2,
        ),
      );
      expect(hasValidGlobalMp4Sidx(freeRefPath)).toBe(false);

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

    // 206 with missing Content-Range header must be rejected rather than parsed as offset 0
    const noCrRes = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251",
      "audio/webm",
      async () => new Response(headerChunk, { status: 206 }),
    );
    expect(noCrRes).toBeNull();
  });

  test("probeLocalFileDashRanges resolves late WebM Cues via knownCuesOffset when SeekHead is absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-webm-latecues-"));
    try {
      const ebml = makeEbmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(12));
      const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      const tracks = makeEbmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array(24));
      // Large cluster pushes Cues past the 64 KiB header read window, and NO SeekHead is present!
      const cluster = makeEbmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(70_000));
      const cues = makeEbmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(80));
      const full = concatBytes(ebml, segHeader, tracks, cluster, cues);

      const webmPath = path.join(tmpDir, "late-cues.webm");
      fs.writeFileSync(webmPath, full);

      const expectedInitEnd = ebml.byteLength + segHeader.byteLength + tracks.byteLength - 1;
      const expectedCuesStart = ebml.byteLength + segHeader.byteLength + tracks.byteLength + cluster.byteLength;
      const expectedCuesEnd = expectedCuesStart + cues.byteLength - 1;

      // Without knownCuesOffset (and no SeekHead), probing 64 KiB returns null
      expect(probeLocalFileDashRanges(webmPath, "video/webm", 65536)).toBeNull();
      // With knownCuesOffset, probing resolves exact init & index ranges cleanly
      const probed = probeLocalFileDashRanges(webmPath, "video/webm", 65536, expectedCuesStart);
      expect(probed).not.toBeNull();
      expect(probed!.init).toBe(`0-${expectedInitEnd}`);
      expect(probed!.index).toBe(`${expectedCuesStart}-${expectedCuesEnd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("verifyRemoteDashRangeDigests verifies exact byte digests and rejects mismatches or bad totals", async () => {
    const payload = new Uint8Array(300);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = (i * 7 + 3) & 0xff;
    const initSlice = payload.subarray(0, 100);
    const indexSlice = payload.subarray(100, 180);
    const expectedInitHash = sha256Hex(initSlice);
    const expectedIndexHash = sha256Hex(indexSlice);

    const serveSlice = (data: Uint8Array, totalHeader: string) => {
      return async (_url: string | URL | Request, init?: Ipv4FetchOptions) => {
        const range = (init?.headers as Record<string, string> | undefined)?.Range || "";
        const m = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!m) return new Response(null, { status: 400 });
        const s = Number(m[1]);
        const e = Number(m[2]);
        return new Response(data.slice(s, e + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${s}-${e}/${totalHeader}` },
        });
      };
    };

    const ok = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        indexRange: { start: 100, end: 179 },
        initHash: expectedInitHash,
        indexHash: expectedIndexHash,
        expectedTotal: 300,
      },
      serveSlice(payload, "300"),
    );
    expect(ok).toEqual({ initHash: expectedInitHash, indexHash: expectedIndexHash });

    // Mutate one byte inside index range -> MUST reject!
    const mutated = new Uint8Array(payload);
    mutated[120] = (mutated[120] ?? 0) ^ 0xff;
    const badDigest = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        indexRange: { start: 100, end: 179 },
        initHash: expectedInitHash,
        indexHash: expectedIndexHash,
        expectedTotal: 300,
      },
      serveSlice(mutated, "300"),
    );
    expect(badDigest).toBeNull();

    // Wrong total in Content-Range -> MUST reject!
    const badTotal = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        initHash: expectedInitHash,
        expectedTotal: 300,
      },
      serveSlice(payload, "999"),
    );
    expect(badTotal).toBeNull();

    // Non-identity Content-Encoding on 206 -> MUST reject!
    const compressed = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        initHash: expectedInitHash,
        expectedTotal: 300,
      },
      async () =>
        new Response(initSlice, {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-99/300",
            "Content-Encoding": "gzip",
          },
        }),
    );
    expect(compressed).toBeNull();

    // Out-of-bounds Content-Range (end >= total) or mismatched Content-Length -> MUST reject!
    const badBounds = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        initHash: expectedInitHash,
      },
      async () =>
        new Response(initSlice, {
          status: 206,
          headers: { "Content-Range": "bytes 0-99/100" },
        }),
    );
    expect(badBounds).toEqual({ initHash: expectedInitHash, indexHash: undefined });

    const endEqTotal = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        initHash: expectedInitHash,
      },
      async () =>
        new Response(initSlice, {
          status: 206,
          headers: { "Content-Range": "bytes 0-99/99" },
        }),
    );
    expect(endEqTotal).toBeNull();

    const badCl = await verifyRemoteDashRangeDigests(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      {
        initRange: { start: 0, end: 99 },
        initHash: expectedInitHash,
      },
      async () =>
        new Response(initSlice, {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-99/300",
            "Content-Length": "99",
          },
        }),
    );
    expect(badCl).toBeNull();

    // probeRemoteDashRanges also rejects gzip Content-Encoding and mismatched Content-Length
    const mp4Prefix = concatBytes(makeMp4Box("ftyp", 20), makeMp4Box("moov", 200), makeMp4Box("sidx", 60));
    const gzipProbe = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      "video/mp4",
      async () =>
        new Response(mp4Prefix, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${mp4Prefix.byteLength - 1}/2000`,
            "Content-Encoding": "gzip",
          },
        }),
    );
    expect(gzipProbe).toBeNull();

    const badClProbe = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      "video/mp4",
      async () =>
        new Response(mp4Prefix, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${mp4Prefix.byteLength - 1}/2000`,
            "Content-Length": String(mp4Prefix.byteLength + 10),
          },
        }),
    );
    expect(badClProbe).toBeNull();
  });

  test("probeMp4TrackMetadata parses real mp4a esds objectType/AOT and does not guess mp4a.40.2 without esds", () => {
    const makeContainerBox = (type: string, ...children: Uint8Array[]): Uint8Array => {
      const payload = concatBytes(...children);
      const out = new Uint8Array(8 + payload.byteLength);
      new DataView(out.buffer).setUint32(0, out.byteLength, false);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(payload, 8);
      return out;
    };

    const makeMvhd = (timescale: number, duration: number): Uint8Array => {
      const body = new Uint8Array(100);
      const v = new DataView(body.buffer);
      v.setUint32(12, timescale, false);
      v.setUint32(16, duration, false);
      return makeContainerBox("mvhd", body);
    };

    const makeHdlr = (handler: string): Uint8Array => {
      const body = new Uint8Array(24);
      for (let i = 0; i < 4; i++) body[8 + i] = handler.charCodeAt(i);
      return makeContainerBox("hdlr", body);
    };

    const makeEsds = (objectTypeIndication: number, audioObjectType: number): Uint8Array => {
      // FullBox header (4) + ES_Descriptor (0x03) + DecoderConfigDescriptor (0x04) + DecSpecificInfo (0x05)
      const dsi = new Uint8Array([0x05, 0x02, (audioObjectType & 0x1f) << 3, 0x00]);
      const dcHeader = new Uint8Array(13);
      dcHeader[0] = objectTypeIndication;
      const dc = concatBytes(new Uint8Array([0x04, dcHeader.byteLength + dsi.byteLength]), dcHeader, dsi);
      const esHeader = new Uint8Array([0x00, 0x01, 0x00]); // ES_ID=1, flags=0
      const es = concatBytes(new Uint8Array([0x03, esHeader.byteLength + dc.byteLength]), esHeader, dc);
      return makeContainerBox("esds", new Uint8Array(4), es);
    };

    const makeAudioMp4 = (esdsBox?: Uint8Array): Uint8Array => {
      // AudioSampleEntry fixed body = 28 bytes (36 bytes including 8-byte box header)
      const mp4aBody = esdsBox ? concatBytes(new Uint8Array(28), esdsBox) : new Uint8Array(28);
      const mp4a = makeContainerBox("mp4a", mp4aBody);
      const stsdHdr = new Uint8Array(8);
      new DataView(stsdHdr.buffer).setUint32(4, 1, false); // entry_count = 1
      const stsd = makeContainerBox("stsd", stsdHdr, mp4a);
      const stbl = makeContainerBox("stbl", stsd);
      const minf = makeContainerBox("minf", stbl);
      const mdia = makeContainerBox("mdia", makeHdlr("soun"), minf);
      const trak = makeContainerBox("trak", mdia);
      const moov = makeContainerBox("moov", makeMvhd(1000, 12_500), trak);
      return concatBytes(makeMp4Box("ftyp", 16), moov);
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-esds-"));
    try {
      // HE-AAC (objectTypeIndication=0x40, audioObjectType=5) -> mp4a.40.5
      const heAacPath = path.join(tmpDir, "he-aac.m4a");
      fs.writeFileSync(heAacPath, makeAudioMp4(makeEsds(0x40, 5)));
      const heMeta = probeMp4TrackMetadata(heAacPath);
      expect(heMeta).not.toBeNull();
      expect(heMeta!.isAudio).toBe(true);
      expect(heMeta!.codec).toBe("mp4a.40.5");
      expect(heMeta!.durationSec).toBe(12.5);

      // AAC-LC (objectTypeIndication=0x40, audioObjectType=2) -> mp4a.40.2
      const aacLcPath = path.join(tmpDir, "aac-lc.m4a");
      fs.writeFileSync(aacLcPath, makeAudioMp4(makeEsds(0x40, 2)));
      expect(probeMp4TrackMetadata(aacLcPath)!.codec).toBe("mp4a.40.2");

      // Missing esds -> codec MUST be undefined (never blindly guessed as mp4a.40.2)
      const noEsdsPath = path.join(tmpDir, "no-esds.m4a");
      fs.writeFileSync(noEsdsPath, makeAudioMp4());
      const noEsdsMeta = probeMp4TrackMetadata(noEsdsPath);
      expect(noEsdsMeta).not.toBeNull();
      expect(noEsdsMeta!.codec).toBeUndefined();
      expect(noEsdsMeta!.durationSec).toBe(12.5);

      // Round 6 #17: Zero-length 0x05 DecSpecificInfo followed by trailing bytes MUST NOT read past dsiEnd
      const zeroDsi = new Uint8Array([0x05, 0x00, 0x10, 0x00]); // dsiLen=0, trailing 0x10 (AOT=2) outside dsi!
      const dcZero = concatBytes(new Uint8Array([0x04, 13 + 2, 0x40]), new Uint8Array(12), zeroDsi);
      const esZero = concatBytes(new Uint8Array([0x03, 3 + dcZero.byteLength, 0x00, 0x01, 0x00]), dcZero);
      const zeroDsiPath = path.join(tmpDir, "zero-dsi.m4a");
      fs.writeFileSync(zeroDsiPath, makeAudioMp4(makeContainerBox("esds", new Uint8Array(4), esZero)));
      expect(probeMp4TrackMetadata(zeroDsiPath)!.codec).toBeUndefined();

      // Round 6 #17: Escape AOT=31 without extension byte MUST return undefined (NEVER mp4a.40.31!)
      const truncEscapeDsi = new Uint8Array([0x05, 0x01, 0xf8]); // 5 top bits = 31, only 1 byte in dsi
      const dcEsc = concatBytes(new Uint8Array([0x04, 13 + truncEscapeDsi.byteLength, 0x40]), new Uint8Array(12), truncEscapeDsi);
      const esEsc = concatBytes(new Uint8Array([0x03, 3 + dcEsc.byteLength, 0x00, 0x01, 0x00]), dcEsc);
      const truncEscPath = path.join(tmpDir, "trunc-esc.m4a");
      fs.writeFileSync(truncEscPath, makeAudioMp4(makeContainerBox("esds", new Uint8Array(4), esEsc)));
      expect(probeMp4TrackMetadata(truncEscPath)!.codec).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Round 6 #10/#13: probeRemoteDashRanges enforces 16 KiB upper bound, total bounds, and strips inherited range headers", async () => {
    const mp4Prefix = concatBytes(makeMp4Box("ftyp", 20), makeMp4Box("moov", 200), makeMp4Box("sidx", 60));
    const oversizeBody = new Uint8Array(20001);
    oversizeBody.set(mp4Prefix, 0);

    // 1) Reject 206 whose Content-Range ends past requested 0-16383
    const overProbe = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      "video/mp4",
      async () =>
        new Response(oversizeBody, {
          status: 206,
          headers: { "Content-Range": "bytes 0-20000/50000" },
        }),
    );
    expect(overProbe).toBeNull();

    // 2) Reject parsed sidx whose declared indexEnd exceeds numeric Content-Range total
    const hugeSidxPrefix = concatBytes(makeMp4Box("ftyp", 20), makeMp4Box("moov", 200), makeMp4Box("sidx", 600));
    // Serve only the first 260 bytes (sidx header is present, declared sidx end = 819 >= total 300!)
    const partialSlice = hugeSidxPrefix.subarray(0, 260);
    const oobSidxProbe = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      "video/mp4",
      async () =>
        new Response(partialSlice, {
          status: 206,
          headers: { "Content-Range": "bytes 0-259/300" },
        }),
    );
    expect(oobSidxProbe).toBeNull();

    // 3) Inherited lowercase range / if-range in extraHeaders are stripped before setting canonical Range
    let seenHeaders: Record<string, string> = {};
    const sanitized = await probeRemoteDashRanges(
      "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
      "video/mp4",
      async (_u, init) => {
        seenHeaders = (init?.headers as Record<string, string>) || {};
        return new Response(mp4Prefix, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${mp4Prefix.byteLength - 1}/2000` },
        });
      },
      { range: "bytes=999-1000", "if-range": '"stale"', "User-Agent": "TestUA" },
    );
    expect(sanitized).not.toBeNull();
    expect(seenHeaders["range"]).toBeUndefined();
    expect(seenHeaders["if-range"]).toBeUndefined();
    expect(seenHeaders["Range"]).toBe("bytes=0-16383");
    expect(seenHeaders["Accept-Encoding"]).toBe("identity");
    expect(seenHeaders["User-Agent"]).toBe("TestUA");
  });
});
