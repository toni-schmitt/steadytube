import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
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
            cookie: req.headers.get("cookie"),
            xNew: req.headers.get("x-new"),
            xOld: req.headers.get("x-old"),
          });
        }
        if (url.pathname === "/redirect") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/echo-host" },
          });
        }
        if (url.pathname === "/redirect-303") {
          return new Response(null, {
            status: 303,
            headers: { Location: "/range" },
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
        if (url.pathname === "/bad-gzip") {
          return new Response(new Uint8Array([0x1f, 0x8b, 0xff, 0xff, 0x00, 0x01, 0x02, 0x03]), {
            status: 200,
            headers: {
              "Content-Type": "text/plain",
              "Content-Encoding": "gzip",
            },
          });
        }
        if (url.pathname === "/slow-body") {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk1"));
              // Hold stream open until client aborts
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
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
        if (url.pathname === "/reset-205") {
          return new Response(null, { status: 205 });
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
    expect(await resolveIpv4("localhost", { alternate: true })).toBe("127.0.0.1");
    await expect(resolveIpv4("2001:4860:4860::8888")).rejects.toThrow(/IPv6/);
  });

  test("freshConnection opens a new TCP socket per request and completes gzip requests", async () => {
    const portServer = http.createServer((req, res) => {
      if (req.url === "/port") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(String(req.socket.remotePort ?? 0));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = portServer.address() as net.AddressInfo;
      const clientPorts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const portRes = await ipv4Fetch(`http://127.0.0.1:${port}/port`, { freshConnection: true });
        expect(portRes.status).toBe(200);
        clientPorts.push(await portRes.text());
      }
      expect(new Set(clientPorts).size).toBe(3);

      const gzRes = await ipv4Fetch(`${baseUrl}/gzip`, { freshConnection: true, alternateIpv4: true });
      expect(gzRes.status).toBe(200);
      expect(await gzRes.text()).toBe("hello-ipv4-gzip");
    } finally {
      portServer.close();
    }
  });

  test("resolveIpv4 selects alternate A records, rotates on primary failure/timeout, and does not rotate on alternate or non-timeout abort", async () => {
    const hangServer = http.createServer((_req, _res) => {
      // Intentionally never respond so timeout/abort paths are exercised deterministically.
    });
    await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));

    const closedProbe = net.createServer();
    await new Promise<void>((resolve) => closedProbe.listen(0, "127.0.0.1", resolve));
    const closedPort = (closedProbe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closedProbe.close(() => resolve()));

    const hangPort = (hangServer.address() as net.AddressInfo).port;
    const records = new Map<string, string[]>([
      ["dual-ok.example", ["93.184.216.34", "93.184.216.35"]],
      ["dual-private-alt.example", ["93.184.216.34", "127.0.0.1"]],
      ["dual-refused.example", ["127.0.0.1", "93.184.216.35"]],
      ["dual-timeout.example", ["127.0.0.1", "93.184.216.35"]],
      ["dual-abort.example", ["127.0.0.1", "93.184.216.35"]],
      ["triple-alt.example", ["93.184.216.34", "127.0.0.1", "93.184.216.36"]],
    ]);
    const resolveSpy = spyOn(dns, "resolve4").mockImplementation((async (hostname: string) => {
      const ips = records.get(hostname);
      if (!ips) throw new Error(`Unexpected DNS lookup for ${hostname}`);
      return [...ips];
    }) as typeof dns.resolve4);

    try {
      clearIpv4DnsCache();

      // 1) Multi-record alternate selection + publicIpv4Only enforcement on alternate
      expect(await resolveIpv4("dual-ok.example", { publicIpv4Only: true })).toBe("93.184.216.34");
      expect(await resolveIpv4("dual-ok.example", { publicIpv4Only: true, alternate: true })).toBe("93.184.216.35");
      expect(await resolveIpv4("dual-private-alt.example", { publicIpv4Only: true })).toBe("93.184.216.34");
      await expect(
        resolveIpv4("dual-private-alt.example", { publicIpv4Only: true, alternate: true }),
      ).rejects.toThrow(/private\/reserved IPv4/);

      // 2) Primary socket error rotates sticky IP A -> B so non-alternate retry dials B (not A)
      await expect(
        ipv4Fetch(`http://dual-refused.example:${closedPort}/`, { timeoutMs: 2000 }),
      ).rejects.toThrow();
      expect(await resolveIpv4("dual-refused.example")).toBe("93.184.216.35");

      // 3) Primary TimeoutError abort rotates sticky IP A -> B
      await expect(
        ipv4Fetch(`http://dual-timeout.example:${hangPort}/`, {
          timeoutMs: 2000,
          signal: AbortSignal.timeout(40),
        }),
      ).rejects.toThrow();
      expect(await resolveIpv4("dual-timeout.example")).toBe("93.184.216.35");

      // 4) Non-timeout AbortError does NOT rotate sticky IP
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(new DOMException("Canceled", "AbortError")), 30);
      try {
        await expect(
          ipv4Fetch(`http://dual-abort.example:${hangPort}/`, {
            timeoutMs: 2000,
            signal: abortCtrl.signal,
          }),
        ).rejects.toThrow();
      } finally {
        clearTimeout(abortTimer);
      }
      expect(await resolveIpv4("dual-abort.example")).toBe("127.0.0.1");

      // 5) Alternate-IP timeout does NOT rotate the sticky IP (prevents double rotation)
      expect(await resolveIpv4("triple-alt.example")).toBe("93.184.216.34");
      await expect(
        ipv4Fetch(`http://triple-alt.example:${hangPort}/`, {
          timeoutMs: 2000,
          alternateIpv4: true,
          signal: AbortSignal.timeout(40),
        }),
      ).rejects.toThrow();
      expect(await resolveIpv4("triple-alt.example")).toBe("93.184.216.34");
    } finally {
      resolveSpy.mockRestore();
      clearIpv4DnsCache();
      hangServer.closeAllConnections();
      hangServer.close();
    }
  });

  test("follows redirects over IPv4 and preserves Host header", async () => {
    const res = await ipv4Fetch(`${baseUrl}/redirect`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { host: string; method: string };
    expect(data.host).toBe(`127.0.0.1:${server.port}`);
    expect(data.method).toBe("GET");

    // RFC 9110 §15.4.4: 303 See Other must preserve HEAD (never turn HEAD into GET)
    const head303 = await ipv4Fetch(`${baseUrl}/redirect-303`, { method: "HEAD" });
    expect(head303.status).toBe(200);
    expect(head303.headers.get("content-length")).toBe("20");
    expect(await head303.text()).toBe("");
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

  test("honors AbortSignal before DNS/request, aborts mid-body cleanly, and tears down corrupt gzip streams", async () => {
    // 1) Pre-aborted signal rejects immediately with AbortError
    const preCtrl = new AbortController();
    preCtrl.abort(new DOMException("Pre-aborted", "AbortError"));
    let preErr: Error | null = null;
    try {
      await ipv4Fetch(`${baseUrl}/echo-host`, { signal: preCtrl.signal });
    } catch (err) {
      preErr = err as Error;
    }
    expect(preErr).not.toBeNull();
    expect(preErr!.name).toBe("AbortError");

    // 2) Mid-body abort rejects with AbortError
    const bodyCtrl = new AbortController();
    const slowRes = await ipv4Fetch(`${baseUrl}/slow-body`, { signal: bodyCtrl.signal });
    const reader = slowRes.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("chunk1");
    const pending = reader.read();
    bodyCtrl.abort(new DOMException("Client gone", "AbortError"));
    let bodyErr: Error | null = null;
    try {
      await pending;
    } catch (err) {
      bodyErr = err as Error;
    }
    expect(bodyErr).not.toBeNull();
    expect(bodyErr!.name).toBe("AbortError");

    // 3) Corrupt gzip payload fails stream and cleans up socket
    const badGzRes = await ipv4Fetch(`${baseUrl}/bad-gzip`);
    await expect(badGzRes.text()).rejects.toThrow();

    // 4) maxBodyBytes enforces hard cap on response bodies and special-purpose IPv4 blocks are rejected
    expect(isPrivateOrReservedIpv4("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("198.51.100.5")).toBe(true);
    expect(isPrivateOrReservedIpv4("203.0.113.9")).toBe(true);
    const cappedRes = await ipv4Fetch(`${baseUrl}/range`, { maxBodyBytes: 8 });
    await expect(cappedRes.text()).rejects.toThrow(/exceeded limit/i);

    // 5) Fetch-spec header replacement: explicit init.headers replaces Request.headers so deleted Cookie never leaks
    const reqWithCookie = new Request(`${baseUrl}/echo-host`, {
      headers: { Cookie: "PREF=tz=Europe.Berlin", "X-Old": "stale" },
    });
    const replacedHeaders = new Headers(reqWithCookie.headers);
    replacedHeaders.delete("cookie");
    replacedHeaders.delete("x-old");
    replacedHeaders.set("x-new", "clean");
    const noCookieRes = await ipv4Fetch(reqWithCookie, { headers: replacedHeaders });
    const echoed = (await noCookieRes.json()) as { cookie: string | null; xNew: string | null; xOld: string | null };
    expect(echoed.cookie).toBeNull();
    expect(echoed.xOld).toBeNull();
    expect(echoed.xNew).toBe("clean");

    // 6) Null-body status 205 Reset Content does not throw in Response construction
    const res205 = await ipv4Fetch(`${baseUrl}/reset-205`);
    expect(res205.status).toBe(205);
    expect(await res205.text()).toBe("");

    // 7) Round 6 #14: HTTP 101 Switching Protocols upgrade rejects cleanly instead of hanging or throwing RangeError
    const upgradeServer = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
      });
    });
    await new Promise<void>((resolve) => upgradeServer.listen(0, "127.0.0.1", resolve));
    try {
      const addr = upgradeServer.address() as net.AddressInfo;
      await expect(
        ipv4Fetch(`http://127.0.0.1:${addr.port}/upgrade`, { timeoutMs: 2000 }),
      ).rejects.toThrow(/101|upgrade/i);
    } finally {
      upgradeServer.close();
    }
  });
});
