import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import { noopLogger } from "../src/logger.ts";
import type { AnonymousInnertubeProvider } from "../src/innertube/client.ts";
import type {
  ProgressiveDownloadHandle,
  YtDlpRunner,
  YtDlpVideoInfo,
} from "../src/media/ytdlp.ts";
import {
  deduplicateYtDlpFormats,
  findMatchingYtDlpFormatId,
  MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES,
  selectColdTier3Formats,
} from "../src/media/video-resolver.ts";
import { withStallWatchdog } from "../src/routes/videoplayback.ts";
import { createApp } from "../src/server.ts";

function makeMp4StreamBytes(payloadLen = 700): Uint8Array<ArrayBuffer> {
  const makeBox = (type: string, len: number, fillByte: number) => {
    const b = new Uint8Array(8 + len);
    new DataView(b.buffer).setUint32(0, b.byteLength, false);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.fill(fillByte, 8);
    return b;
  };
  const ftyp = makeBox("ftyp", 16, 1); // 24 bytes (0..23)
  const moov = makeBox("moov", 200, 2); // 208 bytes (24..231)
  const sidx = makeBox("sidx", 64, 3); // 72 bytes (232..303)
  const mdat = makeBox("mdat", payloadLen, 4);
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength + sidx.byteLength + mdat.byteLength);
  let off = 0;
  for (const part of [ftyp, moov, sidx, mdat]) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

function makeGlobalSidxMp4Bytes(payloadLen = 200): Uint8Array<ArrayBuffer> {
  const makeBox = (type: string, len: number, fillByte: number) => {
    const b = new Uint8Array(8 + len);
    new DataView(b.buffer).setUint32(0, b.byteLength, false);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.fill(fillByte, 8);
    return b;
  };
  const ftyp = makeBox("ftyp", 16, 1);
  const moov = makeBox("moov", 120, 2);
  const moof = makeBox("moof", 40, 5);
  const mdat = makeBox("mdat", payloadLen, 4);
  const fragSize = moof.byteLength + mdat.byteLength;

  // Version 0 sidx with 1 reference covering moof+mdat
  const sidx = new Uint8Array(8 + 24 + 12);
  const sv = new DataView(sidx.buffer);
  sv.setUint32(0, sidx.byteLength, false);
  sidx.set([0x73, 0x69, 0x64, 0x78], 4);
  sidx[8] = 0; // version 0
  sv.setUint32(12, 1, false); // reference_ID
  sv.setUint32(16, 1000, false); // timescale
  sv.setUint32(20, 0, false); // earliest_presentation_time
  sv.setUint32(24, 0, false); // first_offset
  sv.setUint16(30, 1, false); // reference_count
  sv.setUint32(32, fragSize & 0x7fffffff, false); // referenced_size
  sv.setUint32(36, 1000, false); // subsegment_duration

  const out = new Uint8Array(ftyp.byteLength + moov.byteLength + sidx.byteLength + fragSize);
  let off = 0;
  for (const part of [ftyp, moov, sidx, moof, mdat]) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

function makeWebmStreamBytes(clusterPayloadLen = 300): {
  bytes: Uint8Array<ArrayBuffer>;
  initStart: number;
  initEnd: number;
  indexStart: number;
  indexEnd: number;
} {
  const encodeSize = (size: number): Uint8Array => {
    if (size < 0x7f) return new Uint8Array([0x80 | size]);
    if (size < 0x3fff) return new Uint8Array([0x40 | (size >> 8), size & 0xff]);
    return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff]);
  };
  const makeElem = (id: number[], payloadLen: number, fillByte: number): Uint8Array => {
    const idBuf = new Uint8Array(id);
    const szBuf = encodeSize(payloadLen);
    const body = new Uint8Array(payloadLen).fill(fillByte);
    const out = new Uint8Array(idBuf.byteLength + szBuf.byteLength + body.byteLength);
    out.set(idBuf, 0);
    out.set(szBuf, idBuf.byteLength);
    out.set(body, idBuf.byteLength + szBuf.byteLength);
    return out;
  };
  const ebml = makeElem([0x1a, 0x45, 0xdf, 0xa3], 20, 1);
  const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const info = makeElem([0x15, 0x49, 0xa9, 0x66], 24, 2);
  const tracks = makeElem([0x16, 0x54, 0xae, 0x6b], 40, 3);
  const cues = makeElem([0x1c, 0x53, 0xbb, 0x6b], 60, 4);
  const cluster = makeElem([0x1f, 0x43, 0xb6, 0x75], clusterPayloadLen, 5);
  const initEnd = ebml.byteLength + segHeader.byteLength + info.byteLength + tracks.byteLength - 1;
  const indexStart = initEnd + 1;
  const indexEnd = indexStart + cues.byteLength - 1;
  const totalLen =
    ebml.byteLength +
    segHeader.byteLength +
    info.byteLength +
    tracks.byteLength +
    cues.byteLength +
    cluster.byteLength;
  const bytes = new Uint8Array(totalLen);
  let off = 0;
  for (const part of [ebml, segHeader, info, tracks, cues, cluster]) {
    bytes.set(part, off);
    off += part.byteLength;
  }
  return { bytes, initStart: 0, initEnd, indexStart, indexEnd };
}

function makeTestConfig(
  cacheDir: string,
  overrides?: {
    authEnabled?: boolean;
    streamStallTimeoutMs?: number;
    maxCacheBytes?: number;
  },
): AppConfig {
  const authEnabled = overrides?.authEnabled ?? true;
  return {
    host: "127.0.0.1",
    port: 8787,
    allowRemoteBind: false,
    logLevel: "error",
    configPath: "/tmp/test-config.json",
    cacheDir,
    logDir: "/tmp/test-logs",
    binaries: { ytDlp: "yt-dlp", deno: "deno", ffmpeg: null },
    playback: {
      videoCacheTtlSec: 1800,
      ytDlpTimeoutMs: 10_000,
      streamStallTimeoutMs: overrides?.streamStallTimeoutMs ?? 500,
      bgutilPotUrl: "http://127.0.0.1:4416",
      enableBgutilPot: false,
      authFallback: {
        enabled: authEnabled,
        cookiesFromBrowser: "firefox",
        firefoxProfile: authEnabled ? "yt-fallback" : "",
      },
      ephemeralBuffer: {
        enabled: true,
        maxCacheBytes: overrides?.maxCacheBytes ?? 50 * 1024 * 1024,
        ttlSeconds: 3600,
        maxFormatHeight: 1080,
      },
    },
    rss: {
      cacheTtlSec: 300,
      negativeCacheTtlSec: 60,
      maxConcurrentUpstream: 4,
    },
    thumbnails: {
      cacheTtlSec: 1800,
      maxEntries: 100,
      maxEntryBytes: 1024 * 1024,
    },
  };
}

function makeMockInnertube(): AnonymousInnertubeProvider {
  const fakeClient = {
    async getInfo() {
      return {
        streaming_data: {
          adaptive_formats: [
            {
              itag: 137,
              init_range: { start: 0, end: 231 },
              index_range: { start: 232, end: 303 },
            },
          ],
        },
        secondary_info: null,
        basic_info: { category: "Education", is_family_safe: true },
        watch_next_feed: [],
        storyboards: null,
        captions: null,
      };
    },
  };
  return {
    async getClient() {
      return fakeClient as any;
    },
    reset() {},
  } as unknown as AnonymousInnertubeProvider;
}

