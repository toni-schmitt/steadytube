import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import { noopLogger } from "../src/logger.ts";
import {
  createGuardedInnertubeFetch,
  type AnonymousInnertubeProvider,
} from "../src/innertube/client.ts";
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
    allowRemoteBind: false,
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

  test("enforces loopback Host guard, Origin allowlist, videoId validation, and anonymous-only cold captions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-sec-"));
    try {
      let ytDlpExtractCalls = 0;
      const app = createApp(makeTestConfig(tmpDir, true), {
        logger: noopLogger,
        innertube: makeMockInnertube(),
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() {
            ytDlpExtractCalls++;
            throw new Error("should not be called for cold captions");
          },
          async downloadFormat() {
            throw new Error("should not be called for cold captions");
          },
        },
      });

      // DNS rebinding Host header rejected
      const badHost = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/stats", {
          headers: { Host: "evil.example.com:8787" },
        }),
      );
      expect(badHost.status).toBe(403);

      // Remote web origin rejected
      const badOrigin = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/stats", {
          headers: { Origin: "https://evil.example.com" },
        }),
      );
      expect(badOrigin.status).toBe(403);

      // Electron / FreeTube null and file:// origins allowed and echoed (no wildcard *)
      const nullOrigin = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/stats", {
          headers: { Origin: "null" },
        }),
      );
      expect(nullOrigin.status).toBe(200);
      expect(nullOrigin.headers.get("access-control-allow-origin")).toBe("null");
      expect(nullOrigin.headers.get("vary")).toContain("Origin");

      // Invalid video IDs rejected with 400
      const badVideo = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/videos/bad!id"));
      expect(badVideo.status).toBe(400);
      const badPlayback = await app.fetch(
        new Request("http://127.0.0.1:8787/videoplayback?v=..%2F..%2Fetc&fid=137"),
      );
      expect(badPlayback.status).toBe(400);

      // Cold captions must stay anonymous and never invoke yt-dlp / Tier 2 cookies
      const capRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/captions/dQw4w9WgXcQ?lang=en"),
      );
      expect(capRes.status).toBe(404);
      expect(ytDlpExtractCalls).toBe(0);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serializes concurrent search and playlist pagination continuations without duplicate fetches", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-pag-"));
    try {
      const searchContCalls: number[] = [];
      const playlistContCalls: number[] = [];

      const makeVideoNode = (id: string, title: string) => ({
        type: "Video",
        id,
        title: { text: title },
        author: { name: "Test Channel", id: "UC1234567890123456789012" },
        duration: { seconds: 60 },
        view_count: { text: "1K views" },
        published: { text: "1 day ago" },
      });

      const makeSearchPage = (pageNum: number): any => ({
        results: [makeVideoNode(`vid_page_${pageNum}`, `Page ${pageNum}`)],
        has_continuation: pageNum < 3,
        async getContinuation() {
          searchContCalls.push(pageNum + 1);
          await new Promise((r) => setTimeout(r, 25));
          return makeSearchPage(pageNum + 1);
        },
      });

      const makePlaylistFeed = (batchNum: number): any => {
        const items = Array.from({ length: 100 }, (_, i) =>
          makeVideoNode(`pl_${batchNum}_${i}`, `Item ${batchNum}-${i}`),
        );
        return {
          info: {
            title: { text: "Big Playlist" },
            author: { name: { text: "Author" }, id: "UC1234567890123456789012" },
            total_items: "200 videos",
          },
          items,
          has_continuation: batchNum < 2,
          async getContinuation() {
            playlistContCalls.push(batchNum + 1);
            await new Promise((r) => setTimeout(r, 25));
            return makePlaylistFeed(batchNum + 1);
          },
        };
      };

      const fakeInnertube = {
        async getClient() {
          return {
            async search() {
              return makeSearchPage(1);
            },
            async getPlaylist() {
              return makePlaylistFeed(1);
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const app = createApp(makeTestConfig(tmpDir, false), {
        logger: noopLogger,
        innertube: fakeInnertube,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() { throw new Error("unused"); },
          async downloadFormat() { throw new Error("unused"); },
        },
      });

      // Seed page 1, then request page 2 (twice concurrently) + page 3 concurrently
      const p1 = await (await app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=cats&page=1"))).json() as any[];
      expect(p1[0].videoId).toBe("vid_page_1");

      const [r2a, r2b, r3] = await Promise.all([
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=cats&page=2")),
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=cats&page=2")),
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=cats&page=3")),
      ]);
      expect(((await r2a.json()) as any[])[0].videoId).toBe("vid_page_2");
      expect(((await r2b.json()) as any[])[0].videoId).toBe("vid_page_2");
      expect(((await r3.json()) as any[])[0].videoId).toBe("vid_page_3");
      // Continuation for page 2 and page 3 must each have been called EXACTLY ONCE!
      expect(searchContCalls).toEqual([2, 3]);

      // Seed playlist page 1 (index=50 -> offset 0..99), then concurrently request index=150 (offset 100..199)
      const pl1 = await (await app.fetch(new Request("http://127.0.0.1:8787/api/v1/playlists/PLtest123?index=50"))).json() as any;
      expect(pl1.videos.length).toBe(100);

      const [pl2a, pl2b] = await Promise.all([
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/playlists/PLtest123?index=150")),
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/playlists/PLtest123?index=150")),
      ]);
      const pl2aJson = (await pl2a.json()) as any;
      const pl2bJson = (await pl2b.json()) as any;
      expect(pl2aJson.videos.length).toBe(100);
      expect(pl2aJson.videos[0].videoId).toBe("pl_2_0");
      expect(pl2bJson.videos[0].videoId).toBe("pl_2_0");
      expect(playlistContCalls).toEqual([2]);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("media proxy enforces body timeout signals and rejects oversized RSS/image responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-media-bounds-"));
    try {
      const seenSignals: boolean[] = [];
      const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
        seenSignals.push(Boolean(init?.signal));
        const u = input.toString();
        if (u.includes("UULF_HUGE_FEED")) {
          // Exceeds 5 MiB feed cap via Content-Length
          return new Response("x", {
            status: 200,
            headers: {
              "Content-Type": "application/atom+xml",
              "Content-Length": String(6 * 1024 * 1024),
            },
          });
        }
        // Oversized image stream exceeding 10 MiB cap without Content-Length header
        const bigBody = new ReadableStream<Uint8Array>({
          start(controller) {
            const chunk = new Uint8Array(1024 * 1024);
            for (let i = 0; i < 11; i++) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        });
        return new Response(bigBody, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, false), {
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

      const hugeFeed = await app.fetch(
        new Request("http://127.0.0.1:8787/feed/playlist/UULF_HUGE_FEED"),
      );
      expect(hugeFeed.status).toBe(502);

      const hugeImg = await app.fetch(
        new Request("http://127.0.0.1:8787/vi/dQw4w9WgXcQ/maxresdefault.jpg"),
      );
      expect(hugeImg.status).toBe(502);

      // Every upstream call received an AbortSignal timeout
      expect(seenSignals.length).toBeGreaterThanOrEqual(2);
      expect(seenSignals.every(Boolean)).toBe(true);

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("bounds caption fetches, deduplicates cold pagination init, skips unmappable playlist pages, and handles bad percent-encoding with 400", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r2-misc-"));
    try {
      let searchInitCalls = 0;
      let searchContCalls = 0;
      let captionSignalSeen = false;
      let captionMaxBytesSeen = 0;

      const makeVideoNode = (id: string, title: string) => ({
        type: "Video",
        id,
        title: { text: title },
        author: { name: "Test Channel", id: "UC1234567890123456789012" },
        duration: { seconds: 60 },
        view_count: { text: "1K views" },
        published: { text: "1 day ago" },
      });

      const fakeInnertube = {
        async getClient() {
          return {
            async getInfo() {
              return {
                streaming_data: null,
                basic_info: {},
                watch_next_feed: [],
                captions: {
                  caption_tracks: [
                    {
                      name: { text: "English" },
                      language_code: "en",
                      base_url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
                    },
                  ],
                },
              };
            },
            async search() {
              searchInitCalls++;
              await new Promise((r) => setTimeout(r, 25));
              return {
                results: [makeVideoNode("cold_p1", "Cold Page 1")],
                has_continuation: true,
                async getContinuation() {
                  searchContCalls++;
                  await new Promise((r) => setTimeout(r, 20));
                  return {
                    results: [makeVideoNode("cold_p2", "Cold Page 2")],
                    has_continuation: false,
                  };
                },
              };
            },
            async getPlaylist() {
              return {
                info: { title: { text: "Sparse Playlist" }, author: { name: { text: "A" }, id: "UC1234567890123456789012" }, total_items: "150" },
                items: Array.from({ length: 100 }, (_, i) =>
                  makeVideoNode(`pl1_${String(i).padStart(3, "0")}`, `P1-${i}`),
                ),
                has_continuation: true,
                async getContinuation() {
                  // Unmappable middle page (0 valid videos) that still has a continuation!
                  return {
                    items: [{ type: "UnsupportedPromoItem" }],
                    has_continuation: true,
                    async getContinuation() {
                      return {
                        items: [makeVideoNode("p3_valid", "Page 3 Valid Video")],
                        has_continuation: false,
                      };
                    },
                  };
                },
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const mockFetch = async (_u: string | URL | Request, init?: any) => {
        captionSignalSeen = Boolean(init?.signal);
        captionMaxBytesSeen = Number(init?.maxBodyBytes || 0);
        // Oversized caption exceeding 2 MiB cap
        return new Response("x", {
          status: 200,
          headers: { "Content-Length": String(3 * 1024 * 1024) },
        });
      };

      const app = createApp(makeTestConfig(tmpDir, false), {
        logger: noopLogger,
        fetchFn: mockFetch,
        fetchRawFn: mockFetch,
        innertube: fakeInnertube,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() { throw new Error("unused"); },
          async downloadFormat() { throw new Error("unused"); },
        },
      });

      // 1) Captions enforce timeout signal + 2 MiB body cap, and unmatched explicit lang/label returns 404 (not captions[0])
      const missingCap = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/captions/dQw4w9WgXcQ?lang=fr"),
      );
      expect(missingCap.status).toBe(404);
      const hugeCap = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/captions/dQw4w9WgXcQ?lang=en"),
      );
      expect(hugeCap.status).toBe(502);
      expect(captionSignalSeen).toBe(true);
      expect(captionMaxBytesSeen).toBe(2 * 1024 * 1024);

      // 2) Malformed percent-encoding returns 400 (not 500)
      const badPct = await app.fetch(new Request("http://127.0.0.1:8787/api/v1/playlists/%E0%A4%A"));
      expect(badPct.status).toBe(400);

      // 3) Cold concurrent page=2 requests coalesce initial search AND continuation to 1 call each
      const [c2a, c2b] = await Promise.all([
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=coldtest&page=2")),
        app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=coldtest&page=2")),
      ]);
      expect(((await c2a.json()) as any[])[0].videoId).toBe("cold_p2");
      expect(((await c2b.json()) as any[])[0].videoId).toBe("cold_p2");
      expect(searchInitCalls).toBe(1);
      expect(searchContCalls).toBe(1);

      // 4) Extreme page clamp returns [] immediately without looping
      const clampedSearch = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/search?q=coldtest&page=999999"),
      );
      expect(clampedSearch.status).toBe(200);
      expect((await clampedSearch.json()) as any[]).toEqual([]);

      // 5) Unmappable middle playlist continuation page advances to page 3 instead of stopping early
      const plRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/playlists/PLsparse1?index=150"),
      );
      expect(plRes.status).toBe(200);
      const plJson = (await plRes.json()) as any;
      expect(plJson.videos.length).toBe(1);
      expect(plJson.videos[0].videoId).toBe("p3_valid");

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps warm pagination generations consistent, rejects encoded separators/unknown tabs/huge queries, and strips cookies + preserves Request.signal in InnerTube wrapper", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r3-misc-"));
    try {
      let gen = 0;
      let releaseRefresh!: () => void;
      let refreshStarted!: () => void;
      const refreshStartedPromise = new Promise<void>((r) => { refreshStarted = r; });
      let getVideosCalls = 0;

      const makeVideoNode = (id: string, title: string) => ({
        type: "Video",
        id,
        title: { text: title },
        author: { name: "Test Channel", id: "UC1234567890123456789012" },
        duration: { seconds: 60 },
        view_count: { text: "1K views" },
        published: { text: "1 day ago" },
      });

      const fakeInnertube = {
        async getClient() {
          return {
            async search() {
              const myGen = ++gen;
              if (myGen === 2) {
                refreshStarted();
                await new Promise<void>((r) => { releaseRefresh = r; });
              }
              return {
                results: [makeVideoNode(`gen${myGen}_p1`, `G${myGen} P1`)],
                has_continuation: true,
                async getContinuation() {
                  return {
                    results: [makeVideoNode(`gen${myGen}_p2`, `G${myGen} P2`)],
                    has_continuation: false,
                  };
                },
              };
            },
            async getChannel() {
              return {
                metadata: { title: "Chan", external_id: "UC1234567890123456789012" },
                async getVideos() {
                  getVideosCalls++;
                  return { videos: [], has_continuation: false };
                },
              };
            },
          };
        },
        reset() {},
      } as unknown as AnonymousInnertubeProvider;

      const app = createApp(makeTestConfig(tmpDir, false), {
        logger: noopLogger,
        innertube: fakeInnertube,
        ytDlp: {
          async isBgutilAvailable() { return false; },
          async extractVideoInfo() { throw new Error("unused"); },
          async downloadFormat() { throw new Error("unused"); },
        },
      });

      // 1) Warm session gen 1, then start gen 2 refresh (page=1) concurrently with page=2 -> BOTH must see gen 2!
      const p1Warm = (await (await app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=music&page=1"))).json()) as any[];
      expect(p1Warm[0].videoId).toBe("gen1_p1");

      const p1RefreshReq = app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=music&page=1"));
      await refreshStartedPromise;
      const p2OverlapReq = app.fetch(new Request("http://127.0.0.1:8787/api/v1/search?q=music&page=2"));
      releaseRefresh();

      const [p1NewRes, p2NewRes] = await Promise.all([p1RefreshReq, p2OverlapReq]);
      expect(((await p1NewRes.json()) as any[])[0].videoId).toBe("gen2_p1");
      expect(((await p2NewRes.json()) as any[])[0].videoId).toBe("gen2_p2");

      // 2) Encoded path separator -> 400; unknown channel tab -> 404 (never falls through to getVideos); oversized query -> 400
      const sepRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/channels/UC1234567890123456789012/videos%2Fextra"),
      );
      expect(sepRes.status).toBe(400);

      const badTabRes = await app.fetch(
        new Request("http://127.0.0.1:8787/api/v1/channels/UC1234567890123456789012/unknown_tab"),
      );
      expect(badTabRes.status).toBe(404);
      expect(getVideosCalls).toBe(0);

      const hugeQRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/v1/search?q=${"a".repeat(501)}`),
      );
      expect(hugeQRes.status).toBe(400);

      // 3) createGuardedInnertubeFetch preserves Request.signal AND strips Cookie headers
      let seenAborted = false;
      let seenCookie: string | null = "unset";
      const wrapped = createGuardedInnertubeFetch(async (_input, init) => {
        seenAborted = Boolean(init?.signal?.aborted);
        seenCookie = new Headers(init?.headers).get("cookie");
        return new Response("ok", { status: 200 });
      });
      const abortedCtrl = new AbortController();
      abortedCtrl.abort(new DOMException("Pre-aborted", "AbortError"));
      const reqWithSignalAndCookie = new Request("https://www.youtube.com/sw.js_data", {
        headers: { Cookie: "PREF=tz=Europe.Berlin;VISITOR_INFO1_LIVE=abc123" },
        signal: abortedCtrl.signal,
      });
      await wrapped(reqWithSignalAndCookie);
      expect(seenAborted).toBe(true);
      expect(seenCookie).toBeNull();

      app.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
