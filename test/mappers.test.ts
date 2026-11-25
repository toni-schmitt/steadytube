import { describe, expect, test } from "bun:test";
import {
  buildProxyPlaybackUrl,
  buildStaticDashMpdXml,
  buildStoryboardWebVtt,
  descriptionToHtml,
  mapCommentThreadToInvidious,
  mapYoutubeiVideoNode,
  normalizeAuthorThumbnails,
  parseCompactNumber,
  parseDurationTextToSeconds,
  parseRelativeTimeToUnixSec,
} from "../src/innertube/mappers.ts";

describe("Invidious mappers for FreeTube 0.26.0 schema", () => {
  test("normalizeAuthorThumbnails always provides at least 4 entries for FreeTube index accesses [0..3]", () => {
    const fromEmpty = normalizeAuthorThumbnails([], "http://127.0.0.1:8787");
    expect(fromEmpty.length).toBeGreaterThanOrEqual(4);
    expect(fromEmpty[3]!.url).toContain("http://127.0.0.1:8787/ggpht/");

    const fromOne = normalizeAuthorThumbnails(
      [{ url: "https://yt3.ggpht.com/abc=s88-c-k", width: 88, height: 88 }],
      "http://127.0.0.1:8787",
    );
    expect(fromOne.length).toBeGreaterThanOrEqual(4);
    expect(fromOne[0]!.url).toBe("http://127.0.0.1:8787/ggpht/abc=s88-c-k");
    expect(fromOne[3]!.url).toContain("http://127.0.0.1:8787/ggpht/abc=s176");
  });

  test("mapCommentThreadToInvidious provides BOTH singular authorThumbnail (FreeTube Oq) and authorThumbnails", () => {
    const mapped = mapCommentThreadToInvidious(
      {
        comment: {
          comment_id: "Ugz123",
          author: {
            name: "Alice",
            id: "UC1234567890123456789012",
            thumbnails: [{ url: "https://yt3.ggpht.com/avatar=s88", width: 88, height: 88 }],
          },
          content: { text: "Great video!" },
          published_time: "2 days ago",
          like_count: "1.2K",
          reply_count: 3,
          is_pinned: true,
          author_is_channel_owner: false,
          is_hearted: true,
        },
      },
      "http://127.0.0.1:8787",
      "reply_tok_1",
    );

    expect(mapped).not.toBeNull();
    expect(mapped!.authorThumbnail).toContain("http://127.0.0.1:8787/ggpht/avatar");
    expect(mapped!.authorThumbnails.length).toBeGreaterThanOrEqual(4);
    expect(mapped!.likeCount).toBe(1200);
    expect(mapped!.isPinned).toBe(true);
    expect(mapped!.creatorHeart).toBeDefined();
    expect(mapped!.replies).toEqual({ replyCount: 3, continuation: "reply_tok_1" });
  });

  test("buildProxyPlaybackUrl includes dur, expire, clen, itag, fid, v, and xtags required by FreeTube Vq()", () => {
    const urlStr = buildProxyPlaybackUrl({
      origin: "http://127.0.0.1:8787",
      videoId: "dQw4w9WgXcQ",
      formatId: "140-drc",
      itag: 140,
      durSec: 212.5,
      expireSec: 1800000000,
      clen: 3456789,
      xtags: "acont=original:drc=1:lang=en",
    });

    const u = new URL(urlStr);
    expect(u.origin).toBe("http://127.0.0.1:8787");
    expect(u.pathname).toBe("/videoplayback");
    expect(u.searchParams.get("v")).toBe("dQw4w9WgXcQ");
    expect(u.searchParams.get("fid")).toBe("140-drc");
    expect(u.searchParams.get("itag")).toBe("140");
    expect(u.searchParams.get("dur")).toBe("212.500");
    expect(u.searchParams.get("expire")).toBe("1800000000");
    expect(u.searchParams.get("clen")).toBe("3456789");
    expect(u.searchParams.get("xtags")).toBe("acont=original:drc=1:lang=en");
  });

  test("buildStaticDashMpdXml emits valid MPD with SegmentBase init/index ranges", () => {
    const xml = buildStaticDashMpdXml(120, [
      {
        index: "741-1500",
        init: "0-740",
        bitrate: "2500000",
        url: "http://127.0.0.1:8787/videoplayback?v=abc&fid=137&itag=137&dur=120.000&expire=1900000000",
        itag: "137",
        type: 'video/mp4; codecs="avc1.640028"',
        clen: "10000000",
        lmt: "0",
        projectionType: "RECTANGULAR",
        container: "mp4",
        encoding: "avc1.640028",
        size: "1920x1080",
        fps: 30,
        qualityLabel: "1080p",
      },
      {
        index: "601-1000",
        init: "0-600",
        bitrate: "128000",
        url: "http://127.0.0.1:8787/videoplayback?v=abc&fid=140&itag=140&dur=120.000&expire=1900000000",
        itag: "140",
        type: 'audio/mp4; codecs="mp4a.40.2"',
        clen: "1000000",
        lmt: "0",
        projectionType: "RECTANGULAR",
        container: "mp4",
        encoding: "mp4a.40.2",
        audioQuality: "AUDIO_QUALITY_MEDIUM",
        audioSampleRate: "44100",
        audioChannels: 2,
      },
    ]);

    expect(xml).toContain('mediaPresentationDuration="PT120.000S"');
    expect(xml).toContain('indexRange="741-1500"');
    expect(xml).toContain('<Initialization range="0-740"/>');
    expect(xml).toContain('width="1920" height="1080"');
    expect(xml).toContain('value="2"');
  });

  test("buildStoryboardWebVtt generates WebVTT cues with rewritten IPv4 proxy URLs", () => {
    const vtt = buildStoryboardWebVtt(
      [
        {
          template_url: "https://i.ytimg.com/sb/abc/storyboard3_L2/M$M.jpg?sqp=1",
          thumbnail_width: 160,
          thumbnail_height: 90,
          thumbnail_count: 3,
          interval: 2000,
          columns: 2,
          rows: 2,
        },
      ],
      6,
      90,
      "http://127.0.0.1:8787",
    );

    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.000");
    expect(vtt).toContain("http://127.0.0.1:8787/ggpht/sb/abc/storyboard3_L2/M0.jpg?sqp=1#xywh=0,0,160,90");
    expect(vtt).toContain("#xywh=160,0,160,90");
    expect(vtt).toContain("#xywh=0,90,160,90");
  });

  test("helper parsers handle compact counts, durations, relative times, and HTML escaping", () => {
    expect(parseCompactNumber("1.25M subscribers")).toBe(1_250_000);
    expect(parseCompactNumber("45,678 views")).toBe(45_678);
    expect(parseDurationTextToSeconds("1:02:03")).toBe(3723);
    expect(parseDurationTextToSeconds("12:34")).toBe(754);

    const fixedNow = 1_700_000_000_000;
    expect(parseRelativeTimeToUnixSec("3 hours ago", fixedNow)).toBe(1_700_000_000 - 3 * 3600);
    expect(parseRelativeTimeToUnixSec("1d ago", fixedNow)).toBe(1_700_000_000 - 86400);
    expect(parseRelativeTimeToUnixSec("4d ago", fixedNow)).toBe(1_700_000_000 - 4 * 86400);
    expect(parseRelativeTimeToUnixSec("3mo ago", fixedNow)).toBe(1_700_000_000 - 90 * 86400);
    expect(parseRelativeTimeToUnixSec("1y ago", fixedNow)).toBe(1_700_000_000 - 365 * 86400);
    expect(parseRelativeTimeToUnixSec("12m ago", fixedNow)).toBe(1_700_000_000 - 12 * 60);
    expect(parseRelativeTimeToUnixSec("2h ago", fixedNow)).toBe(1_700_000_000 - 2 * 3600);
    expect(parseRelativeTimeToUnixSec("yesterday", fixedNow)).toBe(1_700_000_000 - 86400);
    expect(descriptionToHtml("Check <script> & https://example.com\nLine 2")).toBe(
      'Check &lt;script&gt; &amp; <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a><br>Line 2',
    );
    // Adjacent escaped quotes/brackets must NOT be swallowed into href, while &amp; query params stay intact
    expect(descriptionToHtml('See "https://example.com/p?a=1&b=2" and <https://example.org>')).toBe(
      'See &quot;<a href="https://example.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com/p?a=1&amp;b=2</a>&quot; and &lt;<a href="https://example.org" target="_blank" rel="noopener noreferrer">https://example.org</a>&gt;',
    );
  });

  test("maps channel-page 1-row LockupView and watch-next 2-row LockupView accurately", () => {
    const channelNode = {
      type: "LockupView",
      content_type: "VIDEO",
      content_id: "f0KK_4AaqLQ",
      metadata: {
        title: { text: "I Played GTA VI at 60 FPS" },
        metadata: {
          metadata_rows: [
            {
              metadata_parts: [
                { text: { text: "1.7M" } },
                { text: { text: "1d ago" } },
              ],
            },
          ],
        },
      },
      content_image: {
        overlays: [{ badges: [{ text: "16:48" }] }],
      },
    };

    const mappedCh = mapYoutubeiVideoNode(channelNode, "http://127.0.0.1:8787", {
      author: "Linus Tech Tips",
      authorId: "UCXuqSBlHAE6Xw-yeJA0Tunw",
    });
    expect(mappedCh).not.toBeNull();
    expect(mappedCh!.author).toBe("Linus Tech Tips");
    expect(mappedCh!.authorId).toBe("UCXuqSBlHAE6Xw-yeJA0Tunw");
    expect(mappedCh!.viewCount).toBe(1_700_000);
    expect(mappedCh!.lengthSeconds).toBe(16 * 60 + 48);
    expect(mappedCh!.publishedText).toBe("1d ago");
    expect(Math.floor(Date.now() / 1000) - mappedCh!.published).toBeGreaterThanOrEqual(86000);

    const recNode = {
      type: "LockupView",
      content_type: "VIDEO",
      content_id: "abc123XYZ00",
      metadata: {
        title: { text: "Related Video" },
        metadata: {
          metadata_rows: [
            {
              metadata_parts: [
                { text: { text: "TechLinked", endpoint: { payload: { browseId: "UCeeFfhMcJa1kjtfZAGskOCA" } } } },
              ],
            },
            {
              metadata_parts: [
                { text: { text: "284K views" } },
                { text: { text: "3d ago" } },
              ],
            },
          ],
        },
      },
      content_image: {
        overlays: [{ badges: [{ text: "12:32" }] }],
      },
    };
    const mappedRec = mapYoutubeiVideoNode(recNode, "http://127.0.0.1:8787");
    expect(mappedRec).not.toBeNull();
    expect(mappedRec!.author).toBe("TechLinked");
    expect(mappedRec!.authorId).toBe("UCeeFfhMcJa1kjtfZAGskOCA");
    expect(mappedRec!.viewCount).toBe(284_000);
    expect(mappedRec!.publishedText).toBe("3d ago");
  });
});
