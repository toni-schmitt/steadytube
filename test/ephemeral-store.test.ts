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
    // RFC 9110 §14.2: unknown range units and multi-range lists are ignored -> full representation
    expect(parseHttpRangeHeader("items=0-10", 1000)).toEqual({ start: 0, end: 999, isPartial: false });
    expect(parseHttpRangeHeader("bytes=0-10, 20-30", 1000)).toEqual({
      start: 0,
      end: 999,
      isPartial: false,
    });
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
      store1.register("vidA", "251-en.4", p1, "audio/webm");

      // Reopen store from disk: scanExistingFiles must recover the same normalized key
      const store2 = new EphemeralStore(tmpDir, 1500, 60_000);
      const recovered = store2.get("vidA", "251-en.4");
      expect(recovered).not.toBeNull();
      expect(recovered!.filePath).toBe(p1);

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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
