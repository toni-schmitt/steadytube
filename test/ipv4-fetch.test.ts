import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import {
  clearIpv4DnsCache,
  ipv4Fetch,
  ipv4FetchRaw,
  isPrivateOrReservedIpv4,
  resolveIpv4,
} from "../src/net/ipv4-fetch.ts";

describe("ipv4-fetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    clearIpv4DnsCache();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/echo-host") {
          return Response.json({
            host: req.headers.get("host"),
            method: req.method,
            range: req.headers.get("range"),
          });
        }
        if (url.pathname === "/redirect") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/echo-host" },
          });
        }
        if (url.pathname === "/gzip") {
          const gz = zlib.gzipSync(Buffer.from("hello-ipv4-gzip"));
          return new Response(gz, {
            status: 200,
            headers: {
              "Content-Type": "text/plain",
              "Content-Encoding": "gzip",
            },
          });
        }
        if (url.pathname === "/range") {
          const payload = "0123456789abcdefghij";
          const range = req.headers.get("range");
          if (range === "bytes=4-9") {
            return new Response(payload.slice(4, 10), {
              status: 206,
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Range": "bytes 4-9/20",
                "Content-Length": "6",
                "Accept-Ranges": "bytes",
              },
            });
          }
          return new Response(req.method === "HEAD" ? null : payload, {
            status: 200,
            headers: { "Content-Length": "20", "Accept-Ranges": "bytes" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("resolveIpv4 accepts IPv4 & localhost and rejects IPv6 literals", async () => {
    expect(await resolveIpv4("127.0.0.1")).toBe("127.0.0.1");
    expect(await resolveIpv4("localhost")).toBe("127.0.0.1");
    await expect(resolveIpv4("2001:4860:4860::8888")).rejects.toThrow(/IPv6/);
  });

  test("follows redirects over IPv4 and preserves Host header", async () => {
    const res = await ipv4Fetch(`${baseUrl}/redirect`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { host: string; method: string };
    expect(data.host).toBe(`127.0.0.1:${server.port}`);
    expect(data.method).toBe("GET");
  });

  test("automatically decompresses gzip in ipv4Fetch and keeps raw in ipv4FetchRaw", async () => {
    const decoded = await ipv4Fetch(`${baseUrl}/gzip`);
    expect(decoded.status).toBe(200);
    expect(await decoded.text()).toBe("hello-ipv4-gzip");
    expect(decoded.headers.get("content-encoding")).toBeNull();

    const raw = await ipv4FetchRaw(`${baseUrl}/gzip`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-encoding")).toBe("gzip");
    const rawBuf = Buffer.from(await raw.arrayBuffer());
    expect(zlib.gunzipSync(rawBuf).toString("utf8")).toBe("hello-ipv4-gzip");
  });

  test("streams Range 206 and HEAD requests accurately", async () => {
    const res = await ipv4FetchRaw(`${baseUrl}/range`, {
      headers: { Range: "bytes=4-9" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 4-9/20");
    expect(await res.text()).toBe("456789");

    const head = await ipv4FetchRaw(`${baseUrl}/range`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("20");
  });

  test("classifies private/reserved IPv4 addresses and blocks SSRF targets when enforced", async () => {
    expect(isPrivateOrReservedIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("172.16.5.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIpv4("142.250.185.78")).toBe(false);

    await expect(
      ipv4Fetch(`${baseUrl}/echo-host`, { publicIpv4Only: true }),
    ).rejects.toThrow(/private\/reserved IPv4/);

    await expect(
      ipv4Fetch(`${baseUrl}/echo-host`, { httpsOnly: true }),
    ).rejects.toThrow(/non-HTTPS/);

    await expect(
      ipv4Fetch(`${baseUrl}/echo-host`, {
        allowedHost: (h) => /^(?:www\.)?youtube\.com$/i.test(h),
      }),
    ).rejects.toThrow(/disallowed upstream host/);
  });
});
