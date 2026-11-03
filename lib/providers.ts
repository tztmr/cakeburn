import type { Market, Protocol, Prices, Point } from "./monitor-types.ts";
import { numeric, series, supplementMarket, supplementBinance, emptyMarket, completeMarket } from "./metrics.ts";

export type Reader = (url: string, timeoutMs?: number) => Promise<unknown>;
export type ProviderResult<T> = { data: T; asOf: string | null; partial?: boolean; note?: string; snapshotAt?: string };
export const GECKO_URL = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=pancakeswap-token";
export const BINANCE_BASES = ["https://data-api.binance.vision/api/v3", "https://api.binance.com/api/v3"];
export const LLAMA_BASE = "https://api.llama.fi";
export const VOLUME_URL = `${LLAMA_BASE}/summary/dexs/pancakeswap?excludeTotalDataChartBreakdown=true`;
export const TVL_DETAIL_URL = `${LLAMA_BASE}/protocol/pancakeswap?excludeTokens=true`;
export const TVL_NOW_URL = `${LLAMA_BASE}/tvl/pancakeswap`;
export const FEES_URL = `${LLAMA_BASE}/summary/fees/pancakeswap?dataType=dailyFees&excludeTotalDataChartBreakdown=true`;
export const REVENUE_URL = `${LLAMA_BASE}/summary/fees/pancakeswap?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true`;

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上游数据格式异常");
  return value as Record<string, unknown>;
}
function recordOrEmpty(value: unknown) { try { return asRecord(value); } catch { return {}; } }
const fulfilled = <T>(result: PromiseSettledResult<T>): T | null => result.status === "fulfilled" ? result.value : null;
const pointTime = (points: Point[]) => points.length ? new Date(points.at(-1)!.date).toISOString() : null;

export async function readBinance<T>(read: Reader, path: string, normalize: (raw: unknown) => T): Promise<T> {
  return Promise.any(BINANCE_BASES.map(async (base) => normalize(await read(`${base}/${path}`, 5_000))));
}
export async function marketProvider(read: Reader, previous: Market = emptyMarket()): Promise<ProviderResult<Market>> {
  const [g, b] = await Promise.allSettled([
    read(GECKO_URL, 5_000).then((raw) => supplementMarket(raw, emptyMarket())),
    readBinance(read, "ticker/24hr?symbol=CAKEUSDT", (raw) => supplementBinance(raw, emptyMarket())),
  ]);
  const gecko = fulfilled(g); const binance = fulfilled(b);
  if (!gecko && !binance) throw new Error("行情数据源暂不可用");
  const data: Market = { ...previous };
  const cg = gecko ?? previous;
  const bn = binance ?? previous;
  for (const key of ["priceUSD", "changeUSD", "marketCap", "tokenVolume", "circulating", "totalSupply", "maxSupply"] as const) data[key] = cg[key];
  for (const key of ["priceUSDT", "changeUSDT", "highUSDT", "lowUSDT", "volumeUSDT"] as const) data[key] = bn[key];
  data.geckoAsOf = cg.geckoAsOf; data.binanceAsOf = bn.binanceAsOf;
  const missing = [!gecko ? "美元行情与供应量保留上次成功值" : "", !binance ? "币安报价保留上次成功值，过期报价不触发提醒" : ""].filter(Boolean);
  return { data, asOf: data.geckoAsOf ?? data.binanceAsOf, partial: !gecko || !binance || !completeMarket(data), note: missing.join("；") || undefined };
}

export function normalizeTvlDetail(raw: unknown) {
  const data = asRecord(raw);
  if (data.name !== "PancakeSwap" || data.id !== "parent#pancakeswap") throw new Error("TVL 协议不匹配");
  const tvlHistory = series((Array.isArray(data.tvl) ? data.tvl : []).map((row) => {
    const p = asRecord(row); return [p.date, p.totalLiquidityUSD];
  })).slice(-400);
  const chains = Object.entries(recordOrEmpty(data.currentChainTvls)).flatMap(([name, value]) => {
    const n = numeric(value);
    if (n === null || n <= 0 || /(^|-)staking$|(^|-)pool2$|(^|-)borrowed$|(^|-)vesting$|(^|-)doublecounted$/.test(name)) return [];
    return [{ name, value: n }];
  }).sort((a, b) => b.value - a.value);
  if (!tvlHistory.length || !chains.length) throw new Error("TVL 历史或分链数据缺失");
  return { tvlHistory, chains, tvl: tvlHistory.at(-1)!.value };
}

export function normalizeDimension(raw: unknown, expectedName = "PancakeSwap") {
  const data = asRecord(raw);
  if (data.name !== expectedName) throw new Error("协议统计对象不匹配");
  const value = numeric(data.total24h);
  if (value === null || value < 0) throw new Error("协议统计缺失");
  return { raw: data, value, history: series(data.totalDataChart).slice(-400), change: numeric(data.change_1d) };
}

export function emptyProtocol(): Protocol {
  return { tvl: null, volume24h: null, volumeChange: null, fees24h: null, revenue24h: null,
    tvlHistory: [], volumeHistory: [], feesHistory: [], revenueHistory: [], chains: [], versions: [],
    coverage: { tvl: false, volume: false, fees: false, revenue: false }, details: { cachedParts: [] } };
}
export function protocolComplete(data: Protocol): boolean {
  return data.tvl !== null && data.volume24h !== null && data.fees24h !== null && data.revenue24h !== null &&
    data.tvlHistory.length > 0 && data.volumeHistory.length > 0 && data.chains.length > 0 && data.versions.length > 0 &&
    !data.details?.cachedParts?.length;
}