describe("withStallWatchdog & client-abort isolation", () => {
  test("does NOT call onStall when client aborts req.signal mid-chunk", async () => {
    const abortCtrl = new AbortController();
    let stallCalls = 0;

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        abortCtrl.signal.addEventListener("abort", () => {
          controller.error(new Error("Upstream connection aborted"));
        });
      },
    });

    const guarded = withStallWatchdog(source, 200, abortCtrl.signal, () => {
      stallCalls++;
    });

    const reader = guarded.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(new Uint8Array([1, 2, 3]));

    // Simulate client disconnecting / Shaka timeout aborting the request
    const pendingRead = reader.read();
    abortCtrl.abort(new DOMException("Client aborted", "AbortError"));

    await expect(pendingRead).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 250));
    expect(stallCalls).toBe(0);
  });

  test("does NOT call onStall when consumer cancels stream cleanly", async () => {
    let stallCalls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });

    const guarded = withStallWatchdog(source, 80, undefined, () => {
      stallCalls++;
    });

    const reader = guarded.getReader();
    await reader.read();
    await reader.cancel("seek");
    await new Promise((r) => setTimeout(r, 120));
    expect(stallCalls).toBe(0);
  });

  test("DOES call onStall on genuine upstream stall or upstream read error", async () => {
    let stallCount1 = 0;
    const hangingSource = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueues or closes -> genuine stall
      },
    });
    const guardedHanging = withStallWatchdog(hangingSource, 60, undefined, () => {
      stallCount1++;
    });
    const r1 = guardedHanging.getReader();
    await expect(r1.read()).rejects.toThrow(/stalled/i);
    expect(stallCount1).toBe(1);

    let stallCount2 = 0;
    const errorSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("ECONNRESET"));
      },
    });
    const guardedErr = withStallWatchdog(errorSource, 500, undefined, () => {
      stallCount2++;
    });
    const r2 = guardedErr.getReader();
    await expect(r2.read()).rejects.toThrow(/ECONNRESET/);
    expect(stallCount2).toBe(1);
  });

  test("client abort mid-body in /videoplayback does NOT mark target stale or trigger recovery", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-abort-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      let extractCalls = 0;
      let downloadCalls = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          extractCalls++;
          return {
            id: videoId,
            title: "Abort Test",
            duration: 120,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          downloadCalls++;
          throw new Error("should never escalate to Tier 3 on client abort");
        },
      };

      const mockFetchRaw = async (_input: string | URL | Request, init?: RequestInit) => {
        const sig = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mp4Bytes.slice(0, 50));
            sig?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-99/${mp4Bytes.byteLength}`,
            "Content-Length": "100",
          },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, { streamStallTimeoutMs: 250 }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;
      expect(extractCalls).toBe(1);

      // Start chunk request, read first chunk, then abort client-side
      const ctrl = new AbortController();
      const segRes = await app.fetch(
        new Request(playUrl, { headers: { Range: "bytes=0-99" }, signal: ctrl.signal }),
      );
      expect(segRes.status).toBe(206);
      const reader = segRes.body!.getReader();
      const chunk1 = await reader.read();
      expect(chunk1.value?.byteLength).toBe(50);

      const read2 = reader.read();
      ctrl.abort();
      await expect(read2).rejects.toThrow();

      // Target must NOT be marked stale; next request must not trigger recovery or Tier 3
      const target = app.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(target?.kind).toBe("remote");
      if (target?.kind === "remote") {
        expect(Boolean(target.stale)).toBe(false);
      }
      expect(app.resolver.getMetrics().midPlaybackRecoveries).toBe(0);
      expect(extractCalls).toBe(1);
      expect(downloadCalls).toBe(0);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Mid-playback recovery state machine", () => {
  test("deduplicateYtDlpFormats prefers VISIONOS client URLs and prevents default client overwrite", () => {
    const deduped1 = deduplicateYtDlpFormats([
      {
        format_id: "313",
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=313&c=VISIONOS",
      },
      {
        format_id: "313",
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=313&c=WEB",
      },
      {
        format_id: "251",
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&c=WEB",
      },
      {
        format_id: "251",
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&c=VISIONOS",
      },
    ]);

    expect(deduped1.length).toBe(2);
    expect(deduped1[0]!.url).toContain("c=VISIONOS");
    expect(deduped1[1]!.url).toContain("c=VISIONOS");
  });

  test("clears stale flag after failed/skipped Tier 3 and skips oversized streams exceeding maxCacheBytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-oversize-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      const oversizedClen = 3 * 1024 * 1024; // 3 MiB > 1 MiB maxCacheBytes
      let downloadCalls = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Oversized 4K Video",
            duration: 600,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "313",
                ext: "webm",
                protocol: "https",
                container: "webm_dash",
                vcodec: "vp9",
                acodec: "none",
                width: 3840,
                height: 2160,
                fps: 30,
                tbr: 15000,
                filesize: oversizedClen,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=313&dur=600.000&expire=1999999999&clen=${oversizedClen}`,
              },
            ],
          };
        },
        async downloadFormat() {
          downloadCalls++;
          throw new Error("should not download oversized format");
        },
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 313,
                      content_length: oversizedClen,
                      init_range: { start: 0, end: 231 },
                      index_range: { start: 232, end: 303 },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const mockFetchRaw = async () =>
        new Response(mp4Bytes.slice(0, 100), {
          status: 206,
          headers: {
            "Content-Type": "video/webm",
            "Content-Range": `bytes 0-99/${oversizedClen}`,
            "Content-Length": "100",
          },
        });

      const app = createApp(
        makeTestConfig(tmpDir, { authEnabled: false, maxCacheBytes: 1024 * 1024 }),
        {
          logger: noopLogger,
          ytDlp: mockYtDlp,
          innertube: fakeInnertube,
          fetchRawFn: mockFetchRaw,
        },
      );

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/RzHlHrz58oA"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Mark target stale as if a genuine upstream stall occurred
      app.resolver.markTargetStale("RzHlHrz58oA", "313");

      // Next request triggers recovery -> skips oversized Tier 3 -> clears stale -> serves upstream 206!
      const res1 = await app.fetch(new Request(playUrl, { headers: { Range: "bytes=0-99" } }));
      expect(res1.status).toBe(206);
      expect(downloadCalls).toBe(0);

      // Stale flag MUST be cleared so a second request does not re-enter recovery
      const target = app.resolver.getStreamTarget("RzHlHrz58oA", "313", 313);
      expect(target?.kind).toBe("remote");
      if (target?.kind === "remote") {
        expect(target.stale).toBe(false);
      }
      const recoveriesBefore = app.resolver.getMetrics().midPlaybackRecoveries;
      const res2 = await app.fetch(new Request(playUrl, { headers: { Range: "bytes=0-99" } }));
      expect(res2.status).toBe(206);
      expect(app.resolver.getMetrics().midPlaybackRecoveries).toBe(recoveriesBefore);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns 499 immediately when client aborts while waiting on slow mid-playback recovery", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-race-abort-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      let releaseSlowRecovery!: () => void;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (useAuth) {
            await new Promise<void>((resolve) => {
              releaseSlowRecovery = resolve;
            });
          }
          return {
            id: videoId,
            title: "Slow Recovery Test",
            duration: 60,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---${useAuth ? "tier2" : "tier1"}.googlevideo.com/videoplayback?itag=137&dur=60.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("unused");
        },
      };

      const mockFetchRaw = async (input: string | URL | Request) => {
        if (input.toString().includes("tier1")) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(mp4Bytes.slice(0, 100), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-99/${mp4Bytes.byteLength}`,
            "Content-Length": "100",
          },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: true }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Request 1 hits 403 on Tier 1 and blocks in slow Tier 2 extraction; abort it after 30ms
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 30);
      const startMs = Date.now();
      const abortedRes = await app.fetch(
        new Request(playUrl, { headers: { Range: "bytes=0-99" }, signal: ctrl.signal }),
      );
      const elapsedMs = Date.now() - startMs;

      expect(abortedRes.status).toBe(499);
      expect(elapsedMs).toBeLessThan(300);

      // Now finish the background Tier 2 recovery -> subsequent retry immediately gets 206 on Tier 2!
      releaseSlowRecovery();
      await new Promise((r) => setTimeout(r, 20));
      const retryRes = await app.fetch(
        new Request(playUrl, { headers: { Range: "bytes=0-99" } }),
      );
      expect(retryRes.status).toBe(206);
      expect(retryRes.headers.get("x-steadytube-tier")).toBe("2");

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("refreshes aged Tier 2 URL once before escalating to Tier 3", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-tier2-refresh-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      let tier2Calls = 0;
      let downloadCalls = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (!useAuth) {
            throw new Error("tier1 blocked");
          }
          tier2Calls++;
          return {
            id: videoId,
            title: "Tier 2 Refresh Test",
            duration: 120,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---tier2-v${tier2Calls}.googlevideo.com/videoplayback?itag=137&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          downloadCalls++;
          throw new Error("should refresh Tier 2 before Tier 3");
        },
      };

      const mockFetchRaw = async (input: string | URL | Request) => {
        if (input.toString().includes("tier2-v1")) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(mp4Bytes.slice(0, 100), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-99/${mp4Bytes.byteLength}`,
            "Content-Length": "100",
          },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: true }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Age the Tier 2 target > 20s so mid-playback 403 refreshes Tier 2 instead of jumping straight to Tier 3
      const target = app.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(target?.kind).toBe("remote");
      if (target?.kind === "remote") {
        target.resolvedAt = Date.now() - 30_000;
      }

      const res = await app.fetch(new Request(playUrl, { headers: { Range: "bytes=0-99" } }));
      expect(res.status).toBe(206);
      expect(res.headers.get("x-steadytube-tier")).toBe("2");
      expect(tier2Calls).toBe(2);
      expect(downloadCalls).toBe(0);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("streams Tier 3 progressively before full download finishes, then promotes to local buffer", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-tier3-prog-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(1000);
      let finishDownload!: () => void;
      let cancelCount = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Progressive Tier 3 Test",
            duration: 120,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("should use startProgressiveDownload");
        },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          const tmpPath = `${outputPath}.prog.tmp.mp4`;
          // Write first 450 bytes immediately, hold rest until finishDownload() is called
          fs.writeFileSync(tmpPath, mp4Bytes.subarray(0, 450));
          let readablePath = tmpPath;
          let available = 450;
          let status: "downloading" | "completed" | "failed" = "downloading";
          const waiters: Array<() => void> = [];
          const wake = () => {
            for (const fn of waiters.splice(0)) fn();
          };

          const done = new Promise<{ filePath: string; size: number }>((resolve) => {
            finishDownload = () => {
              fs.appendFileSync(tmpPath, mp4Bytes.subarray(450));
              fs.renameSync(tmpPath, outputPath);
              readablePath = outputPath;
              available = mp4Bytes.byteLength;
              status = "completed";
              wake();
              resolve({ filePath: outputPath, size: mp4Bytes.byteLength });
            };
          });

          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done,
            getReadablePath: () => readablePath,
            getAvailableBytes: () => available,
            getStatus: () => status,
            getError: () => null,
            touch: () => {},
            cancel: () => {
              cancelCount++;
            },
            waitForBytes(minBytes, _sig, timeoutMs) {
              if (status !== "downloading" || available >= minBytes) return Promise.resolve();
              return new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
                const check = () => {
                  if (status !== "downloading" || available >= minBytes) {
                    clearTimeout(t);
                    resolve();
                  } else {
                    waiters.push(check);
                  }
                };
                waiters.push(check);
              });
            },
          };
        },
      };

      const mockFetchRaw = async () => new Response("Forbidden", { status: 403 });

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Range 304..403 is already in the first 450 bytes -> streams immediately as 3-stream BEFORE download completes!
      const res1 = await app.fetch(new Request(playUrl, { headers: { Range: "bytes=304-403" } }));
      expect(res1.status).toBe(206);
      expect(res1.headers.get("x-steadytube-tier")).toBe("3-stream");
      expect(new Uint8Array(await res1.arrayBuffer())).toEqual(mp4Bytes.subarray(304, 404));

      // Now finish download -> target upgrades to local 3-buffer and serves trailing bytes!
      finishDownload();
      await new Promise((r) => setTimeout(r, 25));

      const res2 = await app.fetch(new Request(playUrl, { headers: { Range: "bytes=900-999" } }));
      expect(res2.status).toBe(206);
      expect(res2.headers.get("x-steadytube-tier")).toBe("3-buffer");
      expect(new Uint8Array(await res2.arrayBuffer())).toEqual(mp4Bytes.subarray(900, 1000));
      expect(cancelCount).toBe(0);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips mid-playback Tier 3 when requested Range offset is too far ahead without poisoning byte-0 fallback", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-far-offset-"));
    try {
      const totalClen = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 10 * 1024 * 1024; // 74 MiB (< 100 MiB cap)
      let progressiveStarts = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Far Offset Video",
            duration: 600,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: totalClen,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=600.000&expire=1999999999&clen=${totalClen}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("unused");
        },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          progressiveStarts++;
          const tmpPath = `${outputPath}.near.tmp.mp4`;
          const validPrefix = makeMp4StreamBytes(720); // valid 0..231 init + 232..303 sidx
          fs.writeFileSync(tmpPath, validPrefix);
          const done = new Promise<{ filePath: string; size: number }>(() => {});
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done,
            getReadablePath: () => tmpPath,
            getAvailableBytes: () => validPrefix.byteLength,
            getStatus: () => "downloading",
            getError: () => null,
            touch: () => {},
            cancel: () => {},
            waitForBytes: () => Promise.resolve(),
          };
        },
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      content_length: totalClen,
                      init_range: { start: 0, end: 231 },
                      index_range: { start: 232, end: 303 },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const mockFetchRaw = async () => new Response("Forbidden", { status: 403 });

      const app = createApp(
        makeTestConfig(tmpDir, { authEnabled: false, maxCacheBytes: 200 * 1024 * 1024 }),
        {
          logger: noopLogger,
          ytDlp: mockYtDlp,
          innertube: fakeInnertube,
          fetchRawFn: mockFetchRaw,
        },
      );

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Request far ahead (> 64 MiB): must skip Tier 3 and return 503 without starting download
      const farStart = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 1024;
      const farRes = await app.fetch(
        new Request(playUrl, { headers: { Range: `bytes=${farStart}-${farStart + 99}` } }),
      );
      expect(farRes.status).toBe(503);
      expect(progressiveStarts).toBe(0);

      // Subsequent request near byte 0: MUST NOT be blocked by cooldown -> starts progressive Tier 3!
      const nearRes = await app.fetch(
        new Request(playUrl, { headers: { Range: "bytes=0-99" } }),
      );
      expect(nearRes.status).toBe(206);
      expect(nearRes.headers.get("x-steadytube-tier")).toBe("3-stream");
      expect(progressiveStarts).toBe(1);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("incompatible mid-playback recovery never poisons cache or clobbers parallel Tier 3 tracks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-compat-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(1000);
      let extractCalls = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          extractCalls++;
          // Initial Tier 1 gives clen=mp4Bytes.byteLength; Tier 2 returns an INCOMPATIBLE clen (+500)!
          const clen = useAuth ? mp4Bytes.byteLength + 500 : mp4Bytes.byteLength;
          return {
            id: videoId,
            title: "Compat Isolation Test",
            duration: 120,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: clen,
                url: `https://rr1---${useAuth ? "tier2-bad" : "tier1"}.googlevideo.com/videoplayback?itag=137&dur=120.000&expire=1999999999&clen=${clen}`,
              },
              {
                format_id: "140",
                ext: "m4a",
                protocol: "https",
                container: "m4a_dash",
                vcodec: "none",
                acodec: "mp4a.40.2",
                tbr: 128,
                asr: 44100,
                audio_channels: 2,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---${useAuth ? "tier2-bad" : "tier1"}.googlevideo.com/videoplayback?itag=140&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("tier3 disabled for this assertion");
        },
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    { itag: 140, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const cfg = makeTestConfig(tmpDir, { authEnabled: true });
      cfg.playback.ephemeralBuffer.enabled = false;
      const app = createApp(cfg, {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: fakeInnertube,
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const videoUrl = vidJson.adaptiveFormats.find((f: any) => f.itag === "137").url as string;

      // Simulate audio track 140 already promoted to Tier 3 local buffer on the live record
      const audioPath = app.ephemeralStore.getPathFor("abc123XYZ99", "140", "m4a");
      fs.writeFileSync(audioPath, mp4Bytes);
      app.ephemeralStore.register("abc123XYZ99", "140", audioPath, "audio/mp4");
      const liveRec = app.resolver.getCached("abc123XYZ99")!;
      liveRec.targetsByFid.set("140", {
        kind: "local",
        videoId: "abc123XYZ99",
        formatId: "140",
        itag: 140,
        filePath: audioPath,
        mimeType: "audio/mp4",
        size: mp4Bytes.byteLength,
        tier: 3,
      });

      // Video 137 hits 403 -> Tier 2 returns incompatible clen -> must fail cleanly WITHOUT poisoning cache!
      const res = await app.fetch(new Request(videoUrl, { headers: { Range: "bytes=0-99" } }));
      expect(res.status).toBe(503);
      expect(extractCalls).toBe(2);

      // Cached 137 must STILL point to original Tier 1 URL (NOT tier2-bad)
      const cached137 = app.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(cached137?.kind).toBe("remote");
      if (cached137?.kind === "remote") {
        expect(cached137.url).toContain("tier1");
        expect(cached137.url).not.toContain("tier2-bad");
      }

      // Parallel audio track 140 must STILL be Tier 3 local!
      const cached140 = app.resolver.getStreamTarget("abc123XYZ99", "140", 140);
      expect(cached140?.kind).toBe("local");

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("mid-playback refresh respects maxTier cap and never triggers cold Tier 3 download on far seek", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-maxtier-"));
    try {
      const totalClen = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 10 * 1024 * 1024;
      let downloadCalls = 0;
      let extractCalls = 0;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          extractCalls++;
          if (useAuth || extractCalls > 1) {
            throw new Error("upstream refresh failed");
          }
          return {
            id: videoId,
            title: "MaxTier Cap Video",
            duration: 600,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: totalClen,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=600.000&expire=1999999999&clen=${totalClen}`,
              },
            ],
          };
        },
        async downloadFormat() {
          downloadCalls++;
          throw new Error("must NEVER fall through into cold Tier 3 during mid-playback refresh");
        },
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      content_length: totalClen,
                      init_range: { start: 0, end: 231 },
                      index_range: { start: 232, end: 303 },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const app = createApp(
        makeTestConfig(tmpDir, { authEnabled: true, maxCacheBytes: 200 * 1024 * 1024 }),
        {
          logger: noopLogger,
          ytDlp: mockYtDlp,
          innertube: fakeInnertube,
          fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
        },
      );

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Age target so Step 1b yt-dlp refresh AND Step 2 auth refresh both run and fail
      const t = app.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      if (t?.kind === "remote") t.resolvedAt = Date.now() - 30_000;

      const farStart = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 4096;
      const res = await app.fetch(
        new Request(playUrl, { headers: { Range: `bytes=${farStart}-${farStart + 99}` } }),
      );
      expect(res.status).toBe(503);
      expect(downloadCalls).toBe(0);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolves synthetic InnerTube formatId to verified yt-dlp format_id before progressive Tier 3", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-synfid-"));
    try {
      const webmFixture = makeWebmStreamBytes(400);
      const audioBytes = webmFixture.bytes;
      const passedSelectors: string[] = [];

      // Fast InnerTube emits synthetic multi-audio formatId: "251-en-US-en-US.4"
      const fastInnertube = {
        async getClient() {
          return {
            async getBasicInfo() {
              return {
                playability_status: { status: "OK" },
                basic_info: { title: "Multi-Audio Video", duration: 120, author: "Creator", channel_id: "UC1234567890123456789012" },
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      mime_type: 'video/mp4; codecs="avc1.640028"',
                      width: 1920,
                      height: 1080,
                      fps: 30,
                      bitrate: 2000000,
                      content_length: 1000,
                      init_range: { start: 0, end: 200 },
                      index_range: { start: 201, end: 300 },
                      url: "https://rr1---it.googlevideo.com/videoplayback?itag=137&dur=120&expire=1999999999&clen=1000",
                    },
                    {
                      itag: 251,
                      mime_type: 'audio/webm; codecs="opus"',
                      bitrate: 128000,
                      language: "en-US",
                      audio_track: { id: "en-US.4" },
                      content_length: audioBytes.byteLength,
                      init_range: { start: webmFixture.initStart, end: webmFixture.initEnd },
                      index_range: { start: webmFixture.indexStart, end: webmFixture.indexEnd },
                      url: `https://rr1---it.googlevideo.com/videoplayback?itag=251&dur=120&expire=1999999999&clen=${audioBytes.byteLength}`,
                    },
                  ],
                },
              };
            },
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 251,
                      content_length: audioBytes.byteLength,
                      init_range: { start: webmFixture.initStart, end: webmFixture.initEnd },
                      index_range: { start: webmFixture.indexStart, end: webmFixture.indexEnd },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      // yt-dlp names the exact same byte-length audio track "251-0"
      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Multi-Audio Video",
            duration: 120,
            formats: [
              {
                format_id: "251-0",
                ext: "webm",
                protocol: "https",
                container: "webm_dash",
                vcodec: "none",
                acodec: "opus",
                tbr: 128,
                filesize: audioBytes.byteLength,
                url: `https://rr1---ytdlp.googlevideo.com/videoplayback?itag=251&dur=120&expire=1999999999&clen=${audioBytes.byteLength}`,
              },
              {
                format_id: "251-1",
                ext: "webm",
                protocol: "https",
                container: "webm_dash",
                vcodec: "none",
                acodec: "opus",
                tbr: 128,
                filesize: audioBytes.byteLength + 123, // Different language track
                url: `https://rr1---ytdlp-es.googlevideo.com/videoplayback?itag=251&dur=120&expire=1999999999&clen=${audioBytes.byteLength + 123}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("should use progressive");
        },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          passedSelectors.push(formatSelector);
          const tmpPath = `${outputPath}.syn.tmp.webm`;
          fs.writeFileSync(tmpPath, audioBytes);
          const done = Promise.resolve({ filePath: outputPath, size: audioBytes.byteLength });
          fs.renameSync(tmpPath, outputPath);
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done,
            getReadablePath: () => outputPath,
            getAvailableBytes: () => audioBytes.byteLength,
            getStatus: () => "completed",
            getError: () => null,
            touch: () => {},
            cancel: () => {},
            waitForBytes: () => Promise.resolve(),
          };
        },
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: fastInnertube,
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const audioFormat = vidJson.adaptiveFormats.find((f: any) => f.itag === "251");
      expect(audioFormat.url).toContain("fid=251-en-US-en-US.4");

      const segRes = await app.fetch(
        new Request(audioFormat.url, { headers: { Range: "bytes=0-99" } }),
      );
      expect(segRes.status).toBe(206);
      expect(passedSelectors).toEqual(["251-0"]); // Real yt-dlp selector, NOT synthetic InnerTube ID!

      // Also verify findMatchingYtDlpFormatId rejects mismatched clen
      expect(
        findMatchingYtDlpFormatId(
          [{ format_id: "251-0", filesize: 9999 }],
          { formatId: "251-en-US-en-US.4", itag: 251, clen: 600, isDrc: false },
        ),
      ).toBeNull();

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("stale-target identity race, If-Range handling, stop() during startup, cold Tier 3 selection, and local clen/MIME checks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-edge5-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(800);
      const webmFixture = makeWebmStreamBytes(400);
      const seenUpstreamRanges: Array<string | null> = [];
      let startupCancelCalled = false;
      let releaseStartup!: () => void;

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Edge Cases",
            duration: 120,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=120&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
              {
                format_id: "251",
                ext: "webm",
                protocol: "https",
                container: "webm_dash",
                vcodec: "none",
                acodec: "opus",
                tbr: 128,
                filesize: webmFixture.bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&dur=120&expire=1999999999&clen=${webmFixture.bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() {
          throw new Error("unused");
        },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          let rejectWait!: (err: Error) => void;
          const waitPromise = new Promise<void>((_, reject) => {
            rejectWait = reject;
          });
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done: waitPromise.then(() => ({ filePath: outputPath, size: 0 })),
            getReadablePath: () => outputPath,
            getAvailableBytes: () => 0,
            getStatus: () => (startupCancelCalled ? "failed" : "downloading"),
            getError: () => (startupCancelCalled ? new Error("cancelled") : null),
            touch: () => {},
            cancel: (reason) => {
              startupCancelCalled = true;
              rejectWait(new Error(reason || "cancelled"));
              releaseStartup?.();
            },
            waitForBytes: () => waitPromise,
          };
        },
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    {
                      itag: 251,
                      init_range: { start: webmFixture.initStart, end: webmFixture.initEnd },
                      index_range: { start: webmFixture.indexStart, end: webmFixture.indexEnd },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      let failUpstream = false;
      const mockFetchRaw = async (_input: string | URL | Request, init?: RequestInit) => {
        const hdrs = new Headers(init?.headers);
        seenUpstreamRanges.push(hdrs.get("range"));
        if (failUpstream) return new Response("Forbidden", { status: 403 });
        return new Response(mp4Bytes, {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": String(mp4Bytes.byteLength) },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: fakeInnertube,
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const vidJson = (await vidRes.json()) as any;
      const playUrl137 = vidJson.adaptiveFormats.find((f: any) => f.itag === "137").url as string;
      const playUrl251 = vidJson.adaptiveFormats.find((f: any) => f.itag === "251").url as string;

      // 1) If-Range omits Range when forwarding to upstream googlevideo
      const ifRangeRes = await app.fetch(
        new Request(playUrl137, { headers: { Range: "bytes=0-99", "If-Range": '"v1"' } }),
      );
      expect(ifRangeRes.status).toBe(200);
      expect(seenUpstreamRanges[0]).toBeNull();

      // 2) Stale-target identity check: old target cannot mark replacement target stale
      const rec = app.resolver.getCached("abc123XYZ99")!;
      const oldTarget = rec.targetsByFid.get("137")!;
      expect(oldTarget.kind).toBe("remote");
      const replacement = { ...(oldTarget as Extract<typeof oldTarget, { kind: "remote" }>), url: "https://rr2---new.googlevideo.com/videoplayback" };
      rec.targetsByFid.set("137", replacement);
      app.resolver.markTargetStale("abc123XYZ99", "137", oldTarget as Extract<typeof oldTarget, { kind: "remote" }>);
      expect(Boolean(replacement.stale)).toBe(false);
      app.resolver.markTargetStale("abc123XYZ99", "137", replacement);
      expect(replacement.stale).toBe(true);
      replacement.stale = false;

      // 3) Local reuse validates clen + WebM layout AND restores audio/webm MIME type (fixing restart-scan video/webm)
      const audioPath = app.ephemeralStore.getPathFor("abc123XYZ99", "251", "webm");
      fs.writeFileSync(audioPath, webmFixture.bytes);
      // Simulate startup scan registering audio .webm as video/webm
      app.ephemeralStore.register("abc123XYZ99", "251", audioPath, "video/webm");
      failUpstream = true;
      const audioRes = await app.fetch(
        new Request(playUrl251, { headers: { Range: "bytes=0-99" } }),
      );
      expect(audioRes.status).toBe(206);
      expect(audioRes.headers.get("content-type")).toBe("audio/webm");
      expect(audioRes.headers.get("x-steadytube-tier")).toBe("3-buffer");

      // 4) Cold Tier 3 deterministic format selector picks 1080p avc1 + non-DRC AAC
      const selected = selectColdTier3Formats(
        [
          { format_id: "134", ext: "mp4", vcodec: "avc1.4d401e", acodec: "none", height: 360, fps: 30, tbr: 400 },
          { format_id: "399", ext: "mp4", vcodec: "av01.0.08M.08", acodec: "none", height: 1080, fps: 60, tbr: 2800 },
          { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, tbr: 2200 },
          { format_id: "138", ext: "mp4", vcodec: "avc1.640032", acodec: "none", height: 2160, fps: 30, tbr: 9000 },
          { format_id: "140-drc", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 130, format_note: "medium, DRC" },
          { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
        ],
        1080,
      );
      expect(selected.video?.format_id).toBe("137");
      expect(selected.audio?.format_id).toBe("140");

      // 5) stop() cancels a starting progressive download BEFORE byte 1 arrives
      const startupDone = new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      const pendingRes = app.fetch(
        new Request(playUrl137, { headers: { Range: "bytes=0-99" } }),
      );
      await new Promise((r) => setTimeout(r, 20));
      app.stop();
      await startupDone;
      const resAfterStop = await pendingRes;
      expect(startupCancelCalled).toBe(true);
      expect(resAfterStop.status).toBe(503);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects old cold Tier 3 or layout-mismatched URLs with 410 instead of falling back by itag", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-layout-bind-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);
      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Layout Bind Test",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: async () =>
          new Response(mp4Bytes.slice(0, 100), {
            status: 206,
            headers: { "Content-Range": `bytes 0-99/${mp4Bytes.byteLength}`, "Content-Length": "100" },
          }),
      });

      // Cold resolve caches remote itag 137 with layout 0-231_232-303
      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      expect(vidJson.adaptiveFormats[0].url).toContain("layout=0-231_232-303");

      // 1) Old cold Tier 3 URL with same itag=137 MUST NOT fall back to remote 137 -> returns 410 Gone!
      const staleTier3Res = await app.fetch(
        new Request(
          "http://127.0.0.1:8787/videoplayback?v=abc123XYZ99&fid=tier3-v-137&itag=137&clen=500&layout=0-143_144-187",
          { headers: { Range: "bytes=144-187" } },
        ),
      );
      expect(staleTier3Res.status).toBe(410);

      // 2) Old remote URL with same fid=137 & same clen but DIFFERENT layout MUST return 410 Gone!
      const staleLayoutRes = await app.fetch(
        new Request(
          `http://127.0.0.1:8787/videoplayback?v=abc123XYZ99&fid=137&itag=137&clen=${mp4Bytes.byteLength}&layout=0-199_200-271`,
          { headers: { Range: "bytes=200-271" } },
        ),
      );
      expect(staleLayoutRes.status).toBe(410);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects same-length recovery target with different DASH layout and prevents delayed recovery from overwriting newer manifest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-rec-layout-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);
      let callCount = 0;
      let releaseDelayedTier2!: () => void;
      let tier2Started!: () => void;
      const tier2StartedPromise = new Promise<void>((r) => { tier2Started = r; });

      // Part A: Same-length recovery target with DIFFERENT init/index ranges is rejected
      let currentInitEnd = 231;
      let currentIndexStart = 232;
      let currentIndexEnd = 303;
      const dynamicInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      content_length: mp4Bytes.byteLength,
                      init_range: { start: 0, end: currentInitEnd },
                      index_range: { start: currentIndexStart, end: currentIndexEnd },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const mockYtDlpA: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (useAuth) {
            // Tier 2 returns IDENTICAL clen, but shifted DASH ranges!
            currentInitEnd = 199;
            currentIndexStart = 200;
            currentIndexEnd = 271;
          }
          return {
            id: videoId,
            title: "Same Length Diff Layout",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---${useAuth ? "tier2-shifted" : "tier1"}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const cfgA = makeTestConfig(tmpDir, { authEnabled: true });
      cfgA.playback.ephemeralBuffer.enabled = false;
      const appA = createApp(cfgA, {
        logger: noopLogger,
        ytDlp: mockYtDlpA,
        innertube: dynamicInnertube,
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
      });

      const vidResA = await appA.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const urlA = ((await vidResA.json()) as any).adaptiveFormats[0].url as string;
      const segResA = await appA.fetch(new Request(urlA, { headers: { Range: "bytes=232-303" } }));
      expect(segResA.status).toBe(503);
      // Shifted Tier 2 target must NOT have replaced the original target
      const tA = appA.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(tA?.kind).toBe("remote");
      if (tA?.kind === "remote") expect(tA.url).toContain("tier1");
      appA.stop();

      // Part B: Delayed recovery finishes AFTER a new manifest replaces the cache -> MUST NOT overwrite new manifest!
      const mockYtDlpB: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          callCount++;
          if (useAuth) {
            tier2Started();
            await new Promise<void>((r) => { releaseDelayedTier2 = r; });
            return {
              id: videoId,
              title: "Old Tier 2",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---old-tier2.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          }
          const isNewManifest = callCount >= 2;
          const clen = isNewManifest ? mp4Bytes.byteLength + 500 : mp4Bytes.byteLength;
          return {
            id: videoId,
            title: isNewManifest ? "New Manifest" : "Old Manifest",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: clen,
                url: `https://rr1---${isNewManifest ? "new-manifest" : "old-tier1"}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${clen}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const appB = createApp(makeTestConfig(tmpDir, { authEnabled: true }), {
        logger: noopLogger,
        ytDlp: mockYtDlpB,
        innertube: makeMockInnertube(),
        fetchRawFn: async (input) => {
          if (input.toString().includes("old-tier1")) return new Response("Forbidden", { status: 403 });
          return new Response(mp4Bytes.slice(0, 50), {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-49/${mp4Bytes.byteLength}`,
              "Content-Length": "50",
            },
          });
        },
      });

      const oldVidRes = await appB.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const oldUrl = ((await oldVidRes.json()) as any).adaptiveFormats[0].url as string;

      // Trigger delayed Tier 2 recovery from old manifest
      const oldPlaybackPromise = appB.fetch(new Request(oldUrl, { headers: { Range: "bytes=0-49" } }));
      await tier2StartedPromise;

      // Old record expires -> new manifest is resolved and cached
      appB.resolver.invalidateVideo("abc123XYZ99");
      const newVidRes = await appB.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(newVidRes.status).toBe(200);

      // Now finish delayed old Tier 2 recovery -> MUST NOT overwrite new manifest's target!
      releaseDelayedTier2();
      await oldPlaybackPromise;

      const liveTarget = appB.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(liveTarget?.kind).toBe("remote");
      if (liveTarget?.kind === "remote") {
        expect(liveTarget.url).toContain("new-manifest");
        expect(liveTarget.clen).toBe(mp4Bytes.byteLength + 500);
      }
      appB.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not treat filesize_approx as authoritative clen for HEAD or progressive streaming, and isolates far-seek from concurrent byte-0 recovery", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-approx-far-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);
      let headUpstreamCalls = 0;
      let progressiveCalls = 0;
      let downloadFormatCalls = 0;

      // Part A: filesize_approx only -> HEAD must NOT fast-path with approx size, and Tier 3 must NOT use progressive
      const approxYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Approx Only",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: null,
                filesize_approx: 999_999,
                url: "https://rr1---approx.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999",
              },
            ],
          };
        },
        async downloadFormat(_id, _sel, outPath) {
          downloadFormatCalls++;
          fs.writeFileSync(outPath, mp4Bytes);
          return outPath;
        },
        async startProgressiveDownload() {
          progressiveCalls++;
          throw new Error("must not use progressive when only filesize_approx is known");
        },
      };

      const appA = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: approxYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: async (_u, init) => {
          if (init?.method === "HEAD") {
            headUpstreamCalls++;
            return new Response(null, {
              status: 200,
              headers: { "Content-Type": "video/mp4", "Content-Length": String(mp4Bytes.byteLength) },
            });
          }
          return new Response("Forbidden", { status: 403 });
        },
      });

      const vidResA = await appA.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const urlA = ((await vidResA.json()) as any).adaptiveFormats[0].url as string;
      const targetA = appA.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(targetA?.kind === "remote" && targetA.clen).toBe(0);

      // HEAD must query upstream and return authoritative exact length (NOT 999_999!)
      const headRes = await appA.fetch(new Request(urlA, { method: "HEAD" }));
      expect(headRes.status).toBe(200);
      expect(headUpstreamCalls).toBe(1);
      expect(headRes.headers.get("content-length")).toBe(String(mp4Bytes.byteLength));

      // GET 403 escalates via non-progressive downloadFormat (NOT startProgressiveDownload!)
      const getRes = await appA.fetch(new Request(urlA, { headers: { Range: "bytes=0-99" } }));
      expect(getRes.status).toBe(206);
      expect(progressiveCalls).toBe(0);
      expect(downloadFormatCalls).toBe(1);
      expect(getRes.headers.get("content-range")).toBe(`bytes 0-99/${mp4Bytes.byteLength}`);
      appA.stop();

      // Part B: Concurrent far-seek recovery MUST NOT block concurrent byte-0 recovery
      const totalClen = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 10 * 1024 * 1024;
      let releaseTier2Fail!: () => void;
      let tier2WaitStarted!: () => void;
      const tier2WaitPromise = new Promise<void>((r) => { tier2WaitStarted = r; });
      let progStartsB = 0;

      const concYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (useAuth) {
            tier2WaitStarted();
            await new Promise<void>((r) => { releaseTier2Fail = r; });
            throw new Error("tier2 failed");
          }
          return {
            id: videoId,
            title: "Concurrent Far + Near",
            duration: 600,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: totalClen,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=600&expire=1999999999&clen=${totalClen}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          progStartsB++;
          const tmpPath = `${outputPath}.conc.tmp.mp4`;
          fs.writeFileSync(tmpPath, mp4Bytes);
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done: new Promise(() => {}),
            getReadablePath: () => tmpPath,
            getAvailableBytes: () => mp4Bytes.byteLength,
            getStatus: () => "downloading",
            getError: () => null,
            touch: () => {},
            cancel: () => {},
            waitForBytes: () => Promise.resolve(),
          };
        },
      };

      const fakeItB = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    { itag: 137, content_length: totalClen, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const appB = createApp(
        makeTestConfig(tmpDir, { authEnabled: true, maxCacheBytes: 200 * 1024 * 1024 }),
        {
          logger: noopLogger,
          ytDlp: concYtDlp,
          innertube: fakeItB,
          fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
        },
      );

      const vidResB = await appB.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const urlB = ((await vidResB.json()) as any).adaptiveFormats[0].url as string;

      // Start far-seek request FIRST (holds Tier 2 open), then start byte-0 request concurrently
      const farStart = MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES + 4096;
      const farReq = appB.fetch(new Request(urlB, { headers: { Range: `bytes=${farStart}-${farStart + 99}` } }));
      await tier2WaitPromise;
      const nearReq = appB.fetch(new Request(urlB, { headers: { Range: "bytes=0-99" } }));
      await new Promise((r) => setTimeout(r, 15));
      releaseTier2Fail();

      const [farRes, nearRes] = await Promise.all([farReq, nearReq]);
      expect(farRes.status).toBe(503);
      expect(nearRes.status).toBe(206);
      expect(nearRes.headers.get("x-steadytube-tier")).toBe("3-stream");
      expect(progStartsB).toBe(1);
      appB.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cold Tier 3 keys cached tracks by selected format_id so AV1 and H.264 representations never collide", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-cold-key-"));
    try {
      const av1Bytes = makeGlobalSidxMp4Bytes(220);
      const h264Bytes = makeGlobalSidxMp4Bytes(300);
      const audioBytes = makeGlobalSidxMp4Bytes(150);
      let phase = 1;
      const downloadedSelectors: string[] = [];

      const coldYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          // Return formats without direct DASH URLs (protocol=m3u8) so Tier 1/2 escalate to cold Tier 3!
          const videoFmts =
            phase === 1
              ? [
                  {
                    format_id: "399",
                    ext: "mp4",
                    protocol: "m3u8_native",
                    vcodec: "av01.0.08M.08",
                    acodec: "none",
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    tbr: 2000,
                  },
                ]
              : [
                  {
                    format_id: "399",
                    ext: "mp4",
                    protocol: "m3u8_native",
                    vcodec: "av01.0.08M.08",
                    acodec: "none",
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    tbr: 2000,
                  },
                  {
                    format_id: "137",
                    ext: "mp4",
                    protocol: "m3u8_native",
                    vcodec: "avc1.640028",
                    acodec: "none",
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    tbr: 2200,
                  },
                ];
          return {
            id: videoId,
            title: "Cold Tier 3 Codec Isolation",
            duration: 60,
            formats: [
              ...videoFmts,
              {
                format_id: "140",
                ext: "m4a",
                protocol: "m3u8_native",
                vcodec: "none",
                acodec: "mp4a.40.2",
                abr: 128,
              },
            ],
          };
        },
        async downloadFormat(_id, selector, outPath) {
          downloadedSelectors.push(selector);
          if (selector === "399") fs.writeFileSync(outPath, av1Bytes);
          else if (selector === "137") fs.writeFileSync(outPath, h264Bytes);
          else fs.writeFileSync(outPath, audioBytes);
          return outPath;
        },
      };

      const app = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: coldYtDlp,
        innertube: makeMockInnertube(),
      });

      // Phase 1: only AV1 (399) available -> cached under tier3-v-399
      const r1 = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(r1.status).toBe(200);
      const j1 = (await r1.json()) as any;
      const v1 = j1.adaptiveFormats.find((f: any) => f.type.startsWith("video/"));
      expect(v1.encoding).toBe("av01.0.08M.08");
      expect(v1.url).toContain("fid=tier3-v-399");
      expect(v1.clen).toBe(String(av1Bytes.byteLength));

      // Phase 2: H.264 (137) becomes available after cache expiry -> MUST download 137 into tier3-v-137 (NOT reuse AV1!)
      phase = 2;
      app.resolver.invalidateVideo("abc123XYZ99");
      const r2 = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(r2.status).toBe(200);
      const j2 = (await r2.json()) as any;
      const v2 = j2.adaptiveFormats.find((f: any) => f.type.startsWith("video/"));
      expect(v2.encoding).toBe("avc1.640028");
      expect(v2.url).toContain("fid=tier3-v-137");
      expect(v2.clen).toBe(String(h264Bytes.byteLength));
      expect(downloadedSelectors).toEqual(["399", "140", "137"]);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("isolates concurrent recoveries across incompatible representations and prevents active progressive relabeling", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r3-c1-c2-"));
    try {
      const mp4Old = makeMp4StreamBytes(600); // layout 0-231_232-303, len 912
      const mp4New = makeMp4StreamBytes(800); // layout 0-231_232-303, len 1112
      let phase = 1;
      let releaseOldRecovery!: () => void;
      let oldRecoveryStarted!: () => void;
      const oldStartedPromise = new Promise<void>((r) => { oldRecoveryStarted = r; });

      // Part A (C1): Old recovery in flight MUST NOT leak its result to a concurrent recovery for a newer representation
      const ytDlpA: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (useAuth && phase === 1) {
            oldRecoveryStarted();
            await new Promise<void>((r) => { releaseOldRecovery = r; });
            return {
              id: videoId,
              title: "Old Tier 2",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Old.byteLength,
                  url: `https://rr1---old-tier2.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Old.byteLength}`,
                },
              ],
            };
          }
          const bytes = phase === 1 ? mp4Old : mp4New;
          const tag = useAuth ? "new-tier2" : phase === 1 ? "old-tier1" : "new-tier1";
          return {
            id: videoId,
            title: `Phase ${phase}`,
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: bytes.byteLength,
                url: `https://rr1---${tag}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const cfgA = makeTestConfig(tmpDir, { authEnabled: true });
      cfgA.playback.ephemeralBuffer.enabled = false;
      const appA = createApp(cfgA, {
        logger: noopLogger,
        ytDlp: ytDlpA,
        innertube: makeMockInnertube(),
        fetchRawFn: async (input) => {
          const u = input.toString();
          if (u.includes("tier1")) return new Response("Forbidden", { status: 403 });
          const bytes = u.includes("old-tier2") ? mp4Old : mp4New;
          return new Response(bytes.slice(0, 50), {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-49/${bytes.byteLength}`,
              "Content-Length": "50",
            },
          });
        },
      });

      const oldUrl = (((await (await appA.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url) as string;
      const oldReq = appA.fetch(new Request(oldUrl, { headers: { Range: "bytes=0-49" } }));
      await oldStartedPromise;

      // Refresh cache to new representation while old recovery is still suspended
      phase = 2;
      appA.resolver.invalidateVideo("abc123XYZ99");
      const newUrl = (((await (await appA.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url) as string;

      // Concurrent request for NEW representation MUST NOT receive old representation's Content-Range total!
      const newReq = appA.fetch(new Request(newUrl, { headers: { Range: "bytes=0-49" } }));
      releaseOldRecovery();
      const [oldRes, newRes] = await Promise.all([oldReq, newReq]);
      expect(oldRes.status).toBe(206);
      expect(oldRes.headers.get("content-range")).toBe(`bytes 0-49/${mp4Old.byteLength}`);
      expect(newRes.status).toBe(206);
      expect(newRes.headers.get("content-range")).toBe(`bytes 0-49/${mp4New.byteLength}`);
      appA.stop();

      // Part B (C2): Active progressive download for layout A MUST NOT be reused or relabeled under layout B
      let layoutBActive = false;
      const dynInnertubeB = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      content_length: mp4Old.byteLength,
                      init_range: { start: 0, end: layoutBActive ? 199 : 231 },
                      index_range: { start: layoutBActive ? 200 : 232, end: layoutBActive ? 271 : 303 },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const ytDlpB: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Active Prog Identity",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Old.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Old.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          const tmpPath = `${outputPath}.active.tmp.mp4`;
          fs.writeFileSync(tmpPath, mp4Old);
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done: new Promise(() => {}), // Stays active
            getReadablePath: () => tmpPath,
            getAvailableBytes: () => mp4Old.byteLength,
            getStatus: () => "downloading",
            getError: () => null,
            touch: () => {},
            cancel: () => {},
            waitForBytes: () => Promise.resolve(),
          };
        },
      };

      const appB = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: ytDlpB,
        innertube: dynInnertubeB,
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
      });

      const urlLayoutA = (((await (await appB.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url) as string;
      const resLayoutA = await appB.fetch(new Request(urlLayoutA, { headers: { Range: "bytes=0-49" } }));
      expect(resLayoutA.status).toBe(206);
      expect(resLayoutA.headers.get("x-steadytube-tier")).toBe("3-stream");

      // Cache refreshes to same fid + same length, DIFFERENT layout B while layout A download is still active
      layoutBActive = true;
      appB.resolver.invalidateVideo("abc123XYZ99");
      const urlLayoutB = (((await (await appB.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url) as string;
      expect(urlLayoutB).toContain("layout=0-199_200-271");

      // Request for layout B MUST NOT reuse layout A's active progressive bytes or publish it as layout B!
      const resLayoutB = await appB.fetch(new Request(urlLayoutB, { headers: { Range: "bytes=0-49" } }));
      expect(resLayoutB.status).toBe(503);
      const targetB = appB.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(targetB?.kind).toBe("remote");
      appB.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("enforces exact clen against clen=0 targets and upstream Content-Range totals, and rejects mismatched WebM Cues/index hashes before serving", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r3-c3-c4-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);
      // Part A (C3): URL with clen=912 must reject clen=0 target (410) and reject upstream 206 total=916 (410)
      let omitClen = false;
      let upstreamWrongTotal = false;
      const ytDlpC3: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "Exact Clen Check",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: omitClen ? null : mp4Bytes.byteLength,
                filesize_approx: omitClen ? 123_456 : null,
                url: omitClen
                  ? "https://rr1---nocl.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999"
                  : `https://rr1---exact.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const appC3 = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: ytDlpC3,
        innertube: makeMockInnertube(),
        fetchRawFn: async () =>
          new Response(mp4Bytes.slice(0, 50), {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-49/${upstreamWrongTotal ? mp4Bytes.byteLength + 4 : mp4Bytes.byteLength}`,
              "Content-Length": "50",
            },
          }),
      });

      const v1Json = (await (await appC3.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const exactUrl = v1Json.adaptiveFormats[0].url as string;

      // Upstream total mismatch (916 !== 912) -> 410 Gone!
      upstreamWrongTotal = true;
      const wrongTotalRes = await appC3.fetch(new Request(exactUrl, { headers: { Range: "bytes=0-49" } }));
      expect(wrongTotalRes.status).toBe(410);
      upstreamWrongTotal = false;

      // Cache refreshes to clen=0 (only filesize_approx=123456) -> JSON clen must be "0" (not approx),
      // and old URL with exact clen=912 MUST be rejected with 410!
      omitClen = true;
      appC3.resolver.invalidateVideo("abc123XYZ99");
      const v2Json = (await (await appC3.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      expect(v2Json.adaptiveFormats[0].clen).toBe("0");
      const oldExactAgainstZero = await appC3.fetch(new Request(exactUrl, { headers: { Range: "bytes=0-49" } }));
      expect(oldExactAgainstZero.status).toBe(410);
      appC3.stop();

      // Part B (C4): Progressive WebM with tampered index bytes (same bounds, different Cues payload)
      // MUST be rejected via captured SHA-256 indexHash BEFORE serving a single 206 byte!
      const webmOrig = makeWebmStreamBytes(400);
      const webmTampered = new Uint8Array(webmOrig.bytes);
      // Flip one byte INSIDE the Cues element payload (keeping exact init/index bounds & file length identical!)
      webmTampered[webmOrig.indexEnd] = (webmTampered[webmOrig.indexEnd] ?? 0) ^ 0xff;

      let failUpstreamWebm = false;
      const ytDlpC4: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
          return {
            id: videoId,
            title: "WebM Hash Verify",
            duration: 60,
            formats: [
              {
                format_id: "251",
                ext: "webm",
                protocol: "https",
                container: "webm_dash",
                vcodec: "none",
                acodec: "opus",
                tbr: 128,
                filesize: webmOrig.bytes.byteLength,
                url: `https://rr1---webm.googlevideo.com/videoplayback?itag=251&dur=60&expire=1999999999&clen=${webmOrig.bytes.byteLength}`,
              },
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---mp4.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
        async startProgressiveDownload(videoId, formatSelector, outputPath, opts): Promise<ProgressiveDownloadHandle> {
          const tmpPath = `${outputPath}.tampered.tmp.webm`;
          fs.writeFileSync(tmpPath, webmTampered);
          return {
            videoId,
            formatId: opts.cacheFormatId || formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done: new Promise(() => {}),
            getReadablePath: () => tmpPath,
            getAvailableBytes: () => webmTampered.byteLength,
            getStatus: () => "downloading",
            getError: () => null,
            touch: () => {},
            cancel: () => {},
            waitForBytes: () => Promise.resolve(),
          };
        },
      };

      const webmInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    {
                      itag: 251,
                      init_range: { start: webmOrig.initStart, end: webmOrig.initEnd },
                      index_range: { start: webmOrig.indexStart, end: webmOrig.indexEnd },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const appC4 = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        ytDlp: ytDlpC4,
        innertube: webmInnertube,
        fetchRawFn: async () => {
          if (failUpstreamWebm) return new Response("Forbidden", { status: 403 });
          const slice = webmOrig.bytes.subarray(webmOrig.indexStart, webmOrig.indexEnd + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Range": `bytes ${webmOrig.indexStart}-${webmOrig.indexEnd}/${webmOrig.bytes.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        },
      });

      const vidWebm = (await (await appC4.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const webmUrl = vidWebm.adaptiveFormats.find((f: any) => f.itag === "251").url as string;

      // Shaka fetches the original Cues indexRange first -> daemon captures indexHash!
      const idxRes = await appC4.fetch(
        new Request(webmUrl, { headers: { Range: `bytes=${webmOrig.indexStart}-${webmOrig.indexEnd}` } }),
      );
      expect(idxRes.status).toBe(206);
      await idxRes.arrayBuffer();

      // Now upstream returns 403 -> progressive Tier 3 yields tampered Cues bytes with same bounds -> MUST be rejected (503)!
      failUpstreamWebm = true;
      const segRes = await appC4.fetch(
        new Request(webmUrl, { headers: { Range: `bytes=${webmOrig.indexEnd + 1}-${webmOrig.indexEnd + 50}` } }),
      );
      expect(segRes.status).toBe(503);
      appC4.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("guards far-seek cache misses, refreshes manifest after incompatible recovery exhaustion, and requires complete DASH pairs for MPD", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r3-m5-m6-m9-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);

      // Part A (M5): Cache miss with Range > 64 MiB must NEVER invoke cold Tier 3 download
      let coldDownloads = 0;
      const appM5 = createApp(makeTestConfig(tmpDir, { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() { throw new Error("remote failed"); },
          async downloadFormat() {
            coldDownloads++;
            throw new Error("must not start cold Tier 3 on far-seek cache miss");
          },
        },
      });
      const farMiss = await appM5.fetch(
        new Request(
          "http://127.0.0.1:8787/videoplayback?v=abc123XYZ99&fid=tier3-v-137&itag=137&clen=90000000",
          { headers: { Range: "bytes=70000000-70000999" } },
        ),
      );
      expect(farMiss.status).not.toBe(206);
      expect(coldDownloads).toBe(0);
      appM5.stop();

      // Part B (M6): Incompatible recovery exhaustion marks record for metadata refresh so reload gets new layout
      let layoutPhase = 1;
      const dynIt = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    {
                      itag: 137,
                      init_range: { start: 0, end: layoutPhase === 1 ? 231 : 199 },
                      index_range: { start: layoutPhase === 1 ? 232 : 200, end: layoutPhase === 1 ? 303 : 271 },
                    },
                    {
                      itag: 140,
                      init_range: { start: 0, end: 231 },
                      index_range: { start: 232, end: 303 },
                    },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const ytDlpM6: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          if (useAuth) layoutPhase = 2;
          return {
            id: videoId,
            title: "Reload Refresh",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---p${layoutPhase}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
              {
                format_id: "140",
                ext: "m4a",
                protocol: "https",
                container: "m4a_dash",
                vcodec: "none",
                acodec: "mp4a.40.2",
                tbr: 128,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---p${layoutPhase}.googlevideo.com/videoplayback?itag=140&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const cfgM6 = makeTestConfig(tmpDir, { authEnabled: true });
      cfgM6.playback.ephemeralBuffer.enabled = false;
      const appM6 = createApp(cfgM6, {
        logger: noopLogger,
        ytDlp: ytDlpM6,
        innertube: dynIt,
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
      });

      const mpd1 = await (await appM6.fetch(new Request("http://127.0.0.1:8787/api/manifest/dash/id/abc123XYZ99"))).text();
      expect(mpd1).toContain("layout=0-231_232-303");

      // Segment fails 403 -> Tier 2 discovers layout 0-199_200-271 -> Tier 3 disabled -> returns 503
      const url1 = /<BaseURL>([^<]+itag=137[^<]*)<\/BaseURL>/.exec(mpd1)![1]!.replaceAll("&amp;", "&");
      const segFail = await appM6.fetch(new Request(url1, { headers: { Range: "bytes=0-49" } }));
      expect(segFail.status).toBe(503);

      // Fresh MPD request MUST return the NEW layout instead of reissuing the stale broken manifest!
      const mpd2 = await (await appM6.fetch(new Request("http://127.0.0.1:8787/api/manifest/dash/id/abc123XYZ99"))).text();
      expect(mpd2).toContain("layout=0-199_200-271");
      appM6.stop();

      // Part C (M9): Audio-only Tier 1 MUST NOT stop DASH MPD escalation -> escalates to Tier 2 for video+audio pair!
      const tierCalls: boolean[] = [];
      const ytDlpM9: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          tierCalls.push(useAuth);
          const audioFmt = {
            format_id: "140",
            ext: "m4a",
            protocol: "https",
            container: "m4a_dash",
            vcodec: "none",
            acodec: "mp4a.40.2",
            tbr: 128,
            filesize: mp4Bytes.byteLength,
            url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
          };
          const videoFmt = {
            format_id: "137",
            ext: "mp4",
            protocol: "https",
            container: "mp4_dash",
            vcodec: "avc1.640028",
            acodec: "none",
            width: 1920,
            height: 1080,
            fps: 30,
            tbr: 2000,
            filesize: mp4Bytes.byteLength,
            url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
          };
          // Tier 1 returns ONLY audio; Tier 2 returns both video + audio
          return {
            id: videoId,
            title: "Incomplete DASH Escalation",
            duration: 60,
            formats: useAuth ? [videoFmt, audioFmt] : [audioFmt],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const itM9 = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: {
                  adaptive_formats: [
                    { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    { itag: 140, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                  ],
                },
                basic_info: {},
                watch_next_feed: [],
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const appM9 = createApp(makeTestConfig(tmpDir, { authEnabled: true }), {
        logger: noopLogger,
        ytDlp: ytDlpM9,
        innertube: itM9,
      });
      const mpdRes = await appM9.fetch(new Request("http://127.0.0.1:8787/api/manifest/dash/id/abc123XYZ99"));
      expect(mpdRes.status).toBe(200);
      const mpdXml = await mpdRes.text();
      expect(mpdXml).toContain('mimeType="video/mp4"');
      expect(mpdXml).toContain('mimeType="audio/mp4"');
      expect(tierCalls).toEqual([false, true]);
      appM9.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Round 4 C1/C2/C3/M12: isolates per-rep storage & reservations, verifies remote recovery digests, enforces rev/xtags, and never re-registers retired files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r4-c1c2c3-"));
    try {
      const mp4A = makeMp4StreamBytes(600);
      const mp4B = makeMp4StreamBytes(600);
      // Same length & same box boundaries (0-231 / 232-303), but different sidx payload byte!
      mp4B[250] = (mp4B[250] ?? 0) ^ 0xff;

      // 1) C2: Remote recovery candidate with matching (clen, layout) but tampered sidx bytes MUST be rejected!
      let phase = 1;
      let candidateBytes = mp4B;
      const ytDlpC2: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          const hostTag = useAuth ? `tier2-p${phase}` : "tier1";
          return {
            id: videoId,
            title: "Digest Verify Recovery",
            duration: 60,
            formats: [
              {
                format_id: "137",
                ext: "mp4",
                protocol: "https",
                container: "mp4_dash",
                vcodec: "avc1.640028",
                acodec: "none",
                width: 1920,
                height: 1080,
                fps: 30,
                tbr: 2000,
                filesize: mp4A.byteLength,
                url: `https://rr1---${hostTag}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4A.byteLength}&lmt=1700000111&xtags=acont%3Doriginal`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      let failTier1 = false;
      const appC2 = createApp(makeTestConfig(tmpDir, { authEnabled: true }), {
        logger: noopLogger,
        ytDlp: ytDlpC2,
        innertube: makeMockInnertube(),
        fetchRawFn: async (input, init) => {
          const u = input.toString();
          const range = new Headers(init?.headers).get("range") || "";
          if (u.includes("tier1") && failTier1) {
            return new Response("Forbidden", { status: 403 });
          }
          const src = u.includes("tier1") ? mp4A : candidateBytes;
          const m = /^bytes=(\d+)-(\d+)$/.exec(range);
          if (!m) {
            return new Response(src, {
              status: 200,
              headers: { "Content-Length": String(src.byteLength) },
            });
          }
          const s = Number(m[1]);
          const e = Number(m[2]);
          const slice = src.slice(s, e + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Range": `bytes ${s}-${e}/${src.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        },
      });
      // Disable Tier 3 so we isolate remote recovery verification
      appC2.config.playback.ephemeralBuffer.enabled = false;

      const vJson = (await (await appC2.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const playUrl = vJson.adaptiveFormats[0].url as string;
      // C3: Issued URL must bind rev (lmt) and xtags!
      expect(playUrl).toContain("rev=1700000111");
      expect(playUrl).toContain("xtags=acont%3Doriginal");

      // Mismatched rev or xtags MUST return 410 Gone
      const badRevUrl = playUrl.replace("rev=1700000111", "rev=1700000999");
      expect((await appC2.fetch(new Request(badRevUrl, { headers: { Range: "bytes=0-49" } }))).status).toBe(410);
      const badXtagsUrl = playUrl.replace("xtags=acont%3Doriginal", "xtags=acont%3Ddubbed");
      expect((await appC2.fetch(new Request(badXtagsUrl, { headers: { Range: "bytes=0-49" } }))).status).toBe(410);

      // Shaka fetches sidx range 232-303 -> daemon captures authoritative indexHash for mp4A
      const idxRes = await appC2.fetch(new Request(playUrl, { headers: { Range: "bytes=232-303" } }));
      expect(idxRes.status).toBe(206);
      await idxRes.arrayBuffer();

      // Now Tier 1 returns 403; Tier 2 returns SAME clen/layout/lmt/xtags, DIFFERENT sidx bytes (mp4B) -> MUST reject!
      failTier1 = true;
      candidateBytes = mp4B;
      const rejRes = await appC2.fetch(new Request(playUrl, { headers: { Range: "bytes=304-353" } }));
      expect(rejRes.status).toBe(503);
      const tAfterReject = appC2.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(tAfterReject?.kind === "remote" && tAfterReject.url.includes("tier1")).toBe(true);

      // Next, fresh record with matching Tier 2 bytes (mp4A) MUST pass remote digest verification and serve 206!
      phase = 2;
      failTier1 = false;
      appC2.resolver.invalidateVideo("abc123XYZ99");
      const vJson2 = (await (await appC2.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const playUrl2 = vJson2.adaptiveFormats[0].url as string;
      const idxRes2 = await appC2.fetch(new Request(playUrl2, { headers: { Range: "bytes=232-303" } }));
      expect(idxRes2.status).toBe(206);
      await idxRes2.arrayBuffer();

      failTier1 = true;
      candidateBytes = mp4A;
      const okRes = await appC2.fetch(new Request(playUrl2, { headers: { Range: "bytes=304-353" } }));
      expect(okRes.status).toBe(206);
      expect(okRes.headers.get("x-steadytube-tier")).toBe("2");
      appC2.stop();

      // 2) C1 & M12: Two distinct representations for same (vid, fid) use distinct disk paths AND retired local file is NEVER re-registered
      const subDir = path.join(tmpDir, "c1-m12");
      const writtenPaths: string[] = [];
      let revPhase = 1;
      const appC1 = createApp(makeTestConfig(subDir, { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            const bytes = revPhase === 1 ? mp4A : mp4B;
            return {
              id: videoId,
              title: "Distinct Rep Storage",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: bytes.byteLength,
                  url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${bytes.byteLength}&lmt=${revPhase === 1 ? "111" : "222"}`,
                },
              ],
            };
          },
          async downloadFormat(_id, _sel, outPath) {
            writtenPaths.push(outPath);
            fs.writeFileSync(outPath, revPhase === 1 ? mp4A : mp4B);
            return outPath;
          },
        },
      });

      const u1 = ((await (await appC1.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;
      const r1 = await appC1.fetch(new Request(u1, { headers: { Range: "bytes=232-303" } }));
      expect(r1.status).toBe(206);
      expect(new Uint8Array(await r1.arrayBuffer())).toEqual(mp4A.subarray(232, 304));

      revPhase = 2;
      appC1.resolver.invalidateVideo("abc123XYZ99");
      const u2 = ((await (await appC1.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;
      const r2 = await appC1.fetch(new Request(u2, { headers: { Range: "bytes=232-303" } }));
      expect(r2.status).toBe(206);
      expect(new Uint8Array(await r2.arrayBuffer())).toEqual(mp4B.subarray(232, 304));

      // Two distinct immutable paths on disk, and BOTH files survive simultaneously!
      expect(writtenPaths.length).toBe(2);
      expect(writtenPaths[0]).not.toBe(writtenPaths[1]);
      expect(fs.existsSync(writtenPaths[0]!)).toBe(true);
      expect(fs.existsSync(writtenPaths[1]!)).toBe(true);

      // Cache-miss disk shortcut honors persisted rev & serves exact rep without mismatch
      appC1.resolver.invalidateVideo("abc123XYZ99");
      const missR1 = await appC1.fetch(new Request(u1, { headers: { Range: "bytes=232-303" } }));
      expect(missR1.status).toBe(206);
      expect(new Uint8Array(await missR1.arrayBuffer())).toEqual(mp4A.subarray(232, 304));

      // M12: Retire a pinned local entry -> serveLocalTargetOr503 MUST return 503 and NEVER re-register retired path!
      const localRec = await appC1.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787");
      const r2Live = await appC1.fetch(new Request(u2, { headers: { Range: "bytes=0-49" } }));
      expect(r2Live.status).toBe(206);
      await r2Live.arrayBuffer();
      const target2 = localRec.targetsByFid.get("137");
      expect(target2?.kind).toBe("local");
      if (target2?.kind === "local") {
        const key2 = target2.storeKey!;
        appC1.ephemeralStore.pin(key2);
        appC1.ephemeralStore.deleteByKey(key2); // Retired while still on disk!
        expect(fs.existsSync(target2.filePath)).toBe(true);
        const retiredRes = await appC1.fetch(new Request(u2, { headers: { Range: "bytes=0-49" } }));
        expect(retiredRes.status).toBe(503);
        expect(appC1.ephemeralStore.getByKey(key2)).toBeNull();
        appC1.ephemeralStore.unpin(key2);
        expect(fs.existsSync(target2.filePath)).toBe(false);
      }
      appC1.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Round 4 C4/C5/M6/M7/M8: strict upstream 206/body framing, progressive multi-binding settle, publishPrimaryRecord, range guardrails, and cold Tier 3 auth/probe precedence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r4-c4c5m678-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);

      // 1) C4: withStallWatchdog detects truncated EOF & over-length upstream body and calls onStall
      let truncStalls = 0;
      const shortBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      });
      const guardedShort = withStallWatchdog(shortBody, 500, undefined, () => { truncStalls++; }, 50);
      await expect(new Response(guardedShort).arrayBuffer()).rejects.toThrow(/truncated/i);
      expect(truncStalls).toBe(1);

      let overStalls = 0;
      const overBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(60));
          controller.close();
        },
      });
      const guardedOver = withStallWatchdog(overBody, 500, undefined, () => { overStalls++; }, 50);
      await expect(new Response(guardedOver).arrayBuffer()).rejects.toThrow(/exceeded expected/i);
      expect(overStalls).toBe(1);

      // 2) C4 + M7: Malformed/mismatched upstream 206 rejected (never forwarded), and unsatisfiable Range returns 416 locally
      let upstreamMode: "missing-cr" | "wrong-interval" | "wildcard-total" | "bad-cl" | "ok" = "missing-cr";
      let upstreamCalls = 0;
      const appC4 = createApp(makeTestConfig(path.join(tmpDir, "c4"), { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Framing Check",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
        },
        fetchRawFn: async () => {
          upstreamCalls++;
          if (upstreamMode === "missing-cr") {
            return new Response(mp4Bytes.slice(0, 50), { status: 206, headers: { "Content-Length": "50" } });
          }
          if (upstreamMode === "wrong-interval") {
            return new Response(mp4Bytes.slice(10, 60), {
              status: 206,
              headers: { "Content-Range": `bytes 10-59/${mp4Bytes.byteLength}`, "Content-Length": "50" },
            });
          }
          if (upstreamMode === "wildcard-total") {
            return new Response(mp4Bytes.slice(0, 50), {
              status: 206,
              headers: { "Content-Range": "bytes 0-49/*", "Content-Length": "50" },
            });
          }
          if (upstreamMode === "bad-cl") {
            return new Response(mp4Bytes.slice(0, 50), {
              status: 206,
              headers: { "Content-Range": `bytes 0-49/${mp4Bytes.byteLength}`, "Content-Length": "40" },
            });
          }
          return new Response(mp4Bytes.slice(0, 50), {
            status: 206,
            headers: { "Content-Range": `bytes 0-49/${mp4Bytes.byteLength}`, "Content-Length": "50" },
          });
        },
      });
      appC4.config.playback.ephemeralBuffer.enabled = false;

      const uC4 = ((await (await appC4.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;

      // M7: Unsatisfiable range returns 416 immediately WITHOUT hitting upstream!
      const unsatRes = await appC4.fetch(
        new Request(uC4, { headers: { Range: `bytes=${mp4Bytes.byteLength + 100}-` } }),
      );
      expect(unsatRes.status).toBe(416);
      expect(unsatRes.headers.get("content-range")).toBe(`bytes */${mp4Bytes.byteLength}`);
      expect(unsatRes.headers.get("content-length")).toBe("0");
      expect(upstreamCalls).toBe(0);

      for (const mode of ["missing-cr", "wrong-interval", "wildcard-total", "bad-cl"] as const) {
        upstreamMode = mode;
        const badRes = await appC4.fetch(new Request(uC4, { headers: { Range: "bytes=0-49" } }));
        expect(badRes.status).not.toBe(206);
      }
      upstreamMode = "ok";
      const okC4 = await appC4.fetch(new Request(uC4, { headers: { Range: "bytes=0-49" } }));
      expect(okC4.status).toBe(206);
      appC4.stop();

      // 3) C5: Reused progressive handle settles ALL bound cache slots on failure (restoring fallbackRemote, not stuck at 503!)
      let rejectProg!: (err: Error) => void;
      let progStarts = 0;
      const appC5 = createApp(makeTestConfig(path.join(tmpDir, "c5"), { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        fetchRawFn: async () => new Response("Forbidden", { status: 403 }),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Progressive Multi-Binding",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
          async startProgressiveDownload(videoId, sel, outPath, opts): Promise<ProgressiveDownloadHandle> {
            progStarts++;
            const tmpPath = `${outPath}.c5.tmp.mp4`;
            fs.writeFileSync(tmpPath, mp4Bytes);
            let status: "downloading" | "completed" | "failed" = "downloading";
            const done = new Promise<{ filePath: string; size: number }>((_, reject) => {
              rejectProg = (err) => {
                status = "failed";
                reject(err);
              };
            });
            return {
              videoId,
              formatId: opts.cacheFormatId || sel,
              mimeType: opts.mimeType,
              expectedSize: opts.expectedSize,
              done,
              getReadablePath: () => tmpPath,
              getAvailableBytes: () => mp4Bytes.byteLength,
              getStatus: () => status,
              getError: () => (status === "failed" ? new Error("idle") : null),
              touch: () => {},
              cancel: () => { status = "failed"; },
              waitForBytes: () => Promise.resolve(),
            };
          },
        },
      });

      const uC5 = ((await (await appC5.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;
      const pRes1 = await appC5.fetch(new Request(uC5, { headers: { Range: "bytes=0-49" } }));
      expect(pRes1.status).toBe(206);
      expect(progStarts).toBe(1);

      // Invalidate cache & resolve fresh record gen 2 -> reuses the SAME active progressive handle!
      appC5.resolver.invalidateVideo("abc123XYZ99");
      await appC5.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      const pRes2 = await appC5.fetch(new Request(uC5, { headers: { Range: "bytes=0-49" } }));
      expect(pRes2.status).toBe(206);
      expect(progStarts).toBe(1); // Reused!

      // Fail progressive handle with IdleCancelledError -> MUST restore gen 2's cache slot back to remote target!
      const idleErr = new Error("idle cancelled");
      idleErr.name = "IdleCancelledError";
      rejectProg(idleErr);
      await new Promise((r) => setTimeout(r, 20));
      const slotAfterFail = appC5.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(slotAfterFail?.kind).toBe("remote");
      appC5.stop();

      // 4) M6: Slower incomplete resolveVideo MUST NOT overwrite a faster complete DASH record
      let releaseSlowMuxed!: () => void;
      let slowMuxedStarted!: () => void;
      const slowStartedPromise = new Promise<void>((r) => { slowMuxedStarted = r; });
      let extractIdx = 0;
      const appM6 = createApp(makeTestConfig(path.join(tmpDir, "m6"), { authEnabled: false }), {
        logger: noopLogger,
        innertube: {
          async getClient() {
            return {
              async getInfo() {
                return {
                  streaming_data: {
                    adaptive_formats: [
                      { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                      { itag: 140, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    ],
                  },
                  basic_info: {},
                  watch_next_feed: [],
                };
              },
            };
          },
          reset() {},
        } as unknown as AnonymousInnertubeProvider,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            const myCall = ++extractIdx;
            if (myCall === 1) {
              slowMuxedStarted();
              await new Promise<void>((r) => { releaseSlowMuxed = r; });
              // Slow call returns muxed-only (no complete DASH pair!)
              return {
                id: videoId,
                title: "Slow Muxed",
                duration: 60,
                formats: [
                  {
                    format_id: "18",
                    ext: "mp4",
                    protocol: "https",
                    vcodec: "avc1.42001E",
                    acodec: "mp4a.40.2",
                    width: 640,
                    height: 360,
                    fps: 30,
                    tbr: 500,
                    url: "https://rr1---muxed.googlevideo.com/videoplayback?itag=18&dur=60&expire=1999999999",
                  },
                ],
              };
            }
            // Fast DASH call returns complete video + audio DASH pair
            return {
              id: videoId,
              title: "Fast Complete DASH",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---dash.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
                {
                  format_id: "140",
                  ext: "m4a",
                  protocol: "https",
                  container: "m4a_dash",
                  vcodec: "none",
                  acodec: "mp4a.40.2",
                  tbr: 128,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---dash.googlevideo.com/videoplayback?itag=140&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
        },
      });

      const slowVideoPromise = appM6.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787");
      await slowStartedPromise;
      const fastDashRec = await appM6.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", {
        requireDashPair: true,
      });
      expect(fastDashRec.adaptiveFormats.length).toBe(2);
      releaseSlowMuxed();
      const slowResolved = await slowVideoPromise;
      // Primary cache MUST remain the complete DASH record (NOT overwritten by slower muxed-only call!)
      expect(slowResolved.adaptiveFormats.length).toBe(2);
      expect(appM6.resolver.getCached("abc123XYZ99")?.adaptiveFormats.length).toBe(2);
      appM6.stop();

      // 5) M8: Cold Tier 3 uses same auth mode as ytInfo for downloadWithAuthFallback
      const coldAuthOrder: boolean[] = [];
      const coldVidBytes = makeGlobalSidxMp4Bytes(200);
      const coldAudBytes = makeGlobalSidxMp4Bytes(120);
      const appM8 = createApp(makeTestConfig(path.join(tmpDir, "m8"), { authEnabled: true }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
            if (!useAuth) throw new Error("bot check");
            return {
              id: videoId,
              title: "Auth-Aligned Cold Tier 3",
              duration: 60,
              formats: [
                { format_id: "137", ext: "mp4", protocol: "m3u8_native", vcodec: "avc1.640028", acodec: "none", width: 1920, height: 1080, fps: 30, tbr: 2000 },
                { format_id: "140", ext: "m4a", protocol: "m3u8_native", vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
              ],
            };
          },
          async downloadFormat(_id, sel, outPath, opts) {
            coldAuthOrder.push(opts.useAuth);
            fs.writeFileSync(outPath, sel === "137" ? coldVidBytes : coldAudBytes);
            return outPath;
          },
        },
      });
      const coldRec = await appM8.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787");
      expect(coldRec.tier).toBe(3);
      // Both video & audio downloads used auth=true FIRST, matching ytInfoUsedAuth!
      expect(coldAuthOrder).toEqual([true, true]);
      // Cold Tier 3 URLs MUST carry rev=h:<digest>
      expect(coldRec.adaptiveFormats[0]!.url).toContain("rev=h%3A");
      appM8.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Round 5 #1-#6/#9-#15/#18: h:rev recovery preservation, strict yt-dlp meta match, primary tier race, cold Tier 3 coalescing/budget/rev/corrupt-cleanup, shutdown lock drain, and strict framing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r5-"));
    try {
      const mp4Bytes = makeMp4StreamBytes(600);

      // 1) #2: findMatchingYtDlpFormatId requires exact lmt and xtags (missing in candidate URL -> rejected)
      expect(
        findMatchingYtDlpFormatId(
          [
            {
              format_id: "137",
              ext: "mp4",
              protocol: "https",
              filesize: mp4Bytes.byteLength,
              url: `https://rr1---test.googlevideo.com/videoplayback?itag=137&clen=${mp4Bytes.byteLength}`,
            },
          ],
          {
            formatId: "137",
            itag: 137,
            clen: mp4Bytes.byteLength,
            lmt: "1700000111",
            xtags: "acont=original",
          },
        ),
      ).toBeNull();
      expect(
        findMatchingYtDlpFormatId(
          [
            {
              format_id: "137",
              ext: "mp4",
              protocol: "https",
              filesize: mp4Bytes.byteLength,
              url: `https://rr1---test.googlevideo.com/videoplayback?itag=137&clen=${mp4Bytes.byteLength}&lmt=1700000111&xtags=acont%3Doriginal`,
            },
          ],
          {
            formatId: "137",
            itag: 137,
            clen: mp4Bytes.byteLength,
            lmt: "1700000111",
            xtags: "acont=original",
          },
        ),
      ).toBe("137");

      // 2) #1: Failed target with hash-derived rev (`h:...`) recovering to refreshed target with lmt + matching digests
      // preserves `h:...` rev and succeeds cleanly; incompatible refresh NEVER mutates live cache!
      let failTier1R1 = false;
      const appR1 = createApp(makeTestConfig(path.join(tmpDir, "r1"), { authEnabled: true }), {
        logger: noopLogger,
        innertube: {
          async getClient() {
            return { async getInfo() { return { streaming_data: {}, basic_info: {}, watch_next_feed: [] }; } };
          },
          reset() {},
        } as unknown as AnonymousInnertubeProvider,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Hash Rev Recovery",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  // Tier 1 has NO lmt (so rev=h:<digest> from initial remote probe), Tier 2 reports lmt=1700000555
                  url: useAuth
                    ? `https://rr1---t2.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}&lmt=1700000555`
                    : `https://rr1---t1.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
        },
        fetchRawFn: async (input, init) => {
          const u = input.toString();
          if (u.includes("rr1---t1") && failTier1R1) {
            return new Response("Forbidden", { status: 403 });
          }
          const range = new Headers(init?.headers).get("range") || "";
          const m = /^bytes=(\d+)-(\d+)$/.exec(range);
          if (!m) {
            return new Response(mp4Bytes, { status: 200, headers: { "Content-Length": String(mp4Bytes.byteLength) } });
          }
          const s = Number(m[1]);
          const e = Math.min(Number(m[2]), mp4Bytes.byteLength - 1);
          const slice = mp4Bytes.slice(s, e + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Range": `bytes ${s}-${e}/${mp4Bytes.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        },
      });
      appR1.config.playback.ephemeralBuffer.enabled = false;
      const vR1 = (await (await appR1.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const r1Url = vR1.adaptiveFormats[0].url as string;
      expect(r1Url).toContain("rev=h%3A");
      failTier1R1 = true;
      const r1RecRes = await appR1.fetch(new Request(r1Url, { headers: { Range: "bytes=304-353" } }));
      expect(r1RecRes.status).toBe(206);
      expect(r1RecRes.headers.get("x-steadytube-tier")).toBe("2");
      appR1.stop();

      // 3) #3: Older slower Tier 2 resolveVideo MUST NOT overwrite newer fresh complete Tier 1 record!
      let slowStarted!: () => void;
      const slowStartedP = new Promise<void>((r) => { slowStarted = r; });
      let releaseSlowTier2!: () => void;
      const appR3 = createApp(makeTestConfig(path.join(tmpDir, "r3"), { authEnabled: true }), {
        logger: noopLogger,
        innertube: {
          async getClient() {
            return {
              async getInfo() {
                return {
                  streaming_data: {
                    adaptive_formats: [
                      { itag: 137, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                      { itag: 140, init_range: { start: 0, end: 231 }, index_range: { start: 232, end: 303 } },
                    ],
                  },
                  basic_info: {},
                  watch_next_feed: [],
                };
              },
            };
          },
          reset() {},
        } as unknown as AnonymousInnertubeProvider,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
            if (useAuth) {
              slowStarted();
              await new Promise<void>((r) => { releaseSlowTier2 = r; });
            }
            return {
              id: videoId,
              title: useAuth ? "Older Slow Tier 2" : "Newer Fast Tier 1",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---${useAuth ? "slow-t2" : "fast-t1"}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
                {
                  format_id: "140",
                  ext: "m4a",
                  protocol: "https",
                  container: "m4a_dash",
                  vcodec: "none",
                  acodec: "mp4a.40.2",
                  tbr: 128,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---${useAuth ? "slow-t2" : "fast-t1"}.googlevideo.com/videoplayback?itag=140&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
        },
      });
      const olderSlowTier2 = appR3.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", {
        minTier: 2,
        maxTier: 2,
      });
      await slowStartedP;
      const newerFastTier1 = await appR3.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", {
        requireDashPair: true,
      });
      expect(newerFastTier1.tier).toBe(1);
      releaseSlowTier2();
      const slowOut = await olderSlowTier2;
      expect(slowOut.tier).toBe(1);
      expect(appR3.resolver.getCached("abc123XYZ99")?.tier).toBe(1);
      appR3.stop();

      // 4) #4, #5, #9, #10, #18 & Mistral Nit 4: Cold Tier 3 coalescing, tight-budget cache reuse,
      // sourceRev change isolation, corrupt disk file cleanup, and shutdown lock drain!
      const vidA = makeGlobalSidxMp4Bytes(400);
      const audA = makeGlobalSidxMp4Bytes(300);
      const vidB = makeGlobalSidxMp4Bytes(420);
      let coldLmt = "111";
      let coldDownloads = 0;
      let holdNextDownload = false;
      let dlStarted!: () => void;
      let releaseDl!: () => void;
      const dlStartedP = new Promise<void>((r) => { dlStarted = r; });

      // Tight maxCacheBytes: vidA (~592B) + audA (~492B) = ~1084B; cap = 1400B so re-charging cached vidA would fail!
      const coldDir = path.join(tmpDir, "cold-r5");
      const coldCfg = makeTestConfig(coldDir, { authEnabled: false });
      coldCfg.playback.ephemeralBuffer.maxCacheBytes = vidA.byteLength + audA.byteLength + 200;
      const appCold = createApp(coldCfg, {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Cold Tier 3 Checks",
              duration: 99,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "m3u8_native",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  url: `https://rr1---sn.googlevideo.com/videoplayback?itag=137&lmt=${coldLmt}`,
                },
                {
                  format_id: "140",
                  ext: "m4a",
                  protocol: "m3u8_native",
                  vcodec: "none",
                  acodec: "mp4a.40.2",
                  abr: 128,
                  url: `https://rr1---sn.googlevideo.com/videoplayback?itag=140&lmt=${coldLmt}`,
                },
              ],
            };
          },
          async downloadFormat(_id, sel, outPath) {
            coldDownloads++;
            if (holdNextDownload) {
              holdNextDownload = false;
              dlStarted();
              await new Promise<void>((r) => { releaseDl = r; });
            }
            const data = sel === "137" ? (coldLmt === "111" ? vidA : vidB) : audA;
            fs.writeFileSync(outPath, data);
            return outPath;
          },
        },
      });

      // Concurrent cold Tier 3 calls coalesce into a single video+audio download pair (2 downloads total, not 4)
      const [c1, c2] = await Promise.all([
        appCold.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3 }),
        appCold.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3, forceRefresh: true }),
      ]);
      expect(c1.tier).toBe(3);
      expect(c2.tier).toBe(3);
      expect(coldDownloads).toBe(2);

      // Re-resolving under tight maxCacheBytes MUST reuse cached files without double-charging pinned size!
      appCold.resolver.invalidateVideo("abc123XYZ99");
      const cReuse = await appCold.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3 });
      expect(cReuse.tier).toBe(3);
      expect(coldDownloads).toBe(2); // Reused!

      // Changing upstream sourceRev (lmt=222) MUST NOT reuse stale lmt=111 cached file!
      coldLmt = "222";
      // Increase cap slightly so both rev 111 and rev 222 can briefly coexist before eviction
      appCold.config.playback.ephemeralBuffer.maxCacheBytes = 50_000;
      const appCold2Dir = path.join(tmpDir, "cold-r5-rev");
      const appColdRev = createApp(makeTestConfig(appCold2Dir, { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Cold Rev Change",
              duration: 99,
              formats: [
                { format_id: "137", ext: "mp4", protocol: "m3u8_native", vcodec: "avc1.640028", acodec: "none", width: 1920, height: 1080, fps: 30, url: `https://rr1---sn.googlevideo.com/videoplayback?itag=137&lmt=${coldLmt}` },
                { format_id: "140", ext: "m4a", protocol: "m3u8_native", vcodec: "none", acodec: "mp4a.40.2", abr: 128, url: `https://rr1---sn.googlevideo.com/videoplayback?itag=140&lmt=${coldLmt}` },
              ],
            };
          },
          async downloadFormat(_id, sel, outPath) {
            fs.writeFileSync(outPath, sel === "137" ? (coldLmt === "111" ? vidA : vidB) : audA);
            return outPath;
          },
        },
      });
      coldLmt = "111";
      const rev1Rec = await appColdRev.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3 });
      const rev1Target = rev1Rec.targetsByFid.get("tier3-v-137");
      expect(rev1Target?.kind === "local" && rev1Target.size).toBe(vidA.byteLength);

      // Corrupt disk file -> next resolve deletes corrupt file and re-downloads cleanly (Mistral Nit 4)
      if (rev1Target?.kind === "local") {
        fs.writeFileSync(rev1Target.filePath, new Uint8Array(64).fill(0));
      }
      appColdRev.resolver.invalidateVideo("abc123XYZ99");
      const healedRec = await appColdRev.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3 });
      const healedTarget = healedRec.targetsByFid.get("tier3-v-137");
      expect(healedTarget?.kind === "local" && healedTarget.size).toBe(vidA.byteLength);

      // Now lmt changes to 222 -> MUST download vidB into a new file rather than reusing vidA!
      coldLmt = "222";
      appColdRev.resolver.invalidateVideo("abc123XYZ99");
      const rev2Rec = await appColdRev.resolver.resolveVideo("abc123XYZ99", "http://127.0.0.1:8787", { minTier: 3 });
      const rev2Target = rev2Rec.targetsByFid.get("tier3-v-137");
      expect(rev2Target?.kind === "local" && rev2Target.size).toBe(vidB.byteLength);
      appColdRev.stop();

      // #9: Calling stop() while a cold Tier 3 download is active keeps .steadytube.lock held until awaitShutdown() drains!
      holdNextDownload = true;
      appCold.resolver.invalidateVideo("abc123XYZ99");
      const inflightCold = appCold.resolver
        .resolveVideo("vidDrain123", "http://127.0.0.1:8787", { minTier: 3 })
        .catch(() => null);
      await dlStartedP;
      appCold.stop();
      expect(appCold.ephemeralStore.isClosed()).toBe(true);
      expect(fs.existsSync(path.join(coldDir, ".steadytube.lock"))).toBe(true);
      releaseDl();
      await inflightCold;
      await appCold.awaitShutdown(1000);
      expect(fs.existsSync(path.join(coldDir, ".steadytube.lock"))).toBe(false);

      // 5) #6: Gen 2 progressive failure restores Gen 2's fallbackRemote (NEVER Gen 1's), and
      // serveTarget falls through to fallbackRemote when progressive download fails mid-wait!
      let genCount = 0;
      let failProgNow!: () => void;
      let allowGen2Upstream = false;
      const appR6 = createApp(makeTestConfig(path.join(tmpDir, "r6"), { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        fetchRawFn: async (input, init) => {
          if (allowGen2Upstream && input.toString().includes("gen2")) {
            const range = new Headers(init?.headers).get("range") || "bytes=0-49";
            const m = /^bytes=(\d+)-(\d+)$/.exec(range);
            const s = m ? Number(m[1]) : 0;
            const e = m ? Number(m[2]) : 49;
            const slice = mp4Bytes.slice(s, e + 1);
            return new Response(slice, {
              status: 206,
              headers: {
                "Content-Range": `bytes ${s}-${e}/${mp4Bytes.byteLength}`,
                "Content-Length": String(slice.byteLength),
              },
            });
          }
          return new Response("Forbidden", { status: 403 });
        },
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            const g = ++genCount;
            return {
              id: videoId,
              title: `Gen ${g}`,
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---gen${g}.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
          async startProgressiveDownload(videoId, sel, outPath, opts): Promise<ProgressiveDownloadHandle> {
            const tmpPath = `${outPath}.r6.tmp.mp4`;
            fs.writeFileSync(tmpPath, mp4Bytes.subarray(0, 350));
            let status: "downloading" | "completed" | "failed" = "downloading";
            const waiters: Array<() => void> = [];
            const done = new Promise<{ filePath: string; size: number }>((_, reject) => {
              failProgNow = () => {
                status = "failed";
                for (const w of waiters.splice(0)) w();
                reject(new Error("upstream dropped"));
              };
            });
            return {
              videoId,
              formatId: opts.cacheFormatId || sel,
              mimeType: opts.mimeType,
              expectedSize: opts.expectedSize,
              done,
              getReadablePath: () => tmpPath,
              getAvailableBytes: () => 350,
              getStatus: () => status,
              getError: () => (status === "failed" ? new Error("upstream dropped") : null),
              touch: () => {},
              cancel: () => { status = "failed"; },
              waitForBytes(minBytes) {
                if (status !== "downloading" || 350 >= minBytes) return Promise.resolve();
                return new Promise<void>((resolve) => waiters.push(resolve));
              },
            };
          },
        },
      });
      const uG1 = ((await (await appR6.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;
      expect((await appR6.fetch(new Request(uG1, { headers: { Range: "bytes=0-49" } }))).status).toBe(206);
      appR6.resolver.invalidateVideo("abc123XYZ99");
      const uG2 = ((await (await appR6.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any).adaptiveFormats[0].url as string;
      expect((await appR6.fetch(new Request(uG2, { headers: { Range: "bytes=0-49" } }))).status).toBe(206);

      // Start a Gen 2 read waiting past available bytes (400..449), then fail progressive handle while Gen 2 upstream works!
      allowGen2Upstream = true;
      const midWaitReq = appR6.fetch(new Request(uG2, { headers: { Range: "bytes=400-449" } }));
      await new Promise((r) => setTimeout(r, 10));
      failProgNow();
      await new Promise((r) => setTimeout(r, 20));
      const slotG2 = appR6.resolver.getStreamTarget("abc123XYZ99", "137", 137);
      expect(slotG2?.kind).toBe("remote");
      // MUST restore Gen 2's URL (rr1---gen2), NEVER Gen 1's (rr1---gen1)!
      expect(slotG2?.kind === "remote" && slotG2.url.includes("rr1---gen2")).toBe(true);
      const midWaitRes = await midWaitReq;
      // Fell through to fallbackRemote (rr1---gen2) instead of returning 503!
      expect(midWaitRes.status).toBe(206);
      appR6.stop();

      // 6) #12, #13, #14, #15 & GLM Minor 1: Ranged HEAD fast-path, gzip rejection, unsolicited 206 rejection,
      // upstream 416 error-body sanitization without stale-marking, direct ?host= validation, and huge rawEnd!
      let directMode: "gzip" | "unsolicited-206" | "416-with-body" | "ok" = "gzip";
      let upstreamHitCount = 0;
      const appFraming = createApp(makeTestConfig(path.join(tmpDir, "framing"), { authEnabled: false }), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo(videoId): Promise<YtDlpVideoInfo> {
            return {
              id: videoId,
              title: "Framing R5",
              duration: 60,
              formats: [
                {
                  format_id: "137",
                  ext: "mp4",
                  protocol: "https",
                  container: "mp4_dash",
                  vcodec: "avc1.640028",
                  acodec: "none",
                  width: 1920,
                  height: 1080,
                  fps: 30,
                  tbr: 2000,
                  filesize: mp4Bytes.byteLength,
                  url: `https://rr1---sn.googlevideo.com/videoplayback?itag=137&dur=60&expire=1999999999&clen=${mp4Bytes.byteLength}`,
                },
                {
                  format_id: "18",
                  ext: "mp4",
                  protocol: "https",
                  vcodec: "avc1.42001E",
                  acodec: "mp4a.40.2",
                  width: 640,
                  height: 360,
                  fps: 30,
                  tbr: 500,
                  url: "https://rr1---unknownlen.googlevideo.com/videoplayback?itag=18&dur=60&expire=1999999999",
                },
              ],
            };
          },
          async downloadFormat() { throw new Error("unused"); },
        },
        fetchRawFn: async () => {
          upstreamHitCount++;
          if (directMode === "gzip") {
            return new Response(mp4Bytes.slice(0, 50), {
              status: 206,
              headers: {
                "Content-Range": `bytes 0-49/${mp4Bytes.byteLength}`,
                "Content-Length": "50",
                "Content-Encoding": "gzip",
              },
            });
          }
          if (directMode === "unsolicited-206") {
            return new Response(mp4Bytes.slice(0, 50), {
              status: 206,
              headers: {
                "Content-Range": `bytes 0-49/${mp4Bytes.byteLength}`,
                "Content-Length": "50",
              },
            });
          }
          if (directMode === "416-with-body") {
            return new Response("<html>Requested Range Not Satisfiable</html>", {
              status: 416,
              headers: { "Content-Range": "bytes */500", "Content-Length": "42" },
            });
          }
          return new Response(mp4Bytes, {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-${mp4Bytes.byteLength - 1}/${mp4Bytes.byteLength}`,
              "Content-Length": String(mp4Bytes.byteLength),
            },
          });
        },
      });
      appFraming.config.playback.ephemeralBuffer.enabled = false;
      const vFraming = (await (await appFraming.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"))).json()) as any;
      const url137 = vFraming.adaptiveFormats[0].url as string;
      const url18 = vFraming.formatStreams[0].url as string;

      // #14: Ranged HEAD hits exact-clen fast path with 0 upstream calls
      const rangedHead = await appFraming.fetch(
        new Request(url137, { method: "HEAD", headers: { Range: "bytes=0-49" } }),
      );
      expect(rangedHead.status).toBe(200);
      expect(rangedHead.headers.get("content-length")).toBe(String(mp4Bytes.byteLength));
      expect(upstreamHitCount).toBe(0);

      // #12: Content-Encoding: gzip on 206 is rejected
      directMode = "gzip";
      const gzipRes = await appFraming.fetch(new Request(url137, { headers: { Range: "bytes=0-49" } }));
      expect(gzipRes.status).not.toBe(206);

      // #12: Unsolicited 206 on multi-range (ignored Range) is rejected
      directMode = "unsolicited-206";
      const multiRes = await appFraming.fetch(
        new Request(url137, { headers: { Range: "bytes=0-10, 20-30" } }),
      );
      expect(multiRes.status).not.toBe(206);

      // #13: Upstream 416 with HTML error body returns clean empty 416 (Content-Length: 0) and does NOT mark target stale!
      directMode = "416-with-body";
      const r416 = await appFraming.fetch(new Request(url18, { headers: { Range: "bytes=1000-2000" } }));
      expect(r416.status).toBe(416);
      expect(r416.headers.get("content-length")).toBe("0");
      expect(r416.headers.get("content-range")).toBe("bytes */500");
      expect((await r416.arrayBuffer()).byteLength).toBe(0);
      const t18 = appFraming.resolver.getStreamTarget("abc123XYZ99", "18", 18);
      expect(t18?.kind === "remote" && !t18.stale).toBe(true);

      // #15: Unknown-length huge rawEnd (400 digits) is NOT treated as unsatisfiable!
      directMode = "ok";
      const hugeEndRes = await appFraming.fetch(
        new Request(url18, { headers: { Range: `bytes=0-${"9".repeat(400)}` } }),
      );
      expect(hugeEndRes.status).toBe(206);

      // GLM Minor 1: Direct ?host= proxy rejects gzip 206 and unsolicited 206
      directMode = "gzip";
      const directGzip = await appFraming.fetch(
        new Request("http://127.0.0.1:8787/videoplayback?host=rr1---sn.googlevideo.com&itag=137", {
          headers: { Range: "bytes=0-49" },
        }),
      );
      expect(directGzip.status).toBe(502);

      directMode = "unsolicited-206";
      const directUnsolicited = await appFraming.fetch(
        new Request("http://127.0.0.1:8787/videoplayback?host=rr1---sn.googlevideo.com&itag=137"),
      );
      expect(directUnsolicited.status).toBe(502);
      appFraming.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
