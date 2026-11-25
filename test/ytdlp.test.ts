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
  createYtDlpRunner,
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
    // Cold Tier 3 fallback selectors with prefix match (^=) MUST pass validation
    expect(
      assertSafeFormatSelector(
        "bestvideo[height<=1080][ext=mp4][vcodec^=avc1]/bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/bestvideo",
      ),
    ).toContain("[vcodec^=avc1]");
    expect(
      assertSafeFormatSelector(
        "bestaudio[ext=m4a][acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio",
      ),
    ).toContain("[acodec^=mp4a]");
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

  test("startProgressiveDownload detects truncation, gates idle timeout on active readers, and cleans up on cancel", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steadytube-prog-stub-"));
    try {
      // Helper to write a tiny executable POSIX sh script simulating yt-dlp writing to -o <path>
      const writeStub = (name: string, body: string): string => {
        const scriptPath = path.join(tmpRoot, name);
        fs.writeFileSync(
          scriptPath,
          `#!/bin/sh
OUT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    OUT="$2"
    shift 2
    continue
  fi
  shift
done
${body}
`,
          { mode: 0o755 },
        );
        return scriptPath;
      };

      // 1) Truncation detection: write 200 bytes, pause so poll observes 200, then truncate to 50 bytes
      const truncStub = writeStub(
        "stub-truncate.sh",
        `head -c 200 /dev/zero > "$OUT"
sleep 0.15
head -c 50 /dev/zero > "$OUT"
exec sleep 5`,
      );
      const truncCfg = makeTestConfig();
      truncCfg.binaries.ytDlp = truncStub;
      truncCfg.playback.enableBgutilPot = false;
      const truncRunner = createYtDlpRunner(truncCfg);
      const truncOut = path.join(tmpRoot, "trunc.webm");
      const truncHandle = await truncRunner.startProgressiveDownload!(
        "dQw4w9WgXcQ",
        "313",
        truncOut,
        {
          useAuth: false,
          mimeType: "video/webm",
          expectedSize: 1000,
          maxBytes: 10_000,
          stallTimeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          maxTotalTimeoutMs: 10_000,
        },
      );
      let truncErr: Error | null = null;
      try {
        await truncHandle.done;
      } catch (err) {
        truncErr = err as Error;
      }
      expect(truncErr).not.toBeNull();
      expect(truncErr!.message).toContain("truncated");
      expect(truncHandle.getStatus()).toBe("failed");

      // 2) Idle timeout: does NOT fire while activeReaders > 0, fires with IdleCancelledError once reader ends
      const slowStub = writeStub(
        "stub-slow.sh",
        `head -c 100 /dev/zero > "$OUT"
sleep 0.08
head -c 100 /dev/zero >> "$OUT"
sleep 0.08
head -c 100 /dev/zero >> "$OUT"
sleep 0.08
head -c 100 /dev/zero >> "$OUT"
exec sleep 5`,
      );
      const idleCfg = makeTestConfig();
      idleCfg.binaries.ytDlp = slowStub;
      idleCfg.playback.enableBgutilPot = false;
      const idleRunner = createYtDlpRunner(idleCfg);
      const idleOut = path.join(tmpRoot, "idle.webm");
      const idleHandle = await idleRunner.startProgressiveDownload!(
        "dQw4w9WgXcQ",
        "313",
        idleOut,
        {
          useAuth: false,
          mimeType: "video/webm",
          expectedSize: 5000,
          maxBytes: 10_000,
          stallTimeoutMs: 5_000,
          idleTimeoutMs: 150,
          maxTotalTimeoutMs: 10_000,
        },
      );
      idleHandle.onReaderStart?.();
      await new Promise((r) => setTimeout(r, 250));
      // Still downloading after 250ms (> 150ms idleTimeoutMs) because a reader is active!
      expect(idleHandle.getStatus()).toBe("downloading");
      idleHandle.onReaderEnd?.();

      let idleErr: Error | null = null;
      try {
        await idleHandle.done;
      } catch (err) {
        idleErr = err as Error;
      }
      expect(idleErr).not.toBeNull();
      expect(idleErr!.name).toBe("IdleCancelledError");

      // 3) cancel() synchronously marks failed and unlinks staging file
      const cancelStub = writeStub(
        "stub-cancel.sh",
        `head -c 64 /dev/zero > "$OUT"
exec sleep 5`,
      );
      const cancelCfg = makeTestConfig();
      cancelCfg.binaries.ytDlp = cancelStub;
      cancelCfg.playback.enableBgutilPot = false;
      const cancelRunner = createYtDlpRunner(cancelCfg);
      const cancelOut = path.join(tmpRoot, "cancel.webm");
      const cancelHandle = await cancelRunner.startProgressiveDownload!(
        "dQw4w9WgXcQ",
        "313",
        cancelOut,
        {
          useAuth: false,
          mimeType: "video/webm",
          expectedSize: 5000,
          maxBytes: 10_000,
          stallTimeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          maxTotalTimeoutMs: 10_000,
        },
      );
      await cancelHandle.waitForBytes(1, undefined, 2_000);
      const stagingPath = cancelHandle.getReadablePath();
      expect(fs.existsSync(stagingPath)).toBe(true);
      cancelHandle.cancel("Shutdown test");
      expect(cancelHandle.getStatus()).toBe("failed");
      expect(fs.existsSync(stagingPath)).toBe(false);
      await expect(cancelHandle.done).rejects.toThrow("Shutdown test");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("downloadFormat cleans -FragN sidecars on timeout, enforces live maxBytes, and terminates on runner.stop()", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steadytube-dl-life-"));
    try {
      const writeStub = (name: string, body: string): string => {
        const scriptPath = path.join(tmpRoot, name);
        fs.writeFileSync(
          scriptPath,
          `#!/bin/sh
OUT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    OUT="$2"
    shift 2
    continue
  fi
  shift
done
${body}
`,
          { mode: 0o755 },
        );
        return scriptPath;
      };

      // 1) Timeout with -Frag1 / -Frag2 sidecars -> private staging dir is completely removed!
      const fragDir = path.join(tmpRoot, "vid-frag");
      const fragOut = path.join(fragDir, "137.mp4");
      const fragStub = writeStub(
        "stub-frag.sh",
        `head -c 256 /dev/zero > "$OUT"
head -c 256 /dev/zero > "$OUT-Frag1"
head -c 256 /dev/zero > "$OUT-Frag2"
exec sleep 5`,
      );
      const fragCfg = makeTestConfig();
      fragCfg.binaries.ytDlp = fragStub;
      fragCfg.playback.enableBgutilPot = false;
      const fragRunner = createYtDlpRunner(fragCfg);
      await expect(
        fragRunner.downloadFormat("dQw4w9WgXcQ", "137", fragOut, {
          useAuth: false,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/timed out/i);
      expect(fs.readdirSync(fragDir)).toEqual([]);

      // 2) Mid-download maxBytes cap kills writer and leaves zero files on disk
      const capDir = path.join(tmpRoot, "vid-cap");
      const capOut = path.join(capDir, "137.mp4");
      const capStub = writeStub(
        "stub-cap.sh",
        `head -c 1500 /dev/zero > "$OUT"
exec sleep 5`,
      );
      const capCfg = makeTestConfig();
      capCfg.binaries.ytDlp = capStub;
      capCfg.playback.enableBgutilPot = false;
      const capRunner = createYtDlpRunner(capCfg);
      let capErr: Error | null = null;
      try {
        await capRunner.downloadFormat("dQw4w9WgXcQ", "137", capOut, {
          useAuth: false,
          timeoutMs: 5_000,
          maxBytes: 1000,
        });
      } catch (err) {
        capErr = err as Error;
      }
      expect(capErr).not.toBeNull();
      expect(capErr!.name).toBe("BudgetExceededError");
      expect(fs.readdirSync(capDir)).toEqual([]);

      // 3) runner.stop() + awaitShutdown() kills active downloadFormat child and wipes staging dir
      const stopDir = path.join(tmpRoot, "vid-stop");
      const stopOut = path.join(stopDir, "137.mp4");
      const stopStub = writeStub(
        "stub-stop.sh",
        `head -c 128 /dev/zero > "$OUT"
exec sleep 10`,
      );
      const stopCfg = makeTestConfig();
      stopCfg.binaries.ytDlp = stopStub;
      stopCfg.playback.enableBgutilPot = false;
      const stopRunner = createYtDlpRunner(stopCfg);
      const pendingDl = stopRunner.downloadFormat("dQw4w9WgXcQ", "137", stopOut, {
        useAuth: false,
        timeoutMs: 10_000,
      });
      await new Promise((r) => setTimeout(r, 120));
      stopRunner.stop?.();
      await stopRunner.awaitShutdown?.(1000);
      await expect(pendingDl).rejects.toThrow();
      expect(fs.readdirSync(stopDir)).toEqual([]);

      // 4) Final shared accounting check catches fast-exiting downloads before 100ms poll
      const fastDir = path.join(tmpRoot, "vid-fast-budget");
      const fastOut = path.join(fastDir, "137.mp4");
      const fastStub = writeStub("stub-fast.sh", `head -c 512 /dev/zero > "$OUT"`);
      const fastCfg = makeTestConfig();
      fastCfg.binaries.ytDlp = fastStub;
      fastCfg.playback.enableBgutilPot = false;
      const fastRunner = createYtDlpRunner(fastCfg);
      let fastErr: Error | null = null;
      try {
        await fastRunner.downloadFormat("dQw4w9WgXcQ", "137", fastOut, {
          useAuth: false,
          maxBytes: 10_000,
          onStagingBytes: () => false, // Shared budget denies immediately
        });
      } catch (err) {
        fastErr = err as Error;
      }
      expect(fastErr).not.toBeNull();
      expect(fastErr!.name).toBe("BudgetExceededError");
      expect(fs.existsSync(fastOut)).toBe(false);
      expect(fs.readdirSync(fastDir)).toEqual([]);

      // 4b) Fast-exiting writer leaving small media file + huge -Frag1 sidecar is rejected
      // under BOTH maxBytes and onStagingBytes in downloadFormat AND startProgressiveDownload!
      const sidecarDir = path.join(tmpRoot, "vid-sidecar-fast");
      const sidecarOut = path.join(sidecarDir, "137.mp4");
      const sidecarStub = writeStub(
        "stub-sidecar-fast.sh",
        `head -c 200 /dev/zero > "$OUT"
head -c 1500 /dev/zero > "$OUT-Frag1"`,
      );
      const sidecarCfg = makeTestConfig();
      sidecarCfg.binaries.ytDlp = sidecarStub;
      sidecarCfg.playback.enableBgutilPot = false;
      const sidecarRunner = createYtDlpRunner(sidecarCfg);

      let dlSidecarErr: Error | null = null;
      try {
        await sidecarRunner.downloadFormat("dQw4w9WgXcQ", "137", sidecarOut, {
          useAuth: false,
          maxBytes: 1000,
        });
      } catch (err) {
        dlSidecarErr = err as Error;
      }
      expect(dlSidecarErr).not.toBeNull();
      expect(dlSidecarErr!.name).toBe("BudgetExceededError");
      expect(fs.existsSync(sidecarOut)).toBe(false);
      expect(fs.readdirSync(sidecarDir)).toEqual([]);

      const progSidecarOut = path.join(sidecarDir, "137-prog.mp4");
      let sawStagingBytes = 0;
      const progSidecarHandle = await sidecarRunner.startProgressiveDownload!(
        "dQw4w9WgXcQ",
        "137",
        progSidecarOut,
        {
          useAuth: false,
          mimeType: "video/mp4",
          expectedSize: 200,
          maxBytes: 10_000,
          onStagingBytes: (bytes) => {
            if (bytes > sawStagingBytes) sawStagingBytes = bytes;
            return bytes <= 1000;
          },
          stallTimeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          maxTotalTimeoutMs: 10_000,
        },
      );
      let progSidecarErr: Error | null = null;
      try {
        await progSidecarHandle.done;
      } catch (err) {
        progSidecarErr = err as Error;
      }
      expect(progSidecarErr).not.toBeNull();
      expect(progSidecarErr!.name).toBe("BudgetExceededError");
      expect(sawStagingBytes).toBeGreaterThanOrEqual(1700);
      expect(fs.existsSync(progSidecarOut)).toBe(false);
      expect(fs.readdirSync(sidecarDir)).toEqual([]);

      // 5) Shutdown terminates detached descendant processes (process group kill)
      const descDir = path.join(tmpRoot, "vid-desc");
      const descOut = path.join(descDir, "137.mp4");
      const pidFile = path.join(tmpRoot, "grandchild.pid");
      const descStub = writeStub(
        "stub-desc.sh",
        `sleep 30 &
echo $! > "${pidFile}"
wait`,
      );
      const descCfg = makeTestConfig();
      descCfg.binaries.ytDlp = descStub;
      descCfg.playback.enableBgutilPot = false;
      const descRunner = createYtDlpRunner(descCfg);
      const descPending = descRunner.downloadFormat("dQw4w9WgXcQ", "137", descOut, {
        useAuth: false,
        timeoutMs: 10_000,
      });
      // Poll until the stub has forked its grandchild and written its PID
      const waitDeadline = Date.now() + 3_000;
      while (!fs.existsSync(pidFile) && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(grandchildPid).toBeGreaterThan(0);
      descRunner.stop?.();
      await descRunner.awaitShutdown?.(1000);
      await expect(descPending).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 80));
      let grandchildAlive = false;
      try {
        process.kill(grandchildPid, 0);
        grandchildAlive = true;
      } catch {
        grandchildAlive = false;
      }
      expect(grandchildAlive).toBe(false);

      // 6) extractVideoInfo bounds concurrent subprocesses (<= 4 in flight)
      const concDir = path.join(tmpRoot, "vid-conc-extract");
      fs.mkdirSync(concDir, { recursive: true });
      const concScript = path.join(tmpRoot, "stub-extract-conc.sh");
      fs.writeFileSync(
        concScript,
        `#!/bin/sh
TAG="${concDir}/active-$$"
touch "$TAG"
sleep 0.12
rm -f "$TAG"
echo '{"id":"dQw4w9WgXcQ","formats":[]}'
`,
        { mode: 0o755 },
      );
      const concCfg = makeTestConfig();
      concCfg.binaries.ytDlp = concScript;
      concCfg.playback.enableBgutilPot = false;
      const concRunner = createYtDlpRunner(concCfg);
      let peakActive = 0;
      const sampler = setInterval(() => {
        try {
          const count = fs.readdirSync(concDir).length;
          if (count > peakActive) peakActive = count;
        } catch {
          // ignore
        }
      }, 15);
      try {
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            concRunner.extractVideoInfo(`vidTest000${i}`, { useAuth: false }),
          ),
        );
      } finally {
        clearInterval(sampler);
      }
      expect(peakActive).toBeLessThanOrEqual(4);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
