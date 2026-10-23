/**
 * Build aggregated dashboard metrics from the live market + matching engines.
 *
 * @param {{ overview: () => any; isFeedConnected?: () => boolean }} marketEngine
 * @param {{ listOrders: (marketId: string | undefined, openOnly: boolean) => Promise<any[]> }} matchingEngine
 */
export async function buildDashboardSummary(marketEngine, matchingEngine) {
  const overview = marketEngine.overview();
  const markets = overview?.markets ?? [];

  const ranked = [...markets].sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const top_gainers = ranked.slice(0, 3).map(compactMarket);
  const top_losers = ranked
    .slice()
    .reverse()
    .slice(0, 3)
    .map(compactMarket);

  const openOrders = await matchingEngine.listOrders(undefined, true);

  return {
    active_markets: markets.length,
    volume_24h_total: overview?.volume_24h_total ?? 0,
    top_gainers,
    top_losers,
    open_orders_count: openOrders.length,
    feed_connected: Boolean(marketEngine.isFeedConnected?.()),
    server_ts: overview?.server_ts ?? Math.floor(Date.now() / 1000),
  };
}

function compactMarket(m) {
  return {
    id: m.id,
    pair: m.pair,
    base: m.base,
    quote: m.quote,
    mark_price: m.mark_price,
    change_24h_pct: m.change_24h_pct,
    volume_24h: m.volume_24h,
  };
}
