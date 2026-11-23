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
  MAX_MID_PLAYBACK_TIER3_OFFSET_BYTES,
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
            formatId: formatSelector,
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
          fs.writeFileSync(tmpPath, new Uint8Array(1024).fill(7));
          const done = new Promise<{ filePath: string; size: number }>(() => {});
          return {
            videoId,
            formatId: formatSelector,
            mimeType: opts.mimeType,
            expectedSize: opts.expectedSize,
            done,
            getReadablePath: () => tmpPath,
            getAvailableBytes: () => 1024,
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
});
