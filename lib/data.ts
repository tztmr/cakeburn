import type { Chain, Governance, Market, Protocol, Prices, Section, Sections, Source } from "./monitor-types.ts";
import { normalizeBurnStats, outstandingSupply, tokenBalance } from "./metrics.ts";
import { fetchJSON, bounded } from "./http.ts";
import { marketProvider, protocolProvider, pricesProvider } from "./providers.ts";
import { governanceProvider, GOVERNANCE_SOURCE, GOVERNANCE_PAGE } from "./governance.ts";
import snapshots from "../data/service-snapshot.json" with { type: "json" };
import archive from "../data/burn-snapshot.json" with { type: "json" };
import governanceArchive from "../data/governance-snapshot.json" with { type: "json" };

export const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
export const DEAD = "0x000000000000000000000000000000000000dead";
export const BURN_URL = "https://burn-stats.pancakeswap.com/data.json";
type JSONRecord = Record<string, unknown>;
function record(value: unknown): JSONRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上游数据格式异常");
  return value as JSONRecord;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
async function fetchBody(url: string, init: RequestInit = {}, timeout = 8_000): Promise<unknown> {
  return fetchJSON(url, { ...init, timeoutMs: timeout, headers: { Accept: "application/json", "User-Agent": "CAKE-Monitor/1.0", ...init.headers } });
}
async function json(url: string, timeout = 8_000): Promise<JSONRecord> { return record(await fetchBody(url, {}, timeout)); }
type Loaded<K extends Section> = { data: Sections[K]; asOf: string | null; note?: string; snapshotAt?: string; partial?: boolean };
const read = (url: string, timeoutMs?: number) => fetchBody(url, {}, timeoutMs);
const loadMarket = (previous?: Market) => marketProvider(read, previous ?? snapshots.market.data);
const loadProtocol = (previous?: Protocol) => protocolProvider(read, previous ?? snapshots.protocol.data);
const loadPrices = () => pricesProvider(read);
async function loadBurns(): Promise<Loaded<"burns">> {
  try {
    const raw = await json(BURN_URL);
    return { data: normalizeBurnStats(raw), asOf: timestamp(raw.timestamp) };
  } catch {
    return { data: normalizeBurnStats(archive.data), asOf: timestamp(archive.data.timestamp), snapshotAt: archive.collectedAt,
      note: "官方销毁接口暂不可用，展示已标明日期的历史快照；销毁提醒暂停判断。" };
  }
}
async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const data = record(await fetchBody(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, 4_000));
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
async function loadGovernance(): Promise<Loaded<"governance">> {
  try {
    const result = await governanceProvider((url, body, timeout) => fetchBody(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, timeout));
    return { data: result.data as Governance, asOf: result.asOf };
  } catch {
    return { data: governanceArchive.data as Governance, asOf: governanceArchive.collectedAt, snapshotAt: governanceArchive.collectedAt,
      note: "Snapshot 治理接口暂不可用，展示已标明日期的历史快照；投票状态与结果可能已变化。" };
  }
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
  governance: { ttl: 900_000, source: GOVERNANCE_SOURCE, sourceUrl: GOVERNANCE_PAGE, load: loadGovernance },
};
const memory = new Map<Section, Source<unknown>>();
function seed<K extends Section>(key: K): Source<Sections[K]> | undefined {
  if (key !== "market" && key !== "protocol" && key !== "prices") return undefined;
  const snapshot = snapshots[key as "market" | "protocol" | "prices"];
  const data = snapshot.data as Market | Protocol | Prices;
  const asOf = key === "market" ? (data as Market).geckoAsOf : key === "prices" ? new Date((data as Prices).points.at(-1)!.date).toISOString() : new Date((data as Protocol).volumeHistory.at(-1)!.date).toISOString();
  return { data: data as Sections[K], status: "cached", fetchedAt: snapshot.collectedAt, asOf,
    source: config[key].source, sourceUrl: config[key].sourceUrl,
    note: "公开数据源暂不可用，展示注明日期的最近成功快照；过期报价不触发提醒。" };
}
function edgeCache(): Cache | undefined {
  return typeof caches !== "undefined" ? (caches as CacheStorage & { default?: Cache }).default : undefined;
}
async function resolveSection<K extends Section>(key: K): Promise<Source<Sections[K]>> {
  const settings = config[key];
  const cacheKey = new Request(`https://cakelisten-cache.invalid/v5/${key}`);
  let previous = memory.get(key) as Source<Sections[K]> | undefined;
  if (!previous) {
    try {
      const response = await bounded(Promise.resolve(edgeCache()?.match(cacheKey)), 400);
      if (response) previous = await bounded(response.json(), 400) as Source<Sections[K]>;
    } catch { /* Completed-result caching is optional. */ }
  }
  if (previous?.fetchedAt && previous.status !== "cached" && Date.now() - Date.parse(previous.fetchedAt) < (previous.status === "partial" ? 60_000 : settings.ttl)) return previous;
  previous ??= seed(key);
  try {
    let operation: Promise<Loaded<Section>>;
    if (key === "market") operation = loadMarket(previous?.data as Market | undefined);
    else if (key === "protocol") operation = loadProtocol(previous?.data as Protocol | undefined);
    else operation = settings.load();
    const result = await bounded(operation, 11_000);
    const envelope: Source<Sections[K]> = {
      data: result.data as Sections[K], asOf: result.asOf, note: result.note,
      status: result.snapshotAt ? "cached" : result.partial ? "partial" : "live",
      fetchedAt: result.snapshotAt ?? new Date().toISOString(), source: settings.source, sourceUrl: settings.sourceUrl,
    };
    memory.set(key, envelope);
    try {
      await bounded(Promise.resolve(edgeCache()?.put(cacheKey, Response.json(envelope, { headers: { "Cache-Control": "public, max-age=86400" } }))), 400);
    } catch { /* Keep the response useful when edge storage is slow. */ }
    return envelope;
  } catch {
    if (previous?.data) return { ...previous, status: "cached", note: "数据源暂时不可用，保留注明时间的最近成功结果；过期报价不触发提醒。" };
    return { data: null, status: "unavailable", fetchedAt: null, asOf: null, source: settings.source, sourceUrl: settings.sourceUrl,
      note: "数据源暂时不可用，请稍后刷新。缺失数据未计为 0。" };
  }
}
// Never share in-flight I/O between Worker requests: a cancelled request must not poison the next one.
export function getSection<K extends Section>(key: K): Promise<Source<Sections[K]>> { return resolveSection(key); }
