#!/usr/bin/env bun
import {
  getDefaultCacheDir,
  getDefaultConfigPath,
  getDefaultLogDir,
  loadConfig,
} from "./config.ts";
import { APP_VERSION } from "./routes/stats.ts";
import { startServer } from "./server.ts";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(`steadytube ${APP_VERSION}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`SteadyTube v${APP_VERSION} — local IPv4 Invidious bridge for stock FreeTube

Usage:
  steadytube [options]

Options:
  -v, --version   Print version and exit
  -h, --help      Show this help message

Paths:
  Config: ${getDefaultConfigPath()}
  Cache:  ${getDefaultCacheDir()}
  Logs:   ${getDefaultLogDir()}

Environment overrides:
  STEADYTUBE_HOST, STEADYTUBE_PORT, STEADYTUBE_CONFIG,
  STEADYTUBE_CACHE_DIR, STEADYTUBE_LOG_DIR, STEADYTUBE_LOG_LEVEL,
  STEADYTUBE_FIREFOX_PROFILE`);
  process.exit(0);
}

const config = loadConfig();
const running = startServer(config);

function shutdown(signal: string): void {
  running.app.logger.info("Shutting down", { signal });
  running.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
