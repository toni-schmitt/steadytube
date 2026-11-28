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
const MAX_DNS_CACHE_ENTRIES = 500;
const MAX_REDIRECTS = 8;
const dnsCache = new Map<string, DnsCacheEntry>();
const inflightDns = new Map<string, Promise<string[]>>();

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

const httpFreshAgent = new http.Agent({ keepAlive: false });
const httpsFreshAgent = new https.Agent({ keepAlive: false });

function isTimeoutSignal(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError";
}

export function clearIpv4DnsCache(): void {
  dnsCache.clear();
  inflightDns.clear();
}

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // Multicast & reserved
  return false;
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

function pruneDnsCache(now: number): void {
  for (const [k, v] of dnsCache) {
    if (now >= v.expiresAt) dnsCache.delete(k);
  }
  while (dnsCache.size >= MAX_DNS_CACHE_ENTRIES) {
    const oldest = dnsCache.keys().next().value;
    if (oldest === undefined) break;
    dnsCache.delete(oldest);
  }
}

export async function resolveIpv4(
  hostname: string,
  options: { publicIpv4Only?: boolean; alternate?: boolean } = {},
): Promise<string> {
  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  const checkPublic = (ip: string): string => {
    if (options.publicIpv4Only && isPrivateOrReservedIpv4(ip)) {
      throw new Error(`Refusing private/reserved IPv4 address ${ip} for host: ${cleanHost}`);
    }
    return ip;
  };

  if (net.isIPv4(cleanHost)) {
    return checkPublic(cleanHost);
  }
  if (cleanHost === "localhost") {
    return checkPublic("127.0.0.1");
  }
  if (net.isIPv6(cleanHost)) {
    throw new Error(`Refusing IPv6 literal host in IPv4-only client: ${hostname}`);
  }

  const now = Date.now();
  const cached = dnsCache.get(cleanHost);
  if (cached && now < cached.expiresAt && cached.ips.length > 0) {
    // Sticky IPv4 per hostname so keep-alive TLS sockets are reused across bursts (e.g. 200+ RSS feeds);
    // retries/hedges can request an alternate cached IPv4 when multiple A records exist.
    const offset = options.alternate && cached.ips.length > 1 ? 1 : 0;
    const ip = cached.ips[(cached.activeIndex + offset) % cached.ips.length]!;
    return checkPublic(ip);
  }

  // Coalesce concurrent cold lookups for the same hostname
  let lookupPromise = inflightDns.get(cleanHost);
  if (!lookupPromise) {
    lookupPromise = (async () => {
      let ips: string[] = [];
      try {
        ips = await dns.resolve4(cleanHost);
      } catch {
        const looked = await dns.lookup(cleanHost, { family: 4, all: true });
        ips = looked.map((item) => item.address).filter((addr) => net.isIPv4(addr));
      }
      const validIps = ips.filter((ip) => net.isIPv4(ip));
      if (validIps.length === 0) {
        throw new Error(`No IPv4 A records found for host: ${cleanHost}`);
      }
      pruneDnsCache(Date.now());
      dnsCache.set(cleanHost, {
        ips: validIps,
        expiresAt: Date.now() + DNS_TTL_MS,
        activeIndex: 0,
      });
      return validIps;
    })().finally(() => {
      inflightDns.delete(cleanHost);
    });
    inflightDns.set(cleanHost, lookupPromise);
  }

  const validIps = await lookupPromise;
  const idx = options.alternate && validIps.length > 1 ? 1 : 0;
  return checkPublic(validIps[idx]!);
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
  /** Timeout for DNS resolution + receiving response headers (ms). Default: 20000 */
  timeoutMs?: number;
  /** Disable automatic gzip/deflate/br decompression & keep raw Content-Length/Content-Encoding. */
  raw?: boolean;
  /** Refuse loopback / RFC1918 / link-local / CGNAT IPv4 destinations on every hop. */
  publicIpv4Only?: boolean;
  /** Require HTTPS on initial request and every redirect hop. */
  httpsOnly?: boolean;
  /** Optional allowlist validator invoked on the initial URL and every redirect hop. */
  allowedHost?: (hostname: string) => boolean;
  /** Optional hard upper bound on response body bytes (errors stream and destroys socket if exceeded). */
  maxBodyBytes?: number;
  /** Disable keep-alive socket reuse for this request (useful for retries and hedged attempts). */
  freshConnection?: boolean;
  /** Prefer an alternate cached IPv4 address when multiple A records exist. */
  alternateIpv4?: boolean;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: Ipv4FetchOptions,
) => Promise<Response>;

function validateUrlPolicy(
  url: URL,
  opts: { httpsOnly?: boolean; allowedHost?: (hostname: string) => boolean },
): void {
  if (opts.httpsOnly && url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS URL: ${url.protocol}//${url.host}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol for ipv4Fetch: ${url.protocol}`);
  }
  if (opts.allowedHost && !opts.allowedHost(url.hostname)) {
    throw new Error(`Refusing disallowed upstream host: ${url.hostname}`);
  }
}