export async function protocolProvider(read: Reader, previous: Protocol = emptyProtocol()): Promise<ProviderResult<Protocol>> {
  const now = new Date().toISOString();
  const volumeTask = read(VOLUME_URL, 5_000).then((raw) => normalizeDimension(raw));
  const versionsTask = volumeTask.then(async (volume) => {
    const children = Array.isArray(volume.raw.childProtocols) ? volume.raw.childProtocols : [];
    const expected = children.flatMap((c) => {
      const child = recordOrEmpty(c); const name = child.name;
      // DefiLlama retains retired adapters in the metadata, without a current 24h value.
      const retired = typeof child.methodologyURL === "string" && child.methodologyURL.includes("/dead/");
      return !retired && typeof name === "string" && /^PancakeSwap [A-Za-z0-9 ]+$/.test(name) ? [name] : [];
    });
    if (!expected.length) throw new Error("协议版本列表缺失");
    const responses = await Promise.allSettled(expected.map(async (name) => {
      const slug = name.toLowerCase().replace(/ +/g, "-");
      const url = `${LLAMA_BASE}/summary/dexs/${slug}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
      const result = normalizeDimension(await read(url, 4_000), name);
      return { name, value: result.value };
    }));
    const samePeriod = previous.volumeHistory.at(-1)?.date === volume.history.at(-1)?.date;
    let cached = false;
    const versions = responses.flatMap((response, i) => {
      if (response.status === "fulfilled") return [response.value];
      cached = true;
      const old = samePeriod ? previous.versions.find((v) => v.name === expected[i]) : null;
      return old ? [old] : [];
    });
    if (!versions.length) throw new Error("版本统计暂不可用");
    return { versions: versions.sort((a, b) => b.value - a.value), cached, asOf: now };
  });
  const [t, current, v, f, r, versions] = await Promise.allSettled([
    read(TVL_DETAIL_URL, 7_000).then(normalizeTvlDetail),
    read(TVL_NOW_URL, 4_000).then((raw) => { const n = numeric(raw); if (n === null || n < 0) throw new Error("TVL 返回值无效"); return n; }),
    volumeTask,
    read(FEES_URL, 5_000).then((raw) => normalizeDimension(raw)),
    read(REVENUE_URL, 5_000).then((raw) => normalizeDimension(raw)),
    versionsTask,
  ]);
  const tvl = fulfilled(t); const latest = fulfilled(current); const volume = fulfilled(v);
  const fees = fulfilled(f); const revenue = fulfilled(r); const byVersion = fulfilled(versions);
  if (!tvl && latest === null && !volume && !fees && !revenue) throw new Error("协议数据源暂不可用");
  const cachedParts: string[] = [];
  if (!tvl) cachedParts.push("TVL 历史与链分布");
  if (!volume?.history.length) cachedParts.push("交易额");
  if (!fees?.history.length) cachedParts.push("手续费");
  if (!revenue?.history.length) cachedParts.push("协议收入");
  if (!byVersion || byVersion.cached) cachedParts.push("版本构成");
  const data: Protocol = {
    tvl: latest ?? tvl?.tvl ?? previous.tvl,
    volume24h: volume?.value ?? previous.volume24h,
    volumeChange: volume?.change ?? previous.volumeChange,
    fees24h: fees?.value ?? previous.fees24h, revenue24h: revenue?.value ?? previous.revenue24h,
    tvlHistory: tvl?.tvlHistory ?? previous.tvlHistory,
    volumeHistory: volume?.history.length ? volume.history : previous.volumeHistory,
    feesHistory: fees?.history.length ? fees.history : previous.feesHistory,
    revenueHistory: revenue?.history.length ? revenue.history : previous.revenueHistory,
    chains: tvl?.chains ?? previous.chains,
    versions: byVersion?.versions ?? previous.versions,
    coverage: { tvl: !!tvl || latest !== null, volume: !!volume, fees: !!fees, revenue: !!revenue },
    details: { chainsAsOf: tvl ? now : previous.details?.chainsAsOf,
      tvlHistoryAsOf: tvl ? pointTime(tvl.tvlHistory) : previous.details?.tvlHistoryAsOf,
      versionsAsOf: byVersion?.asOf ?? previous.details?.versionsAsOf, cachedParts },
  };
  return { data, asOf: pointTime(data.volumeHistory), partial: !protocolComplete(data),
    note: cachedParts.length ? `${cachedParts.join("、")}暂未完整更新；有时间标记的最近成功数据仍保留。` : undefined };
}

export function normalizePrices(raw: unknown, now = Date.now()): Prices {
  if (!Array.isArray(raw)) throw new Error("历史行情格式异常");
  const points = raw.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const date = numeric(row[0]); const value = numeric(row[4]); const end = numeric(row[6]);
    return date !== null && value !== null && value > 0 && end !== null && end < now ? [{ date, value }] : [];
  }).sort((a, b) => a.date - b.date);
  if (!points.length) throw new Error("暂无完整日线");
  return { points, currency: "USDT" };
}
export async function pricesProvider(read: Reader): Promise<ProviderResult<Prices>> {
  const data = await readBinance(read, "klines?symbol=CAKEUSDT&interval=1d&limit=365", normalizePrices);
  return { data, asOf: pointTime(data.points) };
}
