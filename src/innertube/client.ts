import { Innertube, Log } from "youtubei.js";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { ipv4Fetch, type FetchLike } from "../net/ipv4-fetch.ts";

// Keep daemon logs clean from benign youtubei.js JIT parser notices
Log.setLevel(Log.Level.ERROR);

const INNERTUBE_HEADER_TIMEOUT_MS = 15_000;
const INNERTUBE_TOTAL_TIMEOUT_MS = 20_000;
const INNERTUBE_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB cap on anonymous metadata responses

export function createGuardedInnertubeFetch(transport: FetchLike = ipv4Fetch) {
  return function guardedInnertubeFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const isReq = input instanceof Request;
    const callerSignal = init?.signal ?? (isReq ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(INNERTUBE_TOTAL_TIMEOUT_MS);
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    // Strip any Cookie header (including youtubei.js bootstrap synthetic PREF/VISITOR_INFO1_LIVE)
    // so anonymous browsing stays strictly cookie-free.
    const headers = new Headers(isReq ? input.headers : undefined);
    if (init?.headers) {
      const overrides = new Headers(init.headers);
      overrides.forEach((value, key) => {
        headers.set(key, value);
      });
    }
    headers.delete("cookie");

    return transport(input, {
      ...init,
      headers,
      httpsOnly: true,
      publicIpv4Only: true,
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
