import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import { noopLogger } from "../src/logger.ts";
import type { AnonymousInnertubeProvider } from "../src/innertube/client.ts";
import { YtDlpError, type YtDlpRunner, type YtDlpVideoInfo } from "../src/media/ytdlp.ts";
import { createApp } from "../src/server.ts";

function makeMp4StreamBytes(): Uint8Array<ArrayBuffer> {
  const makeBox = (type: string, payloadLen: number, fillByte: number) => {
    const b = new Uint8Array(8 + payloadLen);
    new DataView(b.buffer).setUint32(0, b.byteLength, false);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.fill(fillByte, 8);
    return b;
  };
  const ftyp = makeBox("ftyp", 16, 1); // 24 bytes (0..23)
  const moov = makeBox("moov", 200, 2); // 208 bytes (24..231)
  const sidx = makeBox("sidx", 64, 3); // 72 bytes (232..303)
  const mdat = makeBox("mdat", 700, 4); // 708 bytes (304..1011)
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength + sidx.byteLength + mdat.byteLength);
  let off = 0;
  for (const part of [ftyp, moov, sidx, mdat]) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

function makeTestConfig(cacheDir: string, authEnabled = true): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "error",
    configPath: "/tmp/test-config.json",
    cacheDir,
    logDir: "/tmp/test-logs",
    binaries: { ytDlp: "yt-dlp", deno: "deno", ffmpeg: null },
    playback: {
      videoCacheTtlSec: 1800,
      ytDlpTimeoutMs: 10_000,
      streamStallTimeoutMs: 5_000,
      bgutilPotUrl: "http://127.0.0.1:4416",
      enableBgutilPot: false,
      authFallback: {
        enabled: authEnabled,
        cookiesFromBrowser: "firefox",
        firefoxProfile: authEnabled ? "yt-fallback" : "",
      },
      ephemeralBuffer: {
        enabled: true,
        maxCacheBytes: 50 * 1024 * 1024,
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
            {
              itag: 140,
              init_range: { start: 0, end: 231 },
              index_range: { start: 232, end: 303 },
            },
          ],
        },
        secondary_info: {
          owner: {
            author: {
              thumbnails: [{ url: "https://yt3.ggpht.com/chan=s88", width: 88, height: 88 }],
            },
            subscriber_count: { text: "1.5M subscribers" },
          },
        },
        basic_info: { category: "Education", is_family_safe: true },
        watch_next_feed: [],
        storyboards: null,
        captions: null,
      };
    },
    async getSearchSuggestions(q: string) {
      return [`${q} tutorial`, `${q} live`];
    },
    async search(q: string) {
      return {
        results: [
          {
            type: "Video",
            id: "dQw4w9WgXcQ",
            title: { text: `Result for ${q}` },
            author: { name: "Test Channel", id: "UC1234567890123456789012" },
            duration: { seconds: 212 },
            view_count: { text: "10K views" },
            published: { text: "2 days ago" },
          },
        ],
        has_continuation: false,
      };
    },
    async resolveURL() {
      return { payload: { browseId: "UC1234567890123456789012" } };
    },
  };
  return {
    async getClient() {
      return fakeClient as any;
    },
    reset() {},
  } as unknown as AnonymousInnertubeProvider;
}

