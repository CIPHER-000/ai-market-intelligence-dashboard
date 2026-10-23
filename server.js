/**
 * Custom Next.js server — adds WebSocket support for /ws/markets.
 *
 * Engines are initialised HERE, before app.prepare(), and stored on globalThis.
 * API routes read from globalThis directly — they never import marketEngine.js
 * or matchingEngine.js, so no Binance connection fires during compilation.
 */
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { parse } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import next from "next";

function openBrowser(url) {
  if (process.env.BROWSER === "none") return;
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `cmd /c start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

import { MarketEngine } from "./lib/marketEngine.js";
import { createMatchingEngine } from "./lib/matchingEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const matchingPath = path.join(__dirname, "data/matching_state.json");

// ── Initialise singletons on globalThis before Next.js boots ─────────────────
if (!globalThis._marketEngine) {
  globalThis._marketEngine = new MarketEngine();
}
if (!globalThis._matchingEngine) {
  globalThis._matchingEngine = createMatchingEngine(matchingPath);
}

const marketEngine = globalThis._marketEngine;

// ── Boot Next.js ──────────────────────────────────────────────────────────────
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();
await app.prepare();

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  handle(req, res, parse(req.url, true));
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", overview: marketEngine.overview() }));

  const onBroadcast = (json) => {
    if (ws.readyState === ws.OPEN) ws.send(json);
  };
  marketEngine.on("broadcast", onBroadcast);
  ws.on("close", () => marketEngine.off("broadcast", onBroadcast));
  ws.on("error", () => ws.terminate());
});

// Next's dev server owns its own upgrade connections (notably the HMR socket at
// /_next/webpack-hmr). Handing every non-/ws/markets upgrade to Next keeps Fast
// Refresh working; before this, those sockets were destroyed outright.
const nextUpgradeHandler = app.getUpgradeHandler();

httpServer.on("upgrade", (req, socket, head) => {
  if (parse(req.url).pathname === "/ws/markets") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  nextUpgradeHandler(req, socket, head).catch((err) => {
    // Next closes sockets it does not own; log anything else rather than hide it.
    if (err) console.error("[server] next upgrade handler failed:", err.message ?? err);
    socket.destroy();
  });
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} in use — kill the process using it and retry.`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(port, () => {
  const url = `http://localhost:${port}`;
  console.log(`> Ready on ${url} (${dev ? "dev" : "production"})`);
  if (dev) openBrowser(url);
  // Connect to Binance only after the server is fully up
  marketEngine.connectBinance();
});
