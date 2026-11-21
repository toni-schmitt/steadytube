import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EphemeralStore, parseHttpRangeHeader } from "../src/cache/ephemeral-store.ts";

describe("EphemeralStore & HTTP Range parsing", () => {
  test("parses standard, open-ended, suffix, and unsatisfiable byte ranges", () => {
    expect(parseHttpRangeHeader(null, 1000)).toEqual({ start: 0, end: 999, isPartial: false });
    expect(parseHttpRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99, isPartial: true });
    expect(parseHttpRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=-100", 1000)).toEqual({ start: 900, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=500-5000", 1000)).toEqual({ start: 500, end: 999, isPartial: true });
    expect(parseHttpRangeHeader("bytes=1000-1200", 1000)).toBe("unsatisfiable");
    expect(parseHttpRangeHeader("bytes=500-200", 1000)).toBe("unsatisfiable");
    expect(parseHttpRangeHeader("items=0-10", 1000)).toBe("unsatisfiable");
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

      // HEAD
      const headRes = store.serveFile(
        e1,
        new Request("http://127.0.0.1/videoplayback", { method: "HEAD" }),
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-length")).toBe("1000");
      expect(headRes.headers.get("accept-ranges")).toBe("bytes");

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
});
