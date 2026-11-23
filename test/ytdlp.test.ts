import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import {
  assertSafeFormatSelector,
  assertValidVideoId,
  buildWatchUrl,
  buildYtDlpBaseArgs,
  classifyYtDlpError,
  resolveFirefoxProfileFromIni,
} from "../src/media/ytdlp.ts";

function makeTestConfig(overrides?: Partial<AppConfig["playback"]["authFallback"]>): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    allowRemoteBind: false,
    logLevel: "error",
    configPath: "/tmp/config.json",
    cacheDir: "/tmp/cache",
    logDir: "/tmp/logs",
    binaries: {
      ytDlp: "/opt/homebrew/bin/yt-dlp",
      deno: "/opt/homebrew/bin/deno",
      ffmpeg: "/usr/local/bin/ffmpeg",
    },
    playback: {
      videoCacheTtlSec: 1800,
      ytDlpTimeoutMs: 25_000,
      streamStallTimeoutMs: 15_000,
      bgutilPotUrl: "http://127.0.0.1:4416",
      enableBgutilPot: true,
      authFallback: {
        enabled: overrides?.enabled ?? true,
        cookiesFromBrowser: overrides?.cookiesFromBrowser ?? "firefox",
        firefoxProfile: overrides?.firefoxProfile ?? "yt-fallback",
      },
      ephemeralBuffer: {
        enabled: true,
        maxCacheBytes: 1024 * 1024 * 100,
        ttlSeconds: 3600,
        maxFormatHeight: 1080,
      },
    },
    rss: {
      cacheTtlSec: 300,
      negativeCacheTtlSec: 60,
      maxConcurrentUpstream: 12,
    },
    thumbnails: {
      cacheTtlSec: 1800,
      maxEntries: 100,
      maxEntryBytes: 1024 * 1024,
    },
  };
}

describe("ytdlp arg builder & error classifier", () => {
  test("Tier 1 enforces --ignore-config, -4, --no-mark-watched, Deno runtime, visionos client, and explicitly disables browser cookies", () => {
    const config = makeTestConfig();
    const args = buildYtDlpBaseArgs(config, { useAuth: false, bgutilAvailable: false });

    expect(args).toContain("--ignore-config");
    expect(args).toContain("-4");
    expect(args).toContain("--no-mark-watched");
    expect(args).not.toContain("--mark-watched");
    expect(args).toContain("--no-cookies-from-browser");
    expect(args).not.toContain("--cookies-from-browser");
    expect(args).toContain("--js-runtimes");
    expect(args).toContain("deno:/opt/homebrew/bin/deno");
    expect(args).toContain("youtube:player_client=visionos,default,-tv_samsung");
  });

  test("Tier 1 includes bgutil POT extractor arg only when server is reachable", () => {
    const config = makeTestConfig();
    const withBgutil = buildYtDlpBaseArgs(config, { useAuth: false, bgutilAvailable: true });
    expect(withBgutil).toContain("youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416");

    const withoutBgutil = buildYtDlpBaseArgs(config, { useAuth: false, bgutilAvailable: false });
    expect(withoutBgutil).not.toContain("youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416");
  });

  test("Tier 2 passes Firefox profile cookies while still enforcing -4 and --no-mark-watched", () => {
    const config = makeTestConfig({ enabled: true, firefoxProfile: "yt-side-account" });
    const args = buildYtDlpBaseArgs(config, { useAuth: true, bgutilAvailable: false });

    expect(args).toContain("-4");
    expect(args).toContain("--no-mark-watched");
    expect(args).not.toContain("--mark-watched");
    expect(args).toContain("--cookies-from-browser");
    expect(args).toContain("firefox:yt-side-account");
    expect(args).not.toContain("--no-cookies-from-browser");
  });

  test("Tier 2 throws if auth fallback is not configured", () => {
    const config = makeTestConfig({ enabled: false, firefoxProfile: "" });
    expect(() =>
      buildYtDlpBaseArgs(config, { useAuth: true, bgutilAvailable: false }),
    ).toThrow();
  });

  test("classifies YouTube bot checks, age gates, rate limits, and hard errors accurately", () => {
    expect(
      classifyYtDlpError("ERROR: [youtube] abc: Sign in to confirm you’re not a bot."),
    ).toBe("bot_check");
    expect(
      classifyYtDlpError("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."),
    ).toBe("age_restricted");
    expect(
      classifyYtDlpError("ERROR: [youtube] abc: Join this channel to get access to members-only content"),
    ).toBe("auth_required");
    expect(
      classifyYtDlpError("ERROR: unable to download video data: HTTP Error 403: Forbidden"),
    ).toBe("rate_limited");
    expect(
      classifyYtDlpError("ERROR: [youtube] abc: Video unavailable. This video has been removed."),
    ).toBe("unavailable");
  });

  test("validates video IDs, format selectors, and builds watch URLs safely", () => {
    expect(assertValidVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(buildWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(() => assertValidVideoId("../../etc/passwd")).toThrow();
    expect(() => buildWatchUrl("abc&list=evil")).toThrow();

    expect(assertSafeFormatSelector("313")).toBe("313");
    expect(assertSafeFormatSelector("251-en-US")).toBe("251-en-US");
    expect(assertSafeFormatSelector("bestvideo[height<=1080][ext=mp4]/bestvideo")).toBe(
      "bestvideo[height<=1080][ext=mp4]/bestvideo",
    );
    expect(() => assertSafeFormatSelector("--exec")).toThrow();
    expect(() => assertSafeFormatSelector("-o /tmp/pwn")).toThrow();
    expect(() => assertSafeFormatSelector("313\n--exec")).toThrow();
  });

  test("resolves logical Firefox profile names from profiles.ini to salted directories", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steadytube-ff-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "profiles.ini"),
        [
          "[Profile0]",
          "Name=default-release",
          "IsRelative=1",
          "Path=Profiles/1111aaaa.default-release",
          "",
          "[Profile1]",
          "Name=yt-fallback",
          "IsRelative=1",
          "Path=Profiles/abcd1234.yt-fallback",
          "",
          "[Profile2]",
          "Name=custom-abs",
          "IsRelative=0",
          "Path=/opt/ff-profiles/custom",
        ].join("\n"),
      );
      expect(resolveFirefoxProfileFromIni("yt-fallback", [tmpRoot])).toBe(
        path.join(tmpRoot, "Profiles/abcd1234.yt-fallback"),
      );
      expect(resolveFirefoxProfileFromIni("custom-abs", [tmpRoot])).toBe("/opt/ff-profiles/custom");
      expect(resolveFirefoxProfileFromIni("/explicit/path", [tmpRoot])).toBe("/explicit/path");
      expect(resolveFirefoxProfileFromIni("unknown-profile", [tmpRoot])).toBe("unknown-profile");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
