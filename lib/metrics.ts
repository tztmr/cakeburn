import type { AlertRule, BurnPeriod, Burns, Market, Point } from "./monitor-types";

export function numeric(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()) || typeof value === "boolean") return null;
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}
export function series(rows: unknown): Point[] {
  if (!Array.isArray(rows)) return [];
  const points = new Map<number, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const date = numeric(row[0]); const value = numeric(row[1]);
    if (date !== null && date > 0 && value !== null && value >= 0) points.set(date * 1000, value);
  }
  return [...points].sort(([a], [b]) => a - b).map(([date, value]) => ({ date, value }));
}
export function tokenBalance(hex: unknown): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-f]+$/i.test(hex)) throw new Error("链上返回值无效");
  return BigInt(hex);
}
export function outstandingSupply(minted: bigint, dead: bigint) {
  if (minted < 0 || dead < 0 || dead > minted) throw new Error("链上余额校验失败");
  const tokens = (value: bigint) => Number(value / BigInt(10 ** 12)) / 1e6;
  return { minted: tokens(minted), deadBalance: tokens(dead), outstanding: tokens(minted - dead) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("官方数据格式异常");
  return value as Record<string, unknown>;
}
function required(value: unknown, signed = false): number {
  const n = numeric(value);
  if (n === null || (!signed && n < 0)) throw new Error("官方数据字段缺失");
  return n;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("官方时间序列缺失");
  return value.map(object);
}
export function normalizeBurnStats(raw: unknown): Burns {
  const data = object(raw);
  const grouped = new Map<number, { name: string; amount: number }[]>();
  for (const row of rows(data.burnTimeSeries)) {
    const date = required(row.timestamp); const amount = required(row.burn);
    if (typeof row.product !== "string") throw new Error("官方产品字段缺失");
    const group = grouped.get(date) ?? [];
    const duplicate = group.find((p) => p.name === row.product);
    if (duplicate) duplicate.amount += amount;
    else group.push({ name: row.product, amount });
    grouped.set(date, group);
  }
  const periods = rows(data.deflationTimeSeries).map((row) => {
    const date = required(row.timestamp); const products = grouped.get(date) ?? [];
    return { date, products, productBurn: grouped.has(date) ? products.reduce((sum, p) => sum + p.amount, 0) : null,
      netMint: required(row.deflation, true), grossBurn: required(row.burn), grossMint: required(row.actualMint) };
  }).sort((a, b) => a.date - b.date);
  const supplyHistory = rows(data.totalSupplyTimeSeries).map((row) => ({ date: required(row.timestamp), value: required(row.total_supply) })).sort((a, b) => a.date - b.date);
  if (!periods.length || !supplyHistory.length) throw new Error("官方历史数据为空");
  const seen = new Set<string>();
  const transactions = rows(data.burnHistoryTable).flatMap((row) => {
    if (typeof row.txHash !== "string" || !/^0x[\da-f]{64}$/i.test(row.txHash) || seen.has(row.txHash)) return [];
    if (typeof row.from !== "string" || !/^0x[\da-f]{40}$/i.test(row.from) || typeof row.to !== "string" || row.to.toLowerCase() !== "0x000000000000000000000000000000000000dead") return [];
    seen.add(row.txHash);
    return [{ tx: row.txHash, date: required(row.timestamp), amount: required(row.amount), from: row.from, to: row.to }];
  }).sort((a, b) => b.date - a.date);
  return { totalBurn: required(data.total_burn), totalMint: required(data.total_mint), totalSupply: required(data.total_supply),
    weeklyBurn: required(data.weekly_burn), weeklyMint: required(data.weekly_mint), periods, supplyHistory, transactions };
}
export function supplementMarket(raw: unknown, current: Market): Market {
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error("行情数据格式无效");
  const coin = object(raw[0]);
  if (coin.id !== "pancakeswap-token" || coin.symbol !== "cake") throw new Error("行情代币不匹配");
  const price = required(coin.current_price);
  if (price <= 0 || typeof coin.last_updated !== "string" || !Number.isFinite(Date.parse(coin.last_updated))) throw new Error("行情时间或价格无效");
  return { ...current, priceUSD: price, changeUSD: numeric(coin.price_change_percentage_24h), marketCap: numeric(coin.market_cap),
    tokenVolume: numeric(coin.total_volume), circulating: numeric(coin.circulating_supply), totalSupply: numeric(coin.total_supply),
    maxSupply: numeric(coin.max_supply), geckoAsOf: new Date(coin.last_updated).toISOString() };
}
export function isFresh(timestamp: string | null | undefined, maxAge = 180_000, now = Date.now()): boolean {
  if (!timestamp) return false;
  const age = now - Date.parse(timestamp);
  return age >= -60_000 && age <= maxAge;
}
export function evaluateRule(rule: AlertRule, priceUSDT: number | null, period: BurnPeriod | null) {
  const value = rule.metric === "burn-above" ? period?.productBurn ?? null : priceUSDT;
  const triggered = rule.enabled && Number.isFinite(rule.threshold) && rule.threshold > 0 && value !== null && Number.isFinite(value) &&
    (rule.metric === "price-below" ? value <= rule.threshold : value >= rule.threshold);
  return { triggered, value, key: rule.metric === "burn-above" ? String(period?.date ?? "") : "price" };
}
