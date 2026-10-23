/**
 * Engine singletons.
 *
 * Both engines are created lazily on first use, so the API routes work in any
 * runtime, including serverless platforms where there is no long-lived process
 * to prime them. The local dev server (`run.mjs` -> `server.js`) creates them
 * up front and stores them on `globalThis`; these accessors reuse those
 * instances when present and construct them otherwise.
 *
 * Constructing an engine opens no network connection. The upstream Binance feed
 * is attached only by `server.js` calling `marketEngine.connectBinance()`, so a
 * serverless deployment simply runs on the engine's seeded market data.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { MarketEngine } from "./marketEngine.js";
import { createMatchingEngine } from "./matchingEngine.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the matching engine persists orders. Serverless filesystems are
 * read-only apart from the temp directory, so fall back to that there.
 */
function dataDir() {
  return process.env.VERCEL ? "/tmp" : path.join(LIB_DIR, "..", "data");
}

export function getMarketEngine() {
  if (!globalThis._marketEngine) {
    globalThis._marketEngine = new MarketEngine();
  }
  return globalThis._marketEngine;
}

export function getMatchingEngine() {
  if (!globalThis._matchingEngine) {
    globalThis._matchingEngine = createMatchingEngine(
      path.join(dataDir(), "matching_state.json"),
    );
  }
  return globalThis._matchingEngine;
}
