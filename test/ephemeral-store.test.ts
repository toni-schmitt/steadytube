import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EphemeralStore,
  parseHttpRangeHeader,
  type ProgressiveStreamSource,
} from "../src/cache/ephemeral-store.ts";

describe("EphemeralStore & HTTP Range parsing", () => {
  test("parses standard, open-ended, suffix, and unsatisfiable byte ranges", () => {
    expect(parseHttpRangeHeader(null, 1000)).toEqual({ start: 0, end: 999, isPartial: false });
    expect(parseHttpRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99, isPartial: true });
    expect(parseHttpRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=-100", 1000)).toEqual({ start: 900, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=500-5000", 1000)).toEqual({ start: 500, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=1000-1200", 1000)).toBe("unsatisfiable");
    expect(parseHttpRangeHeader("bytes=500-200", 1000)).toBe("unsatisfiable");
    // RFC 9110 §14.2: unknown range units, multi-range lists, and invalid-syntax specs are ignored -> full representation
    expect(parseHttpRangeHeader("items=0-10", 1000)).toEqual({ start: 0, end: 999, isPartial: false });
    expect(parseHttpRangeHeader("bytes=0-10, 20-30", 1000)).toEqual({
      start: 0,
      end: 999,
      isPartial: false,
    });
    expect(parseHttpRangeHeader("bytes=abc", 1000)).toEqual({ start: 0, end: 999, isPartial: false });
    expect(parseHttpRangeHeader("bytes=-", 1000)).toEqual({ start: 0, end: 999, isPartial: false });
  });

  test("rejects path traversal segments and enforces baseDir containment", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-ephem-path-"));
    try {
      const store = new EphemeralStore(tmpDir, 2500, 60_000);
      expect(() => store.getPathFor("../../../etc", "137", "mp4")).toThrow();
      expect(() => store.getPathFor("..", "137", "mp4")).toThrow();
      const safe = store.getPathFor("abc123XYZ99", "140-drc", "m4a");
      expect(safe.startsWith(path.resolve(tmpDir) + path.sep)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serves GET/HEAD 206 Partial Content and evicts old unpinned files past size cap", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-ephem-"));
    try {
      const store = new EphemeralStore(tmpDir, 2500, 60_000);
      const p1 = store.getPathFor("vid1", "137", "mp4");
      const content = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) content[i] = i % 256;
      fs.writeFileSync(p1, content);
      const e1 = store.register("vid1", "137", p1, "video/mp4");

      // Range GET
      const rangeRes = store.serveFile(
        e1,
        new Request("http://127.0.0.1/videoplayback", {
          method: "GET",
          headers: { Range: "bytes=100-199" },
        }),
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 100-199/1000");
      expect(rangeRes.headers.get("content-length")).toBe("100");
      const slice = new Uint8Array(await rangeRes.arrayBuffer());
      expect(slice.byteLength).toBe(100);
      expect(slice[0]).toBe(100);
      expect(slice[99]).toBe(199);

      // HEAD (even with Range header) returns 200 per RFC 9110
      const headRes = store.serveFile(
        e1,
        new Request("http://127.0.0.1/videoplayback", {
          method: "HEAD",
          headers: { Range: "bytes=0-99" },
        }),
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-length")).toBe("1000");
      expect(headRes.headers.get("accept-ranges")).toBe("bytes");

      // If-Range without matching validator falls back cleanly to 200 full body
      const ifRangeRes = store.serveFile(
        e1,
        new Request("http://127.0.0.1/videoplayback", {
          method: "GET",
          headers: { Range: "bytes=0-99", "If-Range": '"stale-etag"' },
        }),
      );
      expect(ifRangeRes.status).toBe(200);
      expect((await ifRangeRes.arrayBuffer()).byteLength).toBe(1000);

      // Pin vid1, then add 2 more 1000-byte files (total 3000 > 2500 cap) -> vid1 stays, vid2 evicted
      store.pin(store.makeKey("vid1", "137"));
      const p2 = store.getPathFor("vid2", "137", "mp4");
      fs.writeFileSync(p2, new Uint8Array(1000));
      store.register("vid2", "137", p2, "video/mp4");

      await new Promise((r) => setTimeout(r, 15));
      const p3 = store.getPathFor("vid3", "137", "mp4");
      fs.writeFileSync(p3, new Uint8Array(1000));
      store.register("vid3", "137", p3, "video/mp4");

      expect(fs.existsSync(p1)).toBe(true); // Pinned!
      expect(fs.existsSync(p2)).toBe(false); // Evicted LRU!
      expect(fs.existsSync(p3)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ref-counts concurrent pin() and unpin() calls safely", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-refpin-"));
    try {
      const store = new EphemeralStore(tmpDir, 1500, 60_000);
      const p1 = store.getPathFor("vid1", "137", "mp4");
      fs.writeFileSync(p1, new Uint8Array(1000));
      store.register("vid1", "137", p1, "video/mp4");

      const key1 = store.makeKey("vid1", "137");
      const key2 = store.makeKey("vid2", "137");
      store.pin(key1);
      store.pin(key1);
      store.unpin(key1);
      expect(store.isPinned(key1)).toBe(true);

      await new Promise((r) => setTimeout(r, 15));
      store.pin(key2);
      const p2 = store.getPathFor("vid2", "137", "mp4");
      fs.writeFileSync(p2, new Uint8Array(1000));
      store.register("vid2", "137", p2, "video/mp4");
      // Both are pinned (total 2000 > 1500), so neither is evicted
      expect(fs.existsSync(p1)).toBe(true);
      expect(fs.existsSync(p2)).toBe(true);

      // Second unpin on vid1 finally allows cleanup to evict oldest unpinned entry (vid1)
      store.unpin(key1);
      expect(store.isPinned(key1)).toBe(false);
      store.cleanup();
      expect(fs.existsSync(p1)).toBe(false);
      expect(fs.existsSync(p2)).toBe(true);
      store.unpin(key2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serveProgressive streams bytes live as file grows and across atomic rename", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-prog-"));
    try {
      const store = new EphemeralStore(tmpDir, 10 * 1024 * 1024, 60_000);
      const finalPath = store.getPathFor("progVid1", "137", "mp4");
      const tmpPath = `${finalPath}.1234.tmp.mp4`;

      const fullData = new Uint8Array(400);
      for (let i = 0; i < fullData.byteLength; i++) fullData[i] = i % 256;

      // Start with only first 120 bytes written
      fs.writeFileSync(tmpPath, fullData.subarray(0, 120));

      let currentPath = tmpPath;
      let available = 120;
      let status: "downloading" | "completed" | "failed" = "downloading";
      const waiters: Array<() => void> = [];

      const wakeAll = () => {
        for (const fn of waiters.splice(0)) fn();
      };

      const source: ProgressiveStreamSource = {
        videoId: "progVid1",
        formatId: "137",
        mimeType: "video/mp4",
        expectedSize: fullData.byteLength,
        getReadablePath: () => currentPath,
        getAvailableBytes: () => available,
        getStatus: () => status,
        getError: () => null,
        touch: () => {},
        waitForBytes(minBytes, signal, timeoutMs) {
          if (status !== "downloading" || available >= minBytes) return Promise.resolve();
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            const check = () => {
              if (status !== "downloading" || available >= minBytes) {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve();
              } else {
                waiters.push(check);
              }
            };
            waiters.push(check);
          });
        },
      };

      // HEAD returns 200 with full expected length
      const headRes = await store.serveProgressive(
        source,
        new Request("http://127.0.0.1/videoplayback", { method: "HEAD" }),
        1000,
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-length")).toBe("400");
      expect(headRes.headers.get("x-steadytube-tier")).toBe("3-stream");

      // Out-of-bounds range returns 416
      const oobRes = await store.serveProgressive(
        source,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=400-450" } }),
        1000,
      );
      expect(oobRes.status).toBe(416);
      expect(oobRes.headers.get("content-range")).toBe("bytes */400");

      // Request bytes 100-299 while only 0..119 exist; append remaining bytes & rename mid-stream!
      const resPromise = store.serveProgressive(
        source,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=100-299" } }),
        2000,
      );

      setTimeout(() => {
        fs.appendFileSync(tmpPath, fullData.subarray(120, 260));
        available = 260;
        wakeAll();
      }, 25);

      setTimeout(() => {
        fs.appendFileSync(tmpPath, fullData.subarray(260, 400));
        fs.renameSync(tmpPath, finalPath);
        currentPath = finalPath;
        available = 400;
        status = "completed";
        wakeAll();
      }, 60);

      const rangeRes = await resPromise;
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 100-299/400");
      expect(rangeRes.headers.get("content-length")).toBe("200");
      expect(rangeRes.headers.get("x-steadytube-tier")).toBe("3-stream");

      const received = new Uint8Array(await rangeRes.arrayBuffer());
      expect(received).toEqual(fullData.subarray(100, 300));
      expect(store.isPinned(store.makeKey("progVid1", "137"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serveProgressive fails fast without hanging when staging file is truncated mid-stream", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-trunc-"));
    try {
      const store = new EphemeralStore(tmpDir, 10 * 1024 * 1024, 60_000);
      const finalPath = store.getPathFor("truncVid1", "313", "webm");
      const tmpPath = `${finalPath}.1234.tmp.webm`;

      // Case A: File truncated BEFORE stream start (advertised 200 bytes, disk inode only has 80 bytes)
      fs.writeFileSync(tmpPath, new Uint8Array(80).fill(0x55));
      let preCancelReason: string | null = null;
      const preTruncSource: ProgressiveStreamSource = {
        videoId: "truncVid1",
        formatId: "313",
        mimeType: "video/webm",
        expectedSize: 400,
        getReadablePath: () => tmpPath,
        getAvailableBytes: () => 200,
        getStatus: () => "downloading",
        getError: () => null,
        touch: () => {},
        cancel: (reason) => {
          preCancelReason = reason ?? "cancelled";
        },
        waitForBytes: () => Promise.resolve(),
      };
      const preRes = await store.serveProgressive(
        preTruncSource,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=100-199" } }),
        1000,
      );
      expect(preRes.status).toBe(503);
      expect(preCancelReason).not.toBeNull();

      // Case B: File starts with 120 bytes (requested 0-399), then shrinks to 80 while producer
      // still advertises 250 bytes -> second pull MUST fail immediately instead of spinning!
      fs.writeFileSync(tmpPath, new Uint8Array(120).fill(0x55));
      let advertised = 120;
      let cancelReason: string | null = null;
      let readerStarts = 0;
      let readerEnds = 0;
      const waiters: Array<() => void> = [];
      const source: ProgressiveStreamSource = {
        videoId: "truncVid1",
        formatId: "313",
        mimeType: "video/webm",
        expectedSize: 400,
        getReadablePath: () => tmpPath,
        getAvailableBytes: () => advertised,
        getStatus: () => "downloading",
        getError: () => null,
        touch: () => {},
        onReaderStart: () => {
          readerStarts++;
        },
        onReaderEnd: () => {
          readerEnds++;
        },
        cancel: (reason) => {
          cancelReason = reason ?? "cancelled";
        },
        waitForBytes(minBytes) {
          if (advertised >= minBytes) return Promise.resolve();
          return new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        },
      };

      const res = await store.serveProgressive(
        source,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=0-399" } }),
        1000,
      );
      expect(res.status).toBe(206);

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBe(120);

      // Now truncate disk file to 80 bytes while producer falsely advertises 250 bytes
      fs.truncateSync(tmpPath, 80);
      advertised = 250;
      for (const wake of waiters.splice(0)) wake();

      let caught: Error | null = null;
      try {
        await reader.read();
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain("truncated");
      expect(cancelReason).not.toBeNull();
      expect(readerStarts).toBe(1);
      expect(readerEnds).toBe(1);
      expect(store.isPinned(store.makeKey("truncVid1", "313"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serveProgressive rejects seeks >64 MiB ahead of download frontier immediately", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-seek-"));
    try {
      const store = new EphemeralStore(tmpDir, 200 * 1024 * 1024, 60_000);
      const finalPath = store.getPathFor("seekVid1", "313", "webm");
      let waited = false;
      const source: ProgressiveStreamSource = {
        videoId: "seekVid1",
        formatId: "313",
        mimeType: "video/webm",
        expectedSize: 120 * 1024 * 1024,
        getReadablePath: () => finalPath,
        getAvailableBytes: () => 1024 * 1024, // 1 MiB downloaded
        getStatus: () => "downloading",
        getError: () => null,
        touch: () => {},
        waitForBytes: async () => {
          waited = true;
        },
      };

      const res = await store.serveProgressive(
        source,
        new Request("http://127.0.0.1/videoplayback", {
          headers: { Range: `bytes=${80 * 1024 * 1024}-${80 * 1024 * 1024 + 1023}` },
        }),
        1000,
      );
      expect(res.status).toBe(503);
      expect(waited).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reserveBytes accounts for concurrent reservations, evicts unpinned entries, and respects pins", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-resv-"));
    try {
      const store = new EphemeralStore(tmpDir, 2000, 60_000);
      const p1 = store.getPathFor("vid1", "137", "mp4");
      fs.writeFileSync(p1, new Uint8Array(1000));
      store.register("vid1", "137", p1, "video/mp4");

      // Reserving 1500 evicts unpinned vid1 (1000) so 1500 <= 2000 fits
      expect(store.reserveBytes("vid2:137", 1500)).toBe(true);
      expect(fs.existsSync(p1)).toBe(false);
      expect(store.getReservedBytes()).toBe(1500);

      // Second concurrent reservation of 600 exceeds shared 2000 cap -> rejected
      expect(store.reserveBytes("vid3:137", 600)).toBe(false);
      expect(store.getAvailableBudgetFor("vid3:137")).toBe(500);

      // Releasing first reservation frees budget
      store.releaseReservation("vid2:137");
      expect(store.reserveBytes("vid3:137", 1200)).toBe(true);

      // Pinned entry prevents over-reserving without needlessly evicting other unpinned entries
      const p4 = store.getPathFor("vid4", "137", "mp4");
      fs.writeFileSync(p4, new Uint8Array(400));
      store.register("vid4", "137", p4, "video/mp4");
      const p5 = store.getPathFor("vid5", "137", "mp4");
      fs.writeFileSync(p5, new Uint8Array(400));
      store.register("vid5", "137", p5, "video/mp4");
      store.pin(store.makeKey("vid4", "137"));

      // Reserved (1200) + pinned vid4 (400) + requested (500) = 2100 > 2000 -> fails cleanly without evicting vid5
      expect(store.reserveBytes("vid6:137", 500)).toBe(false);
      expect(fs.existsSync(p5)).toBe(true);
      store.unpin(store.makeKey("vid4", "137"));
      store.releaseReservation("vid3:137");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("makeKey matches sanitized filenames across restart scan and serveFile pins active streams", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-keynorm-"));
    try {
      const store1 = new EphemeralStore(tmpDir, 1500, 60_000);
      const p1 = store1.getPathFor("vidA", "251-en.4", "webm");
      fs.writeFileSync(p1, new Uint8Array(1000).fill(7));
      store1.register("vidA", "251-en.4", p1, "audio/webm", {
        formatId: "251-en.4",
        layout: "0-99_100-199",
        rev: "1700000000",
        xtags: "acont=original:lang=en",
      });
      // Cleanly shut down the previous daemon instance before simulating restart
      store1.close();

      // Reopen store from disk: scanExistingFiles must recover normalized key and persisted sidecar metadata
      const store2 = new EphemeralStore(tmpDir, 1500, 60_000);
      expect(store2.hasExclusiveLock()).toBe(true);
      const recovered = store2.get("vidA", "251-en.4");
      expect(recovered).not.toBeNull();
      expect(recovered!.filePath).toBe(p1);
      expect(recovered!.mimeType).toBe("audio/webm");
      expect(recovered!.meta).toEqual({
        formatId: "251-en.4",
        mimeType: "audio/webm",
        layout: "0-99_100-199",
        rev: "1700000000",
        xtags: "acont=original:lang=en",
      });

      // Start serving a partial response; entry must stay pinned until body finishes/cancels
      const res = store2.serveFile(
        recovered!,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=0-499" } }),
      );
      expect(store2.isPinned(recovered!.key)).toBe(true);

      // Registering another 1000-byte entry must NOT evict the currently streaming entry
      const p2 = store2.getPathFor("vidB", "140", "m4a");
      fs.writeFileSync(p2, new Uint8Array(1000).fill(9));
      store2.register("vidB", "140", p2, "audio/mp4");
      expect(fs.existsSync(p1)).toBe(true);

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.byteLength).toBe(500);
      // After stream completes, pin is released
      expect(store2.isPinned(recovered!.key)).toBe(false);
      store2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scanExistingFiles removes orphaned .stage-* dirs and -FragN sidecars on startup", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-stage-scan-"));
    try {
      const vidDir = path.join(tmpDir, "vidStage1");
      const stageDir = path.join(vidDir, ".stage-999999-456-1");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(path.join(stageDir, "media.mp4-Frag1"), new Uint8Array(500));
      fs.writeFileSync(path.join(vidDir, "137.mp4-Frag2"), new Uint8Array(500));

      const store = new EphemeralStore(tmpDir, 10_000, 60_000);
      expect(fs.existsSync(stageDir)).toBe(false);
      expect(fs.existsSync(path.join(vidDir, "137.mp4-Frag2"))).toBe(false);
      expect(store.getStats().fileCount).toBe(0);
      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("retires pinned entries on delete without dropping disk accounting or breaking active readers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-retire-pin-"));
    try {
      const store = new EphemeralStore(tmpDir, 200_000, 60_000);
      const p1 = store.getPathFor("vidRetire", "137", "mp4");
      const data = new Uint8Array(150_000).fill(0x42);
      fs.writeFileSync(p1, data);
      const entry = store.register("vidRetire", "137", p1, "video/mp4");

      // Start reading (pins entry synchronously and opens FD)
      const res = store.serveFile(entry, new Request("http://127.0.0.1/videoplayback"));
      expect(res.status).toBe(200);
      expect(store.isPinned(entry.key)).toBe(true);

      // Explicit delete retires from lookup immediately, but keeps file & accounting until reader closes!
      store.delete("vidRetire", "137");
      expect(store.get("vidRetire", "137")).toBeNull();
      expect(fs.existsSync(p1)).toBe(true);
      expect(store.reserveBytes("vidOther:137", 180_000)).toBe(false);
      expect(store.getAvailableBudgetFor("vidOther:137")).toBe(50_000);

      // Reader completes cleanly with all 150_000 bytes
      const received = new Uint8Array(await res.arrayBuffer());
      expect(received.byteLength).toBe(150_000);
      expect(received[0]).toBe(0x42);
      expect(received[149_999]).toBe(0x42);

      // Once reader finishes, pin drops to 0 -> retired file is unlinked & budget is freed!
      expect(store.isPinned(entry.key)).toBe(false);
      expect(fs.existsSync(p1)).toBe(false);
      expect(store.reserveBytes("vidOther:137", 180_000)).toBe(true);
      store.releaseReservation("vidOther:137");
      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("second EphemeralStore on an active cacheDir does not delete live staging directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-lock-"));
    try {
      const store1 = new EphemeralStore(tmpDir, 10_000, 60_000);
      const liveStage = path.join(tmpDir, "vidLive", ".stage-live-fixture");
      fs.mkdirSync(liveStage, { recursive: true });
      fs.writeFileSync(path.join(liveStage, "media.mp4"), new Uint8Array(128));

      // Second store while store1 holds lock MUST NOT wipe store1's live staging files
      // OR evict store1's pinned/live files via cleanup() OR accept Tier 3 reservations.
      const p1 = store1.getPathFor("vidLive", "137", "mp4");
      fs.writeFileSync(p1, new Uint8Array(6000).fill(1));
      store1.register("vidLive", "137", p1, "video/mp4");
      store1.pin(store1.makeKey("vidLive", "137"));

      const store2 = new EphemeralStore(tmpDir, 1000, 1); // tiny cap & 1ms TTL!
      expect(store2.hasExclusiveLock()).toBe(false);
      expect(fs.existsSync(liveStage)).toBe(true);
      expect(fs.existsSync(p1)).toBe(true);
      expect(store2.cleanup()).toEqual({ removedCount: 0, freedBytes: 0 });
      expect(store2.reserveBytes("vidOther:137", 100)).toBe(false);
      expect(store2.getAvailableBudgetFor("vidOther:137")).toBe(0);
      expect(fs.existsSync(p1)).toBe(true);
      store2.close();
      store1.unpin(store1.makeKey("vidLive", "137"));

      // After store1 closes and releases lock, a new store cleans orphaned staging dirs
      store1.close();
      const store3 = new EphemeralStore(tmpDir, 10_000, 60_000);
      expect(store3.hasExclusiveLock()).toBe(true);
      expect(fs.existsSync(liveStage)).toBe(false);
      store3.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("unpinned different-path register unlinks previous file and refuses re-registering a retired path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-replace-"));
    try {
      const store = new EphemeralStore(tmpDir, 50_000, 60_000);
      const pMp4 = store.getPathFor("vidSwap", "137", "mp4");
      const pWebm = store.getPathFor("vidSwap", "137", "webm");
      fs.writeFileSync(pMp4, new Uint8Array(500).fill(1));
      store.register("vidSwap", "137", pMp4, "video/mp4", { layout: "0-9_10-19" });
      expect(fs.existsSync(pMp4)).toBe(true);
      expect(fs.existsSync(`${pMp4}.meta.json`)).toBe(true);

      // Replacing unpinned entry with a different path must unlink the previous file & sidecar
      fs.writeFileSync(pWebm, new Uint8Array(600).fill(2));
      const next = store.register("vidSwap", "137", pWebm, "video/webm", { layout: "0-19_20-29" });
      expect(fs.existsSync(pMp4)).toBe(false);
      expect(fs.existsSync(`${pMp4}.meta.json`)).toBe(false);
      expect(fs.existsSync(pWebm)).toBe(true);

      // While pinned & retired via delete(), re-registering the retired path MUST throw
      const res = store.serveFile(next, new Request("http://127.0.0.1/videoplayback"));
      expect(res.status).toBe(200);
      store.delete("vidSwap", "137");
      expect(store.isRetired(next.key, pWebm)).toBe(true);
      expect(() => store.register("vidSwap", "137", pWebm, "video/webm")).toThrow(/retired/i);

      await res.arrayBuffer();
      expect(fs.existsSync(pWebm)).toBe(false);
      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("saturates huge positive suffix ranges to full 206 and includes Content-Length: 0 on 416", async () => {
    const hugeSuffix = `bytes=-${"9".repeat(400)}`;
    expect(parseHttpRangeHeader(hugeSuffix, 1000)).toEqual({
      start: 0,
      end: 999,
      isPartial: true,
    });
    expect(parseHttpRangeHeader("bytes=-000000000000000000000", 1000)).toBe("unsatisfiable");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-416-"));
    try {
      const store = new EphemeralStore(tmpDir, 10_000, 60_000);
      const p1 = store.getPathFor("vid416", "137", "mp4");
      fs.writeFileSync(p1, new Uint8Array(100).fill(3));
      const entry = store.register("vid416", "137", p1, "video/mp4");

      const hugeRes = store.serveFile(
        entry,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: hugeSuffix } }),
      );
      expect(hugeRes.status).toBe(206);
      expect(hugeRes.headers.get("content-range")).toBe("bytes 0-99/100");
      expect((await hugeRes.arrayBuffer()).byteLength).toBe(100);

      const oobRes = store.serveFile(
        entry,
        new Request("http://127.0.0.1/videoplayback", { headers: { Range: "bytes=200-300" } }),
      );
      expect(oobRes.status).toBe(416);
      expect(oobRes.headers.get("content-range")).toBe("bytes */100");
      expect(oobRes.headers.get("content-length")).toBe("0");

      // Leading-zero suffix must strip leading zeros before digit-length saturation
      expect(parseHttpRangeHeader("bytes=-00000000000000000001", 100)).toEqual({
        start: 99,
        end: 99,
        isPartial: true,
      });
      const lzRes = store.serveFile(
        entry,
        new Request("http://127.0.0.1/videoplayback", {
          headers: { Range: "bytes=-00000000000000000001" },
        }),
      );
      expect(lzRes.status).toBe(206);
      expect(lzRes.headers.get("content-range")).toBe("bytes 99-99/100");
      expect((await lzRes.arrayBuffer()).byteLength).toBe(1);
      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("standby takeover rescans files written by primary and terminal shutdown blocks lock reacquisition", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-takeover-"));
    try {
      const primary = new EphemeralStore(tmpDir, 2000, 60_000);
      expect(primary.hasExclusiveLock()).toBe(true);

      // Start standby while primary owns lock; arm periodic cleanup on standby too
      const standby = new EphemeralStore(tmpDir, 2000, 60_000);
      standby.startPeriodicCleanup(60_000);
      expect(standby.hasExclusiveLock()).toBe(false);

      // Primary writes an entry AFTER standby finished its initial startup scan
      const p1 = primary.getPathFor("vidAfterStart", "251", "webm");
      fs.writeFileSync(p1, new Uint8Array(1500).fill(5));
      primary.register("vidAfterStart", "251", p1, "audio/webm");

      // Standby cannot take over while primary still holds lock
      expect(standby.reserveBytes("vidOther:137", 400)).toBe(false);

      // Primary closes cleanly -> standby takes over on next write, rescans disk inventory,
      // sees the 1500-byte entry (with persisted audio/webm MIME!), and evicts it when reserving 1000
      primary.close();
      expect(standby.getAvailableBudgetFor("vidOther:137")).toBe(2000);
      expect(standby.hasExclusiveLock()).toBe(true);
      const discovered = standby.get("vidAfterStart", "251");
      expect(discovered).not.toBeNull();
      expect(discovered!.mimeType).toBe("audio/webm");
      expect(standby.getStats().totalBytes).toBe(1500);

      // Reserve 1000 bytes -> standby knows about the 1500-byte entry and evicts it to stay under 2000 cap
      expect(standby.reserveBytes("vidOther:137", 1000)).toBe(true);
      expect(fs.existsSync(p1)).toBe(false);
      standby.releaseReservation("vidOther:137");

      // beginShutdown() blocks new reservations/registrations while keeping the lock held until close()
      standby.beginShutdown();
      expect(standby.isClosed()).toBe(true);
      expect(standby.hasExclusiveLock()).toBe(false);
      expect(standby.reserveBytes("vidAfterClose:137", 100)).toBe(false);
      expect(standby.getAvailableBudgetFor("vidAfterClose:137")).toBe(0);
      // Lockfile is STILL held during drain so another store cannot stomp staging files yet
      const contester = new EphemeralStore(tmpDir, 2000, 60_000);
      expect(contester.hasExclusiveLock()).toBe(false);
      contester.close();

      // Once standby calls close(), lockfile is released and a fresh store can take ownership
      standby.close();
      const fresh = new EphemeralStore(tmpDir, 2000, 60_000);
      expect(fresh.hasExclusiveLock()).toBe(true);
      fresh.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("stale lockfile reclamation rejects live PIDs and takes over dead PIDs cleanly via atomic link", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-lock-stale-"));
    try {
      const lockPath = path.join(tmpDir, ".steadytube.lock");
      // Write a dead-PID lockfile (PID 99999999 is non-existent)
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, lockId: "dead-owner", ts: 1 }));
      const store = new EphemeralStore(tmpDir, 10_000, 60_000);
      expect(store.hasExclusiveLock()).toBe(true);
      const lockBody = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; lockId: string };
      expect(lockBody.pid).toBe(process.pid);
      expect(lockBody.lockId).not.toBe("dead-owner");
      store.close();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("failed unlink keeps disk bytes accounted until subsequent cleanup removes the file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-unlink-fail-"));
    try {
      const store = new EphemeralStore(tmpDir, 2000, 60_000);
      const p1 = store.getPathFor("vidLocked", "137", "mp4");
      fs.writeFileSync(p1, new Uint8Array(1200).fill(9));
      store.register("vidLocked", "137", p1, "video/mp4");

      // Make parent dir read-only so unlinkSync fails with EACCES
      const vidDir = path.dirname(p1);
      fs.chmodSync(vidDir, 0o555);
      try {
        store.delete("vidLocked", "137");
        // Entry is gone from lookup, but file still exists on disk and bytes remain accounted!
        expect(store.get("vidLocked", "137")).toBeNull();
        expect(fs.existsSync(p1)).toBe(true);
        expect(store.getStats().totalBytes).toBe(1200);
        expect(store.getAvailableBudgetFor("vidOther:137")).toBe(800);
        expect(store.reserveBytes("vidOther:137", 1000)).toBe(false);
      } finally {
        fs.chmodSync(vidDir, 0o755);
      }

      // Once directory is writable again, cleanup retries the failed unlink and reclaims budget!
      const cleaned = store.cleanup();
      expect(cleaned.removedCount).toBe(1);
      expect(cleaned.freedBytes).toBe(1200);
      expect(fs.existsSync(p1)).toBe(false);
      expect(store.getStats().totalBytes).toBe(0);
      expect(store.reserveBytes("vidOther:137", 1500)).toBe(true);
      store.releaseReservation("vidOther:137");
      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Round 6 #1/#3/#16: OS flock blocks lock theft, failed eviction/startup unlinks stay budgeted, and legacy audio WebM infers audio/webm", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tube-r6-store-"));
    try {
      // #1: While store1 holds OS flock, even deleting/forging .steadytube.lock with a dead PID
      // MUST NOT allow store2 to steal exclusive ownership!
      const lockDir = path.join(tmpDir, "lock-flock");
      const store1 = new EphemeralStore(lockDir, 10_000, 60_000);
      expect(store1.hasExclusiveLock()).toBe(true);
      const lockPath = path.join(lockDir, ".steadytube.lock");
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, lockId: "forged-dead", ts: 1 }));
      const store2 = new EphemeralStore(lockDir, 10_000, 60_000);
      expect(store2.hasExclusiveLock()).toBe(false);
      store2.close();
      store1.close();
      // Once store1 closes its flock FD, store3 acquires immediately
      const store3 = new EphemeralStore(lockDir, 10_000, 60_000);
      expect(store3.hasExclusiveLock()).toBe(true);
      store3.close();

      // #3a: reserveBytes() re-reads retired bytes AFTER cleanup() fails to unlink an unpinned entry
      const evictDir = path.join(tmpDir, "evict-fail");
      const storeEvict = new EphemeralStore(evictDir, 2000, 60_000);
      const stuckPath = storeEvict.getPathFor("vidStuck", "137", "mp4");
      fs.writeFileSync(stuckPath, new Uint8Array(1200).fill(7));
      storeEvict.register("vidStuck", "137", stuckPath, "video/mp4");
      const stuckParent = path.dirname(stuckPath);
      fs.chmodSync(stuckParent, 0o555);
      try {
        // Need 1000 bytes (1200 + 1000 > 2000) -> triggers eviction inside reserveBytes() -> unlink fails!
        // MUST return false instead of ignoring newly added failedUnlinkEntries!
        expect(storeEvict.reserveBytes("vidOther:137", 1000)).toBe(false);
        expect(storeEvict.getStats().totalBytes).toBe(1200);
      } finally {
        fs.chmodSync(stuckParent, 0o755);
      }
      storeEvict.cleanup();
      expect(storeEvict.reserveBytes("vidOther:137", 1000)).toBe(true);
      storeEvict.releaseReservation("vidOther:137");
      storeEvict.close();

      // #3b: Failed startup unlink of an expired file stays accounted in totalBytes & blocks over-budget reserveBytes
      const startupDir = path.join(tmpDir, "startup-unlink-fail");
      const expiredVidDir = path.join(startupDir, "vidExpired");
      fs.mkdirSync(expiredVidDir, { recursive: true });
      const expiredPath = path.join(expiredVidDir, "137.mp4");
      fs.writeFileSync(expiredPath, new Uint8Array(1200).fill(4));
      const oldTime = new Date(Date.now() - 3600_000);
      fs.utimesSync(expiredPath, oldTime, oldTime);
      fs.chmodSync(expiredVidDir, 0o555);
      let storeStartup: EphemeralStore | null = null;
      try {
        storeStartup = new EphemeralStore(startupDir, 2000, 60_000);
        expect(storeStartup.getStats().totalBytes).toBe(1200);
        expect(storeStartup.reserveBytes("vidNew:137", 1000)).toBe(false);
      } finally {
        fs.chmodSync(expiredVidDir, 0o755);
      }
      const postClean = storeStartup!.cleanup();
      expect(postClean.removedCount).toBe(1);
      expect(postClean.freedBytes).toBe(1200);
      expect(storeStartup!.getStats().totalBytes).toBe(0);
      storeStartup!.close();

      // #16: Legacy .webm files without sidecar mimeType infer audio/webm for audio itags / tier3-a-*
      const mimeDir = path.join(tmpDir, "legacy-webm-mime");
      const vDir = path.join(mimeDir, "vidLegacy");
      fs.mkdirSync(vDir, { recursive: true });
      const audio251 = path.join(vDir, "251.webm");
      fs.writeFileSync(audio251, new Uint8Array(100));
      fs.writeFileSync(`${audio251}.meta.json`, JSON.stringify({ formatId: "251" }));
      const audioTier3 = path.join(vDir, "tier3-a-251.webm");
      fs.writeFileSync(audioTier3, new Uint8Array(100));
      const video248 = path.join(vDir, "248.webm");
      fs.writeFileSync(video248, new Uint8Array(100));

      const storeMime = new EphemeralStore(mimeDir, 50_000, 60_000);
      expect(storeMime.get("vidLegacy", "251")?.mimeType).toBe("audio/webm");
      expect(storeMime.get("vidLegacy", "tier3-a-251")?.mimeType).toBe("audio/webm");
      expect(storeMime.get("vidLegacy", "248")?.mimeType).toBe("video/webm");
      storeMime.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
