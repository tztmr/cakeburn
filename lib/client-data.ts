import type { Governance, Market, Protocol, Section, Sections, Source } from "./monitor-types.ts";
import { fetchJSON } from "./http.ts";
import { completeMarket, emptyMarket } from "./metrics.ts";
import { marketProvider, protocolProvider, pricesProvider, protocolComplete } from "./providers.ts";
import { governanceProvider } from "./governance.ts";

const names = { market: "CoinGecko · Binance", protocol: "DefiLlama", burns: "PancakeSwap", chain: "BNB Chain", prices: "Binance CAKE/USDT", governance: "Snapshot · cakevote.eth" };
const urls = { market: "https://www.coingecko.com/en/coins/pancakeswap", protocol: "https://defillama.com/protocol/pancakeswap", burns: "https://pancakeswap.finance/burn-dashboard", chain: "https://bscscan.com/token/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", prices: "https://www.binance.com/en/trade/CAKE_USDT", governance: "https://snapshot.box/#/s:cakevote.eth" };

// A partial refresh must not erase fields that were already obtained successfully.
export function preserveData<K extends Section>(key: K, next: Sections[K] | null, previous: Sections[K] | null): Sections[K] | null {
  if (!next) return previous;
  if (!previous) return next;
  if (key === "market") {
    const data = { ...next } as Market; const old = previous as Market;
    const bundles = [
      { date: "geckoAsOf" as const, fields: ["priceUSD", "changeUSD", "marketCap", "tokenVolume", "circulating", "totalSupply", "maxSupply"] as const },
      { date: "binanceAsOf" as const, fields: ["priceUSDT", "changeUSDT", "highUSDT", "lowUSDT", "volumeUSDT"] as const },
    ];
    for (const bundle of bundles) {
      const older = Date.parse(data[bundle.date] ?? "") < Date.parse(old[bundle.date] ?? "");
      if (older || !data[bundle.date]) { for (const field of bundle.fields) data[field] = old[field]; data[bundle.date] = old[bundle.date]; }
      else for (const field of bundle.fields) data[field] ??= old[field];
    }
    return data as Sections[K];
  }
  if (key === "protocol") {
    const data = { ...next } as Protocol; const old = previous as Protocol;
    for (const field of ["tvl", "volume24h", "volumeChange", "fees24h", "revenue24h"] as const) data[field] ??= old[field];
    for (const field of ["tvlHistory", "volumeHistory", "feesHistory", "revenueHistory", "chains", "versions"] as const) {
      if (!data[field].length) Object.assign(data, { [field]: old[field] });
    }
    for (const [field, time] of [["chains", "chainsAsOf"], ["tvlHistory", "tvlHistoryAsOf"], ["versions", "versionsAsOf"]] as const) {
      if (!data.details?.[time] || Date.parse(data.details[time]) < Date.parse(old.details?.[time] ?? "")) {
        Object.assign(data, { [field]: old[field] }); data.details = { ...data.details, [time]: old.details?.[time] };
      }
    }
    return data as Sections[K];
  }
  if (key === "prices" && !(next as Sections["prices"]).points.length) return previous;
  if (key === "governance") {
    const data = next as Governance; const old = previous as Governance;
    if (!data.proposals.length) return previous;
    const byId = new Map(old.proposals.map((proposal) => [proposal.id, proposal]));
    // A closed status from the newer response must replace an older "active" copy.
    for (const proposal of data.proposals) byId.set(proposal.id, proposal);
    return { ...data, proposals: [...byId.values()].sort((a, b) => b.created - a.created).slice(0, 60) } as Sections[K];
  }
  return next;
}

export async function loadClientSection<K extends Section>(key: K, previous: Source<Sections[K]> | null, signal: AbortSignal): Promise<Source<Sections[K]>> {
  // Daily histories don't need re-downloading on every one-minute price check.
  if ((key === "protocol" || key === "prices") && previous?.status === "live" && previous.fetchedAt && Date.now() - Date.parse(previous.fetchedAt) < 1_800_000) return previous;
  let result: Source<Sections[K]>;
  try {
    result = await fetchJSON<Source<Sections[K]>>(`/api/monitor?section=${key}`, { signal, timeoutMs: 12_500, cache: "no-store" });
    if (!["live", "partial", "cached", "unavailable"].includes(result.status)) throw new Error("返回数据无效");
    // Do not replace a newer browser result with an older server snapshot.
    if (previous?.data && result.status === "cached" && Date.parse(result.fetchedAt ?? "") < Date.parse(previous.fetchedAt ?? "")) result = { ...previous, status: "cached" };
    result = { ...result, data: preserveData(key, result.data, previous?.data ?? null) };
  } catch {
    if (signal.aborted) throw new Error("请求已取消");
    result = previous?.data ? { ...previous, status: "cached", note: "本次连接失败，保留注明时间的最近成功数据。" }
      : { data: null, status: "unavailable", fetchedAt: null, asOf: null, source: names[key], sourceUrl: urls[key], note: "数据源暂不可用，请稍后刷新。" };
  }
  const needsDirect = key === "market" ? !result.data || !completeMarket(result.data as Market) || result.status !== "live"
    : key === "protocol" ? !result.data || !protocolComplete(result.data as Protocol) || result.status !== "live"
    : key === "prices" ? !(result.data as Sections["prices"] | null)?.points.length || result.status !== "live"
    : key === "governance" ? !(result.data as Governance | null)?.proposals.length || result.status !== "live" : false;
  if (needsDirect && !signal.aborted) {
    const read = (url: string, timeoutMs?: number) => fetchJSON(url, { signal, timeoutMs, headers: { Accept: "application/json" } });
    const post = (url: string, body: string, timeoutMs?: number) => fetchJSON(url, { signal, timeoutMs, method: "POST", body, headers: { Accept: "application/json", "Content-Type": "application/json" } });
    try {
      const direct = key === "market" ? await marketProvider(read, (result.data as Market | null) ?? emptyMarket())
        : key === "protocol" ? await protocolProvider(read, (result.data as Protocol | null) ?? undefined)
        : key === "governance" ? await governanceProvider(post)
        : await pricesProvider(read);
      result = { ...result, data: direct.data as Sections[K], status: direct.partial ? "partial" : "live",
        fetchedAt: new Date().toISOString(), asOf: direct.asOf, note: direct.note };
    } catch { /* Preserve the dated server/browser result if the public endpoint also fails. */ }
  }
  if (signal.aborted) throw new Error("请求已取消");
  return result;
}
