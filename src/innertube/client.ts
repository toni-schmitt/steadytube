import { Innertube, Log } from "youtubei.js";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { ipv4Fetch, type FetchLike } from "../net/ipv4-fetch.ts";

// Keep daemon logs clean from benign youtubei.js JIT parser notices
Log.setLevel(Log.Level.ERROR);

const INNERTUBE_HEADER_TIMEOUT_MS = 15_000;
const INNERTUBE_TOTAL_TIMEOUT_MS = 20_000;
const INNERTUBE_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB cap on anonymous metadata responses
const ALLOWED_INNERTUBE_HOST =
  /^(?:(?:[a-z0-9-]+\.)?youtube\.com|youtubei\.googleapis\.com|suggestqueries(?:-clients6)?\.google\.com)$/i;

function scrubInnertubeTimezoneBody(raw: string): string | null {
  if (!raw.includes("utcOffsetMinutes") && !raw.includes("timeZone")) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const clientCtx = parsed?.context?.client;
    if (!clientCtx || typeof clientCtx !== "object") {
      return null;
    }
    let changed = false;
    if (clientCtx.timeZone !== "UTC") {
      clientCtx.timeZone = "UTC";
      changed = true;
    }
    if (clientCtx.utcOffsetMinutes !== 0) {
      clientCtx.utcOffsetMinutes = 0;
      changed = true;
    }
    return changed ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

export function createGuardedInnertubeFetch(transport: FetchLike = ipv4Fetch) {
  return async function guardedInnertubeFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const isReq = input instanceof Request;
    const method = (init?.method || (isReq ? input.method : "GET")).toUpperCase();
    const callerSignal = init?.signal ?? (isReq ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(INNERTUBE_TOTAL_TIMEOUT_MS);
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    // Strip any Cookie header (including youtubei.js bootstrap synthetic PREF/VISITOR_INFO1_LIVE)
    // so anonymous browsing stays strictly cookie-free.
    const headers = new Headers(
      init?.headers !== undefined ? init.headers : isReq ? input.headers : undefined,
    );
    headers.delete("cookie");

    // Normalize youtubei.js JSON POST bodies so local machine `utcOffsetMinutes` / `timeZone`
    // is never leaked to YouTube on bootstrap (/v1/config) or API calls.
    let nextBody = init?.body;
    if (method !== "GET" && method !== "HEAD") {
      let bodyText: string | null = null;
      if (typeof init?.body === "string") {
        bodyText = init.body;
      } else if (init?.body instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(init.body);
      } else if (init?.body instanceof ArrayBuffer) {
        bodyText = new TextDecoder().decode(new Uint8Array(init.body));
      } else if (init?.body === undefined && isReq && input.body !== null) {
        try {
          bodyText = await input.clone().text();
        } catch {
          bodyText = null;
        }
      }
      if (bodyText !== null) {
        const scrubbed = scrubInnertubeTimezoneBody(bodyText);
        if (scrubbed !== null) {
          nextBody = scrubbed;
          headers.delete("content-length");
        }
      }
    }

    return await transport(input, {
      ...init,
      ...(nextBody !== undefined ? { body: nextBody } : {}),
      headers,
      httpsOnly: true,
      publicIpv4Only: true,
      allowedHost: (h) => ALLOWED_INNERTUBE_HOST.test(h),
      timeoutMs: INNERTUBE_HEADER_TIMEOUT_MS,
      maxBodyBytes: INNERTUBE_MAX_BODY_BYTES,
      signal: combinedSignal,
    });
  };
}

const guardedInnertubeFetch = createGuardedInnertubeFetch();

/**
 * Anonymous IPv4-only InnerTube singleton.
 * NEVER uses cookies or authentication; all requests flow through `guardedInnertubeFetch`.
 */
export class AnonymousInnertubeProvider {
  private instance: Innertube | null = null;
  private creating: Promise<Innertube> | null = null;
  private createdAt = 0;
  private readonly maxSessionAgeMs = 4 * 60 * 60 * 1000; // Refresh session every 4 hours

  constructor(private readonly logger: Logger = noopLogger) {}

  async getClient(): Promise<Innertube> {
    const now = Date.now();
    if (this.instance && now - this.createdAt < this.maxSessionAgeMs) {
      return this.instance;
    }

    if (this.creating) {
      return this.creating;
    }

    this.creating = (async () => {
      try {
        const client = await Innertube.create({
          fetch: guardedInnertubeFetch as typeof globalThis.fetch,
          lang: "en",
          timezone: "UTC",
          retrieve_player: false,
          generate_session_locally: false,
        });
        const clientCtx = (client as any)?.session?.context?.client;
        if (clientCtx && typeof clientCtx === "object") {
          clientCtx.timeZone = "UTC";
          clientCtx.utcOffsetMinutes = 0;
        }
        this.instance = client;
        this.createdAt = Date.now();
        this.logger.info("Initialized anonymous IPv4 InnerTube client");
        return client;
      } finally {
        this.creating = null;
      }
    })();

    return this.creating;
  }

  reset(): void {
    this.instance = null;
    this.createdAt = 0;
  }
}
