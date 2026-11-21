import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Bun's built-in fetch() and node:https `{ family: 4 }` both still dial IPv6
 * on dual-stack hosts on macOS. To guarantee 100% IPv4 outbound networking, we
 * explicitly resolve IPv4 A records via dns.resolve4() and connect to the
 * literal IPv4 address while preserving TLS SNI (`servername`) and the `Host`
 * header.
 */

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
  activeIndex: number;
}

const DNS_TTL_MS = 60_000;
const MAX_REDIRECTS = 8;
const dnsCache = new Map<string, DnsCacheEntry>();

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 96,
  keepAliveMsecs: 30_000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 96,
  keepAliveMsecs: 30_000,
});

export function clearIpv4DnsCache(): void {
  dnsCache.clear();
}

/**
 * Rotate to the next cached IPv4 address for a host after a socket-level failure.
 */
function rotateIpv4OnError(hostname: string, failedIp: string): void {
  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  const cached = dnsCache.get(cleanHost);
  if (!cached || cached.ips.length <= 1) return;
  if (cached.ips[cached.activeIndex % cached.ips.length] === failedIp) {
    cached.activeIndex = (cached.activeIndex + 1) % cached.ips.length;
  }
}

export async function resolveIpv4(hostname: string): Promise<string> {
  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIPv4(cleanHost)) {
    return cleanHost;
  }
  if (cleanHost === "localhost") {
    return "127.0.0.1";
  }
  if (net.isIPv6(cleanHost)) {
    throw new Error(`Refusing IPv6 literal host in IPv4-only client: ${hostname}`);
  }

  const now = Date.now();
  const cached = dnsCache.get(cleanHost);
  if (cached && now < cached.expiresAt && cached.ips.length > 0) {
    // Sticky IPv4 per hostname so keep-alive TLS sockets are reused across bursts (e.g. 200+ RSS feeds)
    return cached.ips[cached.activeIndex % cached.ips.length]!;
  }

  let ips: string[] = [];
  try {
    ips = await dns.resolve4(cleanHost);
  } catch {
    // Fallback to OS resolver for /etc/hosts or split-horizon DNS, strictly IPv4
    const looked = await dns.lookup(cleanHost, { family: 4, all: true });
    ips = looked.map((item) => item.address).filter((addr) => net.isIPv4(addr));
  }

  const validIps = ips.filter((ip) => net.isIPv4(ip));
  if (validIps.length === 0) {
    throw new Error(`No IPv4 A records found for host: ${cleanHost}`);
  }

  dnsCache.set(cleanHost, {
    ips: validIps,
    expiresAt: now + DNS_TTL_MS,
    activeIndex: 0,
  });

  return validIps[0]!;
}

async function normalizeBody(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body), "utf8");
}

