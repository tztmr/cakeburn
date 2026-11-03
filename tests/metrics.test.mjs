import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { numeric, series, tokenBalance, outstandingSupply, normalizeBurnStats, evaluateRule, isFresh } from '../lib/metrics.ts';
const snapshot = JSON.parse(readFileSync(new URL('../data/burn-snapshot.json', import.meta.url)));

test('missing, blank and invalid values remain missing; a real zero is retained', () => {
  for (const value of [null, undefined, '', '  ', NaN, Infinity, false, {}, 'wrong']) assert.equal(numeric(value), null);
  assert.equal(numeric(0), 0); assert.equal(numeric('0'), 0); assert.equal(numeric('12.5'), 12.5);
});
test('time series preserve gaps, reject invalid rows and deduplicate timestamps', () => {
  assert.deepEqual(series([[1, 3], [3, null], [4, 0], [1, 4], [5, Infinity], ['bad', 6]]), [{ date: 1000, value: 4 }, { date: 4000, value: 0 }]);
});
test('large chain balances are subtracted as integers before converting token decimals', () => {
  const scale = 10n ** 18n; const huge = 10n ** 35n;
  assert.equal(outstandingSupply(huge + 317_000_001n * scale, huge).outstanding, 317_000_001);
  assert.throws(() => outstandingSupply(1n, 2n));
  assert.throws(() => tokenBalance('0x')); assert.throws(() => tokenBalance(null));
  assert.equal(tokenBalance('0x38'), 56n);
});
test('official product burns are kept separate from gross burns and signed net mint', () => {
  const fixture = structuredClone(snapshot.data);
  const date = 1_790_000_000_000;
  fixture.deflationTimeSeries = [{ timestamp: date, burn: 1000000, actualMint: 900000, deflation: -100000 }];
  fixture.burnTimeSeries = [{ timestamp: date, burn: 30, product: 'AMM (v2)' }, { timestamp: date, burn: 20, product: 'Lottery' }];
  const result = normalizeBurnStats(fixture);
  assert.equal(result.periods[0].productBurn, 50);
  assert.equal(result.periods[0].grossBurn, 1000000);
  assert.equal(result.periods[0].netMint, -100000);
  fixture.burnTimeSeries = [];
  assert.equal(normalizeBurnStats(fixture).periods[0].productBurn, null);
  delete fixture.total_supply;
  assert.throws(() => normalizeBurnStats(fixture));
});
test('the real official history reconciles net mint with gross mint minus gross burn', () => {
  const normalized = normalizeBurnStats(snapshot.data);
  assert.ok(normalized.periods.length > 300);
  assert.ok(normalized.transactions.length > 200);
  for (const period of normalized.periods) assert.ok(Math.abs(period.netMint - (period.grossMint - period.grossBurn)) < 0.01);
  assert.ok(Math.abs(normalized.totalMint - normalized.totalBurn - normalized.totalSupply) < 0.01);
});
test('weekly net mint matches the reported net of non-recycle emissions minus product burns', () => {
  const normalized = normalizeBurnStats(snapshot.data);
  const last = normalized.periods.at(-1);
  const emissions = snapshot.data.mintTimeSeries
    .filter((row) => row.timestamp === last.date && !/cake burn/i.test(row.product))
    .reduce((sum, row) => sum + row.mint, 0);
  assert.ok(normalized.weeklyNetMint !== null);
  assert.ok(Math.abs(normalized.weeklyNetMint - (emissions - last.productBurn)) < 0.01);
  assert.ok(normalized.weeklyNetMint > -400_000 && normalized.weeklyNetMint < 0);
  const withoutMints = structuredClone(snapshot.data);
  delete withoutMints.mintTimeSeries;
  assert.equal(normalizeBurnStats(withoutMints).weeklyNetMint, null);
});

test('burn transactions deduplicate hashes and reject non-burn destinations', () => {
  const fixture = structuredClone(snapshot.data);
  const real = fixture.burnHistoryTable[0];
  fixture.burnHistoryTable = [real, real, { ...real, txHash: '0x' + '1'.repeat(64), to: '0x' + '2'.repeat(40) }];
  assert.equal(normalizeBurnStats(fixture).transactions.length, 1);
});
test('threshold equality triggers but missing values, invalid thresholds and disabled rules do not', () => {
  const rule = { id: 'a', metric: 'price-above', threshold: 2, enabled: true };
  assert.equal(evaluateRule(rule, 2, null).triggered, true);
  assert.equal(evaluateRule(rule, null, null).triggered, false);
  assert.equal(evaluateRule({ ...rule, enabled: false }, 3, null).triggered, false);
  assert.equal(evaluateRule({ ...rule, threshold: Infinity }, 3, null).triggered, false);
  assert.equal(evaluateRule({ ...rule, metric: 'price-below' }, 1, null).triggered, true);
  assert.equal(evaluateRule({ ...rule, metric: 'burn-above' }, 10, { date: 123, productBurn: null }).triggered, false);
});
test('old, invalid and future source timestamps cannot qualify as fresh alert data', () => {
  const now = Date.parse('2026-11-03T03:00:00Z');
  assert.equal(isFresh('2026-11-03T02:59:00Z', 180000, now), true);
  for (const time of [null, 'bad', '2026-11-03T02:50:00Z', '2026-11-03T03:10:00Z']) assert.equal(isFresh(time, 180000, now), false);
});

test('market supplementation validates CAKE identity and preserves the separate USDT quote', async () => {
  const { supplementMarket } = await import('../lib/metrics.ts');
  const current = { priceUSDT: 1.95, binanceAsOf: '2026-11-03T03:00:00Z' };
  const quote = { id: 'pancakeswap-token', symbol: 'cake', current_price: 1.9, last_updated: '2026-11-03T03:00:00Z', circulating_supply: 317000000, market_cap: 602300000 };
  const result = supplementMarket([quote], current);
  assert.equal(result.priceUSD, 1.9); assert.equal(result.priceUSDT, 1.95);
  assert.equal(result.circulating, 317000000); assert.equal(result.maxSupply, null);
  assert.throws(() => supplementMarket([{ ...quote, id: 'different-token' }], current));
  assert.throws(() => supplementMarket([{ ...quote, current_price: null }], current));
});