async function doSingleIpv4Request(
  url: URL,
  method: string,
  headers: Headers,
  bodyBuf: Buffer | null,
  options: {
    signal?: AbortSignal | null;
    timeoutMs: number;
    raw: boolean;
    publicIpv4Only: boolean;
    httpsOnly: boolean;
    allowedHost?: (hostname: string) => boolean;
    maxBodyBytes?: number;
    freshConnection?: boolean;
    alternateIpv4?: boolean;
  },
): Promise<{
  status: number;
  statusText: string;
  headers: Headers;
  stream: ReadableStream<Uint8Array> | null;
  location: string | null;
}> {
  validateUrlPolicy(url, options);

  const deadlineAt = Date.now() + options.timeoutMs;
  const isHttps = url.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;

  const getAbortError = () =>
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The operation was aborted.", "AbortError");

  if (options.signal?.aborted) {
    throw getAbortError();
  }

  // Enforce deadline and abort signal across DNS resolution as well as socket headers
  let dnsTimer: ReturnType<typeof setTimeout> | null = null;
  let onDnsAbort: (() => void) | null = null;
  let ipv4: string;
  try {
    ipv4 = await Promise.race([
      resolveIpv4(url.hostname, {
        publicIpv4Only: options.publicIpv4Only,
        alternate: options.alternateIpv4,
      }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () =>
            reject(
              new Error(`IPv4 DNS resolution timed out after ${options.timeoutMs}ms: ${url.hostname}`),
            ),
          options.timeoutMs,
        );
        dnsTimer.unref?.();
        if (options.signal) {
          onDnsAbort = () => reject(getAbortError());
          options.signal.addEventListener("abort", onDnsAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
    if (onDnsAbort && options.signal) {
      options.signal.removeEventListener("abort", onDnsAbort);
    }
  }

  const remainingMs = Math.max(100, deadlineAt - Date.now());

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
    let onBodyAbort: (() => void) | null = null;

    const onAbort = () => {
      if (isTimeoutSignal(options.signal)) {
        rotateIpv4OnError(url.hostname, ipv4);
      }
      if (onBodyAbort) {
        onBodyAbort();
        return;
      }
      const abortErr = getAbortError();
      req.destroy(abortErr);
      if (!settled) {
        settled = true;
        reject(abortErr);
      }
    };

    if (options.signal?.aborted) {
      reject(getAbortError());
      return;
    }

    const requestOptions: https.RequestOptions = {
      host: ipv4,
      port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: reqHeaders,
      agent: options.freshConnection
        ? (isHttps ? httpsFreshAgent : httpFreshAgent)
        : (isHttps ? httpsAgent : httpAgent),
      ...(isHttps ? { servername: url.hostname } : {}),
    };

    const req = isHttps
      ? https.request(requestOptions)
      : http.request(requestOptions);

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const headerTimer = setTimeout(() => {
      const timeoutErr = new Error(
        `IPv4 request timed out after ${options.timeoutMs}ms: ${url.host}${url.pathname}`,
      );
      rotateIpv4OnError(url.hostname, ipv4);
      req.destroy(timeoutErr);
      if (!settled) {
        settled = true;
        reject(timeoutErr);
      }
    }, remainingMs);

    req.on("error", (err) => {
      clearTimeout(headerTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!options.signal?.aborted || isTimeoutSignal(options.signal)) {
        rotateIpv4OnError(url.hostname, ipv4);
      }
      if (!settled) {
        settled = true;
        reject(options.signal?.aborted ? getAbortError() : err);
      }
    });

    req.on("upgrade", (_res, socket) => {
      clearTimeout(headerTimer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      req.destroy();
      if (!settled) {
        settled = true;
        reject(new Error("HTTP 101 protocol upgrade is not supported by ipv4Fetch"));
      }
    });

    req.on("response", (res) => {
      clearTimeout(headerTimer);

      const status = res.statusCode ?? 500;
      if (status < 200) {
        options.signal?.removeEventListener("abort", onAbort);
        res.destroy();
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new Error(`Unsupported informational HTTP status ${status} in ipv4Fetch`));
        }
        return;
      }
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

      if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
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
          let receivedBytes = 0;
          const cleanup = () => {
            onBodyAbort = null;
            options.signal?.removeEventListener("abort", onAbort);
          };

          const abortBodyStream = () => {
            cleanup();
            if (!closed) {
              closed = true;
              try {
                controller.error(getAbortError());
              } catch {
                // Already closed
              }
            }
            if (sourceStream !== res) sourceStream.destroy();
            res.destroy();
            req.destroy();
          };

          onBodyAbort = abortBodyStream;
          if (options.signal?.aborted) {
            abortBodyStream();
            return;
          }

          if (options.maxBodyBytes && options.maxBodyBytes > 0) {
            const declaredLen = Number(resHeaders.get("content-length") || "0");
            if (Number.isFinite(declaredLen) && declaredLen > options.maxBodyBytes) {
              closed = true;
              cleanup();
              if (sourceStream !== res) sourceStream.destroy();
              res.destroy();
              req.destroy();
              controller.error(
                new Error(
                  `Upstream response Content-Length exceeded limit (${declaredLen} > ${options.maxBodyBytes})`,
                ),
              );
              return;
            }
          }

          sourceStream.on("data", (chunk: Buffer | Uint8Array) => {
            if (closed) return;
            try {
              const bytes = chunk instanceof Uint8Array
                ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                : new Uint8Array(chunk);
              receivedBytes += bytes.byteLength;
              if (options.maxBodyBytes && options.maxBodyBytes > 0 && receivedBytes > options.maxBodyBytes) {
                closed = true;
                cleanup();
                if (sourceStream !== res) sourceStream.destroy();
                req.destroy();
                res.destroy();
                controller.error(
                  new Error(
                    `Upstream response body exceeded limit (${receivedBytes} > ${options.maxBodyBytes})`,
                  ),
                );
                return;
              }
              controller.enqueue(bytes);
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                sourceStream.pause();
              }
            } catch {
              closed = true;
              cleanup();
              if (sourceStream !== res) sourceStream.destroy();
              req.destroy();
              res.destroy();
            }
          });

          sourceStream.on("end", () => {
            cleanup();
            if (!closed) {
              closed = true;
              try {
                if (options.signal?.aborted) {
                  controller.error(getAbortError());
                } else {
                  controller.close();
                }
              } catch {
                // Already closed
              }
            }
          });

          const onStreamError = (err: Error) => {
            cleanup();
            if (sourceStream !== res) sourceStream.destroy();
            res.destroy();
            req.destroy();
            if (!closed) {
              closed = true;
              try {
                controller.error(options.signal?.aborted ? getAbortError() : err);
              } catch {
                // Already closed
              }
            }
          };

          sourceStream.on("error", onStreamError);
          if (sourceStream !== res) {
            res.on("error", onStreamError);
          }

          res.on("aborted", () => {
            cleanup();
            if (sourceStream !== res) sourceStream.destroy();
            if (!closed) {
              closed = true;
              try {
                controller.error(
                  options.signal?.aborted
                    ? getAbortError()
                    : new Error("Upstream connection aborted"),
                );
              } catch {
                // Already closed
              }
            }
          });

          res.on("close", () => {
            if (!closed && !res.complete) {
              cleanup();
              if (sourceStream !== res) sourceStream.destroy();
              closed = true;
              try {
                controller.error(
                  options.signal?.aborted
                    ? getAbortError()
                    : new Error("Upstream connection closed prematurely"),
                );
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
          onBodyAbort = null;
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
  const publicIpv4Only = init.publicIpv4Only ?? false;
  const httpsOnly = init.httpsOnly ?? false;
  const allowedHost = init.allowedHost;
  const maxBodyBytes = init.maxBodyBytes;
  const freshConnection = init.freshConnection ?? false;
  const alternateIpv4 = init.alternateIpv4 ?? false;

  // Per Fetch spec, explicit `init.headers` replaces `input.headers` rather than merging on top
  // (preventing deleted headers such as stripped `Cookie` from resurfacing via `input.headers`).
  const headers = new Headers(
    init.headers !== undefined ? init.headers : isRequest ? input.headers : undefined,
  );

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
      publicIpv4Only,
      httpsOnly,
      allowedHost,
      maxBodyBytes,
      freshConnection,
      alternateIpv4,
    });

    const isRedirect =
      (result.status === 301 ||
        result.status === 302 ||
        result.status === 303 ||
        result.status === 307 ||
        result.status === 308) &&
      result.location !== null;

    if (isRedirect && redirectMode === "follow") {
      if (result.stream) {
        await result.stream.cancel().catch(() => {});
      }
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${currentUrl.toString()}`);
      }
      const nextUrl = new URL(result.location!, currentUrl);
      validateUrlPolicy(nextUrl, { httpsOnly, allowedHost });
      if (nextUrl.origin !== currentUrl.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (
        (result.status === 303 && method !== "HEAD") ||
        ((result.status === 301 || result.status === 302) && method === "POST")
      ) {
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

/**
 * Drain an HTTP Response body into memory with a strict upper byte limit,
 * cancelling the stream immediately if Content-Length or streamed bytes exceed `maxBytes`.
 */
export async function readBoundedResponseBytes(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLen = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Upstream response Content-Length exceeded limit (${declaredLen} > ${maxBytes})`);
  }
  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Upstream response body exceeded limit (${total} > ${maxBytes})`);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
