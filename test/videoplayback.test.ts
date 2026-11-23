import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import { noopLogger } from "../src/logger.ts";
import type { AnonymousInnertubeProvider } from "../src/innertube/client.ts";
import type { YtDlpRunner, YtDlpVideoInfo } from "../src/media/ytdlp.ts";
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