describe("Router, 3-Tier Escalation, and Media Proxies", () => {
  test("handles trailing slashes across stats, search, suggestions, and resolveurl", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-router-"));
    try {
      const dummyYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo() { throw new Error("unused"); },
        async downloadFormat() { throw new Error("unused"); },
      };
      const app = createApp(makeTestConfig(tmpDir), {
        logger: noopLogger,
        ytDlp: dummyYtDlp,
        innertube: makeMockInnertube(),
      });

      const statsRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/stats/"));
      expect(statsRes.status).toBe(200);
      const statsJson = (await statsRes.json()) as any;
      expect(statsJson.software.name).toBe("steadytube");

      const sugRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/search/suggestions/?q=bun"),
      );
      expect(sugRes.status).toBe(200);
      expect((await sugRes.json()) as any).toEqual({
        query: "bun",
        suggestions: ["bun tutorial", "bun live"],
      });

      const searchRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/search/?q=bun&page=1"),
      );
      expect(searchRes.status).toBe(200);
      const items = (await searchRes.json()) as any[];
      expect(items.length).toBe(1);
      expect(items[0].videoId).toBe("dQw4w9WgXcQ");

      const resolveRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/resolveurl/?url=https://youtube.com/@test"),
      );
      expect(resolveRes.status).toBe(200);
      expect((await resolveRes.json()) as any).toEqual({
        pageType: "WEB_PAGE_TYPE_CHANNEL",
        ucid: "UC1234567890123456789012",
      });

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("RSS feed proxy deduplicates concurrent burst requests and preserves 404s", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-rss-"));
    try {
      let upstreamCalls = 0;
      const mockFetch = async (input: string | URL | Request) => {
        const u = input.toString();
        upstreamCalls++;
        await new Promise((r) => setTimeout(r, 15));
        if (u.includes("UULF_MISSING")) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response("<feed><title>Test</title></feed>", {
          status: 200,
          headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
        });
      };

      const app = createApp(makeTestConfig(tmpDir), {
        logger: noopLogger,
        fetchFn: mockFetch,
        fetchRawFn: mockFetch,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() { throw new Error("unused"); },
          async downloadFormat() { throw new Error("unused"); },
        },
      });

      // Fire 20 simultaneous requests for the same playlist feed -> single-flight = 1 upstream call!
      const burst = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.fetch(new Request("http://127.0.0.1:8787/feed/playlist/UULF1234567890")),
        ),
      );
      expect(burst.every((r) => r.status === 200)).toBe(true);
      expect(upstreamCalls).toBe(1);

      // 404 preserved for FreeTube channel validation
      const missing = await app.fetch(
        new Request("http://127.0.0.1:8787/feed/playlist/UULF_MISSING"),
      );
      expect(missing.status).toBe(404);

      // Invalid thumbnail paths / traversal rejected
      const badThumb = await app.fetch(
        new Request("http://127.0.0.1:8787/vi/bad_id/evil.exe"),
      );
      expect(badThumb.status).toBe(400);
      const traversalThumb = await app.fetch(
        new Request("http://127.0.0.1:8787/vi/../../etc/passwd"),
      );
      expect(traversalThumb.status).toBe(404);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("silently escalates Tier 1 -> Tier 2 on immediate bot-check and serves DASH + Range 206", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-tier2-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      const calls: boolean[] = [];

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(videoId, { useAuth }): Promise<YtDlpVideoInfo> {
          calls.push(useAuth);
          if (!useAuth) {
            throw new YtDlpError("Sign in to confirm you're not a bot", "bot_check", "bot", 1);
          }
          return {
            id: videoId,
            title: "Verified Tier 2 Video",
            description: "Hello world",
            duration: 120,
            channel: "Creator",
            channel_id: "UC1234567890123456789012",
            view_count: 5000,
            like_count: 100,
            timestamp: 1700000000,
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
                tbr: 2500,
                filesize: mp4Bytes.byteLength,
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
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
                url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&dur=120.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
              },
            ],
          };
        },
        async downloadFormat() { throw new Error("unused"); },
      };

      const mockFetchRaw = async (_input: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("range");
        if (range === "bytes=0-231") {
          return new Response(mp4Bytes.slice(0, 232), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes 0-231/${mp4Bytes.byteLength}`,
              "Content-Length": "232",
              "Accept-Ranges": "bytes",
            },
          });
        }
        return new Response(mp4Bytes, { status: 200 });
      };

      const app = createApp(makeTestConfig(tmpDir, true), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/dQw4w9WgXcQ?"));
      expect(vidRes.status).toBe(200);
      expect(vidRes.headers.get("x-steadytube-tier")).toBe("2");
      expect(calls).toEqual([false, true]); // Tier 1 tried first, silently escalated to Tier 2!

      const body = (await vidRes.json()) as any;
      expect(body.adaptiveFormats.length).toBe(2);
      expect(body.adaptiveFormats[0].init).toBe("0-231");
      expect(body.adaptiveFormats[0].index).toBe("232-303");
      expect(body.authorThumbnails.length).toBeGreaterThanOrEqual(4);

      // Stream init range through /videoplayback
      const playbackUrl = body.adaptiveFormats[0].url as string;
      expect(playbackUrl.startsWith("http://127.0.0.1:8787/videoplayback?")).toBe(true);
      const segRes = await app.fetch(
        new Request(playbackUrl, { headers: { Range: "bytes=0-231" } }),
      );
      expect(segRes.status).toBe(206);
      expect(segRes.headers.get("content-range")).toBe(`bytes 0-231/${mp4Bytes.byteLength}`);
      expect((await segRes.arrayBuffer()).byteLength).toBe(232);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("transparently recovers mid-playback 403 -> Tier 2 -> Tier 3 ephemeral disk buffer", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-midrec-"));
    try {
      const mp4Bytes = makeMp4StreamBytes();
      let downloadCalls = 0;

      const makeInfo = (tierTag: string): YtDlpVideoInfo => ({
        id: "abc123XYZ99",
        title: "Mid-Playback Recovery Test",
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
            url: `https://rr1---${tierTag}.googlevideo.com/videoplayback?itag=137&dur=60.000&expire=1999999999&clen=${mp4Bytes.byteLength}`,
          },
        ],
      });

      const mockYtDlp: YtDlpRunner = {
        async isBgutilAvailable() { return false; },
        async extractVideoInfo(_id, { useAuth }) {
          return makeInfo(useAuth ? "tier2" : "tier1");
        },
        async downloadFormat(_id, _selector, outputPath) {
          downloadCalls++;
          fs.writeFileSync(outputPath, mp4Bytes);
          return outputPath;
        },
      };

      // Simulate upstream returning 403 on BOTH tier1 and tier2 direct URLs -> must escalate transparently to Tier 3 disk!
      const mockFetchRaw = async () => new Response("Forbidden", { status: 403 });

      const app = createApp(makeTestConfig(tmpDir, true), {
        logger: noopLogger,
        ytDlp: mockYtDlp,
        innertube: makeMockInnertube(),
        fetchRawFn: mockFetchRaw,
      });

      const vidRes = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/abc123XYZ99"));
      expect(vidRes.status).toBe(200);
      const vidJson = (await vidRes.json()) as any;
      const playUrl = vidJson.adaptiveFormats[0].url as string;

      // Client requests byte range -> upstream 403 triggers Tier 2 -> upstream 403 triggers Tier 3 download -> 206 served!
      const rangeRes = await app.fetch(
        new Request(playUrl, { headers: { Range: "bytes=304-403" } }),
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("x-steadytube-tier")).toBe("3-buffer");
      expect(rangeRes.headers.get("content-range")).toBe(`bytes 304-403/${mp4Bytes.byteLength}`);
      const bytes = new Uint8Array(await rangeRes.arrayBuffer());
      expect(bytes.byteLength).toBe(100);
      expect(bytes[8]).toBe(4); // mdat payload byte
      expect(downloadCalls).toBe(1);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
