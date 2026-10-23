"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MarketsOverview, WsMessage } from "../types/markets";

export type StreamStatus = "connected" | "reconnecting" | "disconnected";

type Ctx = {
  overview: MarketsOverview | null;
  connected: boolean;
  status: StreamStatus;
  /** Allow HTTP poll fallback to update the shared overview when WS is down. */
  applyOverview: (overview: MarketsOverview) => void;
};

const StreamCtx = createContext<Ctx>({
  overview: null,
  connected: false,
  status: "disconnected",
  applyOverview: () => {},
});

function wsUrlFromLocation(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/markets`;
}

export function MarketsStreamProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<MarketsOverview | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<StreamStatus>("disconnected");
  const alive = useRef(true);
  const everConnected = useRef(false);

  useEffect(() => {
    alive.current = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (!alive.current) return;
      setStatus(everConnected.current ? "reconnecting" : "disconnected");
      try {
        ws = new WebSocket(wsUrlFromLocation());
      } catch {
        retry = setTimeout(connect, 2000);
        return;
      }

      ws.onopen = () => {
        if (!alive.current) return;
        everConnected.current = true;
        setConnected(true);
        setStatus("connected");
      };

      ws.onclose = () => {
        if (!alive.current) return;
        setConnected(false);
        setStatus(everConnected.current ? "reconnecting" : "disconnected");
        retry = setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws?.close();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage;
          if (msg.type === "snapshot" || msg.type === "tick") {
            setOverview(msg.overview);
          }
        } catch {
          /* ignore */
        }
      };
    }

    connect();
    return () => {
      alive.current = false;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const applyOverview = useCallback((next: MarketsOverview) => {
    setOverview(next);
  }, []);

  const value = useMemo(
    () => ({ overview, connected, status, applyOverview }),
    [overview, connected, status, applyOverview],
  );
  return <StreamCtx.Provider value={value}>{children}</StreamCtx.Provider>;
}

export function useMarketsStream() {
  return useContext(StreamCtx);
}
