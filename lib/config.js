function envStr(key, fallback) {
  const v = process.env[key];
  return v != null && v !== "" ? v : fallback;
}
function envU64(key, fallback) {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const chainId = envU64("CHAIN_ID", 1);

export const appConfig = {
  company:          envStr("COMPANY_NAME", "Carmlize"),
  app_name:         envStr("APP_NAME", "Carmlize"),
  chain_id:         chainId,
  rpc_url:          envStr("RPC_URL", ""),
  aurelexa_tagline: envStr(
    "AURELEXA_TAGLINE",
    "AI-powered crypto market intelligence — market, on-chain, and external data in one place.",
  ),
};
