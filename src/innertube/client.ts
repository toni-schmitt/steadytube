import { Innertube, Log } from "youtubei.js";
import type { Logger } from "../logger.ts";
import { noopLogger } from "../logger.ts";
import { ipv4Fetch } from "../net/ipv4-fetch.ts";

// Keep daemon logs clean from benign youtubei.js JIT parser notices
Log.setLevel(Log.Level.ERROR);

/**
 * Anonymous IPv4-only InnerTube singleton.
 * NEVER uses cookies or authentication; all requests flow through `ipv4Fetch`.
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
          fetch: ipv4Fetch as typeof globalThis.fetch,
          lang: "en",
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
