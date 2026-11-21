import type { EphemeralStore } from "../cache/ephemeral-store.ts";
import type { VideoResolver } from "../media/video-resolver.ts";

export const APP_VERSION = "0.1.0";

export function handleStats(
  resolver: VideoResolver,
  ephemeralStore: EphemeralStore,
  startedAtSec: number,
): Response {
  const nowSec = Math.floor(Date.now() / 1000);
  return Response.json({
    version: "2.0",
    software: {
      name: "steadytube",
      version: APP_VERSION,
      branch: "main",
    },
    openRegistrations: false,
    usage: {
      users: {
        total: 1,
        activeHalfyear: 1,
        activeMonth: 1,
      },
    },
    metadata: {
      updatedAt: nowSec,
      lastChannelRefreshedAt: startedAtSec,
    },
    playback: resolver.getMetrics(),
    ephemeralCache: ephemeralStore.getStats(),
  });
}
