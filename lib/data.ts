import type { Chain, Market, Prices, Protocol, Section, Sections, Source } from "./monitor-types";
import { numeric, normalizeBurnStats, outstandingSupply, series, tokenBalance } from "./metrics";
import archive from "../data/burn-snapshot.json";

export const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
export const DEAD = "0x000000000000000000000000000000000000dead";
export const BURN_URL = "https://burn-stats.pancakeswap.com/data.json";
const GECKO = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=pancakeswap-token";
const BINANCE = "https://data-api.binance.vision/api/v3";
const LLAMA = "https://api.llama.fi";
type JSONRecord = Record<string, unknown>;
function record(value: unknown): JSONRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上游数据格式异常");
  return value as JSONRecord;
}
function optionalRecord(value: unknown): JSONRecord { try { return record(value); } catch { return {}; } }
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
async function fetchBody(url: string, init: RequestInit = {}, timeout = 12_000): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { Accept: "application/json", "User-Agent": "CAKE-Monitor/1.0", ...init.headers }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
  return response.json();
}
async function json(url: string, timeout = 12_000): Promise<JSONRecord> { return record(await fetchBody(url, {}, timeout)); }
type Loaded<K extends Section> = { data: Sections[K]; asOf: string | null; note?: string; snapshotAt?: string; partial?: boolean };
async function geckoMarket() {
  const raw = await fetchBody(GECKO, {}, 4_000);
  if (!Array.isArray(raw) || !raw.length) throw new Error("CoinGecko 市场数据缺失");
  return record(raw[0]);
}
async function loadMarket(): Promise<Loaded<"market">> {
  const [g, b] = await Promise.allSettled([geckoMarket(), json(`${BINANCE}/ticker/24hr?symbol=CAKEUSDT`)]);
  if (g.status === "rejected") console.warn("CoinGecko market fetch:", g.reason instanceof Error ? g.reason.message : "unavailable");
  const gecko = g.status === "fulfilled" ? g.value : null;
  const ticker = b.status === "fulfilled" ? b.value : null;
  const md = gecko ?? {};
  const priceUSD = numeric(md.current_price);
  const priceUSDT = numeric(ticker?.lastPrice);
  if (priceUSD === null && priceUSDT === null) throw new Error("行情数据源暂时不可用");
  const data: Market = {
    priceUSD, priceUSDT, changeUSD: numeric(md.price_change_percentage_24h), changeUSDT: numeric(ticker?.priceChangePercent),
    highUSDT: numeric(ticker?.highPrice), lowUSDT: numeric(ticker?.lowPrice), volumeUSDT: numeric(ticker?.quoteVolume),
    marketCap: numeric(md.market_cap), tokenVolume: numeric(md.total_volume),
    circulating: numeric(md.circulating_supply), totalSupply: numeric(md.total_supply), maxSupply: numeric(md.max_supply),
    geckoAsOf: timestamp(gecko?.last_updated), binanceAsOf: timestamp(ticker?.closeTime),
  };
  return { data, asOf: data.geckoAsOf ?? data.binanceAsOf, partial: !gecko || !ticker, note: !gecko ? "CoinGecko 暂不可用，价格显示 Binance 的 USDT 报价，供应量暂缺。" : !ticker ? "Binance 暂不可用，USDT 提醒暂停判断。" : undefined };
}
async function loadProtocol(): Promise<Loaded<"protocol">> {
  const results = await Promise.allSettled([
    json(`${LLAMA}/protocol/pancakeswap`, 22_000),
    json(`${LLAMA}/summary/dexs/pancakeswap?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false`),
    json(`${LLAMA}/summary/fees/pancakeswap?dataType=dailyFees&excludeTotalDataChartBreakdown=true`),
    json(`${LLAMA}/summary/fees/pancakeswap?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true`),
  ]);
  const [tvl, volume, fees, revenue] = results.map((r) => r.status === "fulfilled" ? r.value : null);
  if (!tvl && !volume && !fees && !revenue) throw new Error("DefiLlama 暂时不可用");
  const history = Array.isArray(tvl?.tvl) ? tvl.tvl : [];
  const tvlHistory = series(history.map((row) => { const item = optionalRecord(row); return [item.date, item.totalLiquidityUSD]; }));
  const chains = Object.entries(optionalRecord(tvl?.currentChainTvls)).flatMap(([name, value]) => {
    const n = numeric(value);
    return name.includes("-") || ["staking", "pool2", "borrowed", "doublecounted", "vesting"].includes(name) || n === null || n <= 0 ? [] : [{ name, value: n }];
  }).sort((a, b) => b.value - a.value);
  const breakdown = Array.isArray(volume?.totalDataChartBreakdown) ? volume.totalDataChartBreakdown : [];
  const latest = breakdown.at(-1);
  const versions = new Map<string, number>();
  if (Array.isArray(latest)) for (const value of Object.values(optionalRecord(latest[1]))) {
    for (const [name, amount] of Object.entries(optionalRecord(value))) {
      const n = numeric(amount);
      if (n !== null && n >= 0) versions.set(name, (versions.get(name) ?? 0) + n);
    }
  }
  const volumeHistory = series(volume?.totalDataChart);
  const data: Protocol = { tvl: tvlHistory.at(-1)?.value ?? null,
    volume24h: numeric(volume?.total24h), volumeChange: numeric(volume?.change_1d),
    fees24h: numeric(fees?.total24h), revenue24h: numeric(revenue?.total24h),
    tvlHistory: tvlHistory.slice(-400), volumeHistory: volumeHistory.slice(-400),
    feesHistory: series(fees?.totalDataChart).slice(-400), revenueHistory: series(revenue?.totalDataChart).slice(-400),
    chains, versions: [...versions].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    coverage: { tvl: !!tvl, volume: !!volume, fees: !!fees, revenue: !!revenue },
  };
  const missing = ["TVL", "交易额", "手续费", "收入"].filter((_, i) => results[i].status === "rejected");
  return { data, asOf: volumeHistory.at(-1) ? new Date(volumeHistory.at(-1)!.date).toISOString() : null, partial: missing.length > 0,
    note: missing.length ? `${missing.join("、")}接口暂不可用，缺失项留空。` : undefined };
}
async function loadBurns(): Promise<Loaded<"burns">> {
  try {
    const raw = await json(BURN_URL);
    return { data: normalizeBurnStats(raw), asOf: timestamp(raw.timestamp) };
  } catch {
    return { data: normalizeBurnStats(archive.data), asOf: timestamp(archive.data.timestamp), snapshotAt: archive.collectedAt,
      note: "官方销毁接口暂不可用，展示已标明日期的历史快照；销毁提醒暂停判断。" };
  }
}
async function loadPrices(): Promise<Loaded<"prices">> {
  const raw = await fetchBody(`${BINANCE}/klines?symbol=CAKEUSDT&interval=1d&limit=365`);
  if (!Array.isArray(raw)) throw new Error("历史行情格式异常");
  // The current UTC day's candle is unfinished and is deliberately excluded.
  const rows = raw.filter((row) => Array.isArray(row) && numeric(row[6]) !== null && Number(row[6]) < Date.now());
  const points = rows.flatMap((row: unknown[]) => {
    const date = numeric(row[0]); const value = numeric(row[4]);
    return date !== null && value !== null && value > 0 ? [{ date, value }] : [];
  });
  if (!points.length) throw new Error("暂无完整日线");
  return { data: { points, currency: "USDT" } satisfies Prices, asOf: new Date(points.at(-1)!.date).toISOString() };
}
async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const data = record(await fetchBody(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  if (data.error || data.result === undefined || data.result === null) throw new Error("公共节点暂不可用");
  return data.result;
}
async function readChain(url: string): Promise<Chain> {
  const [chainId, height] = await Promise.all([rpc(url, "eth_chainId"), rpc(url, "eth_blockNumber")]);
  if (tokenBalance(chainId) !== BigInt(56)) throw new Error("节点网络校验失败");
  const block = Number(tokenBalance(height)) - 15;
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error("区块高度异常");
  const tag = `0x${block.toString(16)}`;
  const [minted, dead, header] = await Promise.all([
    rpc(url, "eth_call", [{ to: CAKE, data: "0x18160ddd" }, tag]),
    rpc(url, "eth_call", [{ to: CAKE, data: `0x70a08231${DEAD.slice(2).padStart(64, "0")}` }, tag]),
    rpc(url, "eth_getBlockByNumber", [tag, false]),
  ]);
  return { block, blockTime: new Date(Number(tokenBalance(record(header).timestamp)) * 1000).toISOString(), ...outstandingSupply(tokenBalance(minted), tokenBalance(dead)) };
}
async function loadChain(): Promise<Loaded<"chain">> {
  const data = await Promise.any([readChain("https://bsc-dataseed.bnbchain.org"), readChain("https://bsc-rpc.publicnode.com")]);
  return { data, asOf: data.blockTime };
}
const config = {
  market: { ttl: 60_000, source: "CoinGecko · Binance", sourceUrl: "https://www.coingecko.com/en/coins/pancakeswap", load: loadMarket },
  protocol: { ttl: 1_800_000, source: "DefiLlama", sourceUrl: "https://defillama.com/protocol/pancakeswap", load: loadProtocol },
  burns: { ttl: 900_000, source: "PancakeSwap 官方焚毁仪表板", sourceUrl: "https://pancakeswap.finance/burn-dashboard", load: loadBurns },
  chain: { ttl: 300_000, source: "BNB Chain 公共节点", sourceUrl: `https://bscscan.com/token/${CAKE}`, load: loadChain },
  prices: { ttl: 1_800_000, source: "Binance CAKE/USDT", sourceUrl: "https://www.binance.com/en/trade/CAKE_USDT", load: loadPrices },
};
const memory = new Map<Section, Source<unknown>>();
const pending = new Map<Section, Promise<Source<unknown>>>();
function edgeCache(): Cache | undefined {
  return typeof caches !== "undefined" ? (caches as CacheStorage & { default?: Cache }).default : undefined;
}
async function resolveSection<K extends Section>(key: K): Promise<Source<Sections[K]>> {
  const settings = config[key];
  const cacheKey = new Request(`https://cakelisten-cache.invalid/v3/${key}`);
  let previous = memory.get(key) as Source<Sections[K]> | undefined;
  if (!previous) {
    try { previous = await (await edgeCache()?.match(cacheKey))?.json() as Source<Sections[K]> | undefined; } catch { /* Optional cross-isolate cache. */ }
  }
  if (previous?.fetchedAt && Date.now() - Date.parse(previous.fetchedAt) < (previous.status === "partial" ? 60_000 : settings.ttl)) return previous;
  try {
    const result = await settings.load();
    const envelope: Source<Sections[K]> = {
      data: result.data as Sections[K], asOf: result.asOf, note: result.note, status: result.snapshotAt ? "cached" : result.partial ? "partial" : "live",
      fetchedAt: result.snapshotAt ?? new Date().toISOString(), source: settings.source, sourceUrl: settings.sourceUrl,
    };
    memory.set(key, envelope);
    try { await edgeCache()?.put(cacheKey, Response.json(envelope, { headers: { "Cache-Control": "public, max-age=86400" } })); } catch { /* Memory caching remains available. */ }
    return envelope;
  } catch {
    if (previous?.data && previous.fetchedAt && Date.now() - Date.parse(previous.fetchedAt) < 86_400_000) {
      return { ...previous, status: "cached", note: "数据源暂时不可用，保留上次成功结果；提醒暂停判断。" };
    }
    return { data: null, status: "unavailable", fetchedAt: null, asOf: null, source: settings.source, sourceUrl: settings.sourceUrl,
      note: "数据源暂时不可用，请稍后刷新。缺失数据未计为 0。" };
  }
}
export function getSection<K extends Section>(key: K): Promise<Source<Sections[K]>> {
  const running = pending.get(key);
  if (running) return running as Promise<Source<Sections[K]>>;
  const request = resolveSection(key).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