function buildHeadersRecord(input: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  input.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export interface Ipv4FetchOptions extends RequestInit {
  /** Timeout for receiving response headers (ms). Default: 20000 */
  timeoutMs?: number;
  /** Disable automatic gzip/deflate/br decompression & keep raw Content-Length/Content-Encoding. */
  raw?: boolean;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function doSingleIpv4Request(
  url: URL,
  method: string,
  headers: Headers,
  bodyBuf: Buffer | null,
  options: {
    signal?: AbortSignal | null;
    timeoutMs: number;
    raw: boolean;
  },
): Promise<{
  status: number;
  statusText: string;
  headers: Headers;
  stream: ReadableStream<Uint8Array> | null;
  location: string | null;
}> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol for ipv4Fetch: ${url.protocol}`);
  }

  const isHttps = url.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const ipv4 = await resolveIpv4(url.hostname);

  const reqHeaders = buildHeadersRecord(headers);
  reqHeaders["host"] = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  if (!reqHeaders["accept-encoding"]) {
    reqHeaders["accept-encoding"] = options.raw ? "identity" : "gzip, deflate, br";
  }
  if (bodyBuf && !reqHeaders["content-length"]) {
    reqHeaders["content-length"] = String(bodyBuf.byteLength);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      const abortErr = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
      req.destroy(abortErr);
      if (!settled) {
        settled = true;
        reject(abortErr);
      }
    };

    if (options.signal?.aborted) {
      reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
      return;
    }

    const requestOptions: https.RequestOptions = {
      host: ipv4,
      port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: reqHeaders,
      agent: isHttps ? httpsAgent : httpAgent,
      ...(isHttps ? { servername: url.hostname } : {}),
    };

    const req = isHttps
      ? https.request(requestOptions)
      : http.request(requestOptions);

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const headerTimer = setTimeout(() => {
      const timeoutErr = new Error(`IPv4 request timed out after ${options.timeoutMs}ms: ${url.host}${url.pathname}`);
      req.destroy(timeoutErr);
      if (!settled) {
        settled = true;
        reject(timeoutErr);
      }
    }, options.timeoutMs);

    req.on("error", (err) => {
      clearTimeout(headerTimer);
      options.signal?.removeEventListener("abort", onAbort);
      rotateIpv4OnError(url.hostname, ipv4);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.on("response", (res) => {
      clearTimeout(headerTimer);

      const status = res.statusCode ?? 500;
      const statusText = res.statusMessage ?? "";
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) resHeaders.append(k, item);
        } else {
          resHeaders.set(k, v);
        }
      }

      const location = resHeaders.get("location");

      // Null-body statuses or HEAD or redirect we are about to follow
      if (method === "HEAD" || status === 204 || status === 304) {
        res.resume();
        options.signal?.removeEventListener("abort", onAbort);
        settled = true;
        resolve({ status, statusText, headers: resHeaders, stream: null, location });
        return;
      }

      let sourceStream: Readable = res;
      if (!options.raw) {
        const encoding = (resHeaders.get("content-encoding") || "").toLowerCase().trim();
        if (encoding === "gzip" || encoding === "x-gzip") {
          sourceStream = res.pipe(zlib.createGunzip());
          resHeaders.delete("content-encoding");
          resHeaders.delete("content-length");
        } else if (encoding === "deflate") {
          sourceStream = res.pipe(zlib.createInflate());
          resHeaders.delete("content-encoding");
          resHeaders.delete("content-length");
        } else if (encoding === "br") {
          sourceStream = res.pipe(zlib.createBrotliDecompress());
          resHeaders.delete("content-encoding");
          resHeaders.delete("content-length");
        }
      }

      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const cleanup = () => {
            options.signal?.removeEventListener("abort", onAbort);
          };

          sourceStream.on("data", (chunk: Buffer | Uint8Array) => {
            if (closed) return;
            try {
              const bytes = chunk instanceof Uint8Array
                ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                : new Uint8Array(chunk);
              controller.enqueue(bytes);
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                sourceStream.pause();
              }
            } catch {
              closed = true;
              req.destroy();
              res.destroy();
            }
          });

          sourceStream.on("end", () => {
            cleanup();
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // Already closed
              }
            }
          });

          sourceStream.on("error", (err) => {
            cleanup();
            if (!closed) {
              closed = true;
              try {
                controller.error(err);
              } catch {
                // Already closed
              }
            }
          });

          res.on("aborted", () => {
            cleanup();
            if (!closed) {
              closed = true;
              try {
                controller.error(new Error("Upstream connection aborted"));
              } catch {
                // Already closed
              }
            }
          });
        },
        pull() {
          sourceStream.resume();
        },
        cancel() {
          options.signal?.removeEventListener("abort", onAbort);
          sourceStream.destroy();
          res.destroy();
          req.destroy();
        },
      });

      settled = true;
      resolve({ status, statusText, headers: resHeaders, stream: webStream, location });
    });

    if (bodyBuf && bodyBuf.byteLength > 0) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

export async function ipv4Fetch(
  input: string | URL | Request,
  init: Ipv4FetchOptions = {},
): Promise<Response> {
  const isRequest = input instanceof Request;
  let currentUrl = new URL(isRequest ? input.url : input.toString());
  let method = (init.method || (isRequest ? input.method : "GET")).toUpperCase();
  const redirectMode = init.redirect || (isRequest ? input.redirect : "follow");
  const signal = init.signal ?? (isRequest ? input.signal : undefined);
  const timeoutMs = init.timeoutMs ?? 20_000;
  const raw = init.raw ?? false;

  const headers = new Headers(isRequest ? input.headers : undefined);
  if (init.headers) {
    const overrides = new Headers(init.headers);
    overrides.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  let bodyBuf: Buffer | null = null;
  if (init.body !== undefined) {
    bodyBuf = await normalizeBody(init.body);
  } else if (isRequest && method !== "GET" && method !== "HEAD" && input.body !== null) {
    bodyBuf = Buffer.from(await input.clone().arrayBuffer());
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const result = await doSingleIpv4Request(currentUrl, method, headers, bodyBuf, {
      signal,
      timeoutMs,
      raw,
    });

    const isRedirect =
      (result.status === 301 ||
        result.status === 302 ||
        result.status === 303 ||
        result.status === 307 ||
        result.status === 308) &&
      result.location !== null;

    if (isRedirect && redirectMode === "follow") {
      // Drain/cancel redirect body before following
      if (result.stream) {
        await result.stream.cancel().catch(() => {});
      }
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${currentUrl.toString()}`);
      }
      const nextUrl = new URL(result.location!, currentUrl);
      if (nextUrl.origin !== currentUrl.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST")) {
        method = "GET";
        bodyBuf = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      currentUrl = nextUrl;
      continue;
    }

    if (isRedirect && redirectMode === "error") {
      if (result.stream) {
        await result.stream.cancel().catch(() => {});
      }
      throw new Error(`Unexpected redirect (${result.status}) for ${currentUrl.toString()}`);
    }

    const response = new Response(result.stream, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
    Object.defineProperty(response, "url", {
      value: currentUrl.toString(),
      writable: false,
      configurable: true,
    });
    return response;
  }

  throw new Error(`Redirect loop fetching ${currentUrl.toString()}`);
}

export function ipv4FetchRaw(
  input: string | URL | Request,
  init: Omit<Ipv4FetchOptions, "raw"> = {},
): Promise<Response> {
  return ipv4Fetch(input, { ...init, raw: true });
}
