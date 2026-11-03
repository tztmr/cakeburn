import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchJSON } from '../lib/http.ts';
import { marketProvider, protocolProvider, normalizeTvlDetail, normalizePrices, VOLUME_URL, TVL_DETAIL_URL, TVL_NOW_URL, FEES_URL, REVENUE_URL } from '../lib/providers.ts';
import { emptyMarket, isFresh, supplementBinance } from '../lib/metrics.ts';
import { loadClientSection, preserveData } from '../lib/client-data.ts';
const snapshot = JSON.parse(readFileSync(new URL('../data/service-snapshot.json', import.meta.url)));
const never = () => new Promise(() => {});

test('header and JSON-body hangs have a hard deadline, including relative API URLs', async () => {
  for (const request of [never, async () => ({ ok: true, json: never })]) {
    const start = Date.now();
    await assert.rejects(fetchJSON('/api/monitor?section=market', { request, timeoutMs: 25 }), /超时/);
    assert.ok(Date.now() - start < 1000);
  }
  assert.deepEqual(await fetchJSON('https://example.test', { request: async () => Response.json({ ok: true }), timeoutMs: 50 }), { ok: true });
});
test('cancellation rejects a provider that ignores abort and does not poison the next request', async () => {
  const controller = new AbortController();
  const pending = fetchJSON('https://example.test', { request: never, signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(await fetchJSON('https://example.test', { request: async () => Response.json(5) }), 5);
});
test('USDT supplementation validates the exact Binance symbol and never substitutes USD', () => {
  const previous = { ...emptyMarket(), priceUSD: 2 };
  const result = supplementBinance({ symbol: 'CAKEUSDT', lastPrice: '1.95', closeTime: Date.now() }, previous);
  assert.equal(result.priceUSD, 2); assert.equal(result.priceUSDT, 1.95);
  for (const raw of [{ symbol: 'CAKEUSD', lastPrice: 2, closeTime: Date.now() }, { symbol: 'CAKEUSDT', lastPrice: null, closeTime: Date.now() }]) assert.throws(() => supplementBinance(raw, previous));
});
test('failed USD provider preserves dated circulation and cap while Binance can update independently', async () => {
  const result = await marketProvider(async url => {
    if (url.includes('coingecko')) throw new Error('unavailable');
    return { symbol: 'CAKEUSDT', lastPrice: '1.94', closeTime: Date.now() };
  }, snapshot.market.data);
  assert.equal(result.data.circulating, snapshot.market.data.circulating);
  assert.equal(result.data.maxSupply, 400000000);
  assert.equal(result.data.geckoAsOf, snapshot.market.data.geckoAsOf);
  assert.equal(result.data.priceUSDT, 1.94);
  assert.equal(result.partial, true);
});
test('a null server market is recovered in the browser, with both supply and USDT', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.startsWith('/api/')) return Response.json({ data: null, status: 'unavailable', fetchedAt: null, asOf: null, source: 'CoinGecko · Binance', sourceUrl: '' });
    if (url.includes('coingecko')) return Response.json([{ id: 'pancakeswap-token', symbol: 'cake', current_price: 2, last_updated: new Date().toISOString(), circulating_supply: 317000000, max_supply: 400000000 }]);
    return Response.json({ symbol: 'CAKEUSDT', lastPrice: '2.01', closeTime: Date.now() });
  });
  const result = await loadClientSection('market', null, new AbortController().signal);
  assert.equal(result.status, 'live'); assert.equal(result.data.priceUSDT, 2.01);
  assert.equal(result.data.priceUSD, 2); assert.equal(result.data.circulating, 317000000); assert.equal(result.data.maxSupply, 400000000);
});
test('failed live quotes retain their original timestamp and cannot become fresh alert data', async () => {
  const result = await marketProvider(async url => {
    if (!url.includes('coingecko')) throw new Error('unavailable');
    return [{ id: 'pancakeswap-token', symbol: 'cake', current_price: 2, last_updated: new Date().toISOString(), circulating_supply: 317000000, max_supply: 400000000 }];
  }, { ...snapshot.market.data, binanceAsOf: '2020-01-01T00:00:00Z' });
  assert.equal(result.data.binanceAsOf, '2020-01-01T00:00:00Z');
  assert.equal(isFresh(result.data.binanceAsOf), false); assert.equal(result.partial, true);
});
const date = Math.floor(Date.now() / 86400000) * 86400;
const dim = (value, name = 'PancakeSwap') => ({ name, total24h: value, totalDataChart: [[date - 86400, value], [date, value]], change_1d: 0 });
const details = { name: 'PancakeSwap', id: 'parent#pancakeswap', tvl: [{ date, totalLiquidityUSD: 100 }], currentChainTvls: { BSC: 80, 'Robinhood Chain': 10, 'Some-Chain': 10, staking: 40, 'BSC-staking': 40, 'BSC-pool2': 30 } };
test('TVL distribution excludes additive staking categories and preserves real chain names', () => {
  const result = normalizeTvlDetail(details);
  assert.equal(result.chains.reduce((sum, x) => sum + x.value, 0), 100);
  assert.ok(result.chains.some(x => x.name === 'Some-Chain'));
});
function protocolReader(fail = '') {
  return async url => {
    if (url === TVL_DETAIL_URL) { if (fail === 'tvl') throw new Error('timeout'); return details; }
    if (url === TVL_NOW_URL) return 110;
    if (url === VOLUME_URL) return { ...dim(50), childProtocols: [{ name: 'PancakeSwap AMM V3' }, { name: 'PancakeSwap AMM V1', methodologyURL: 'https://github.com/DefiLlama/dimension-adapters/blob/revision/dead/dexs/pancakeswap-v1.ts' }] };
    if (url === FEES_URL) return dim(0);
    if (url === REVENUE_URL) return dim(0);
    assert.ok(url.includes('/pancakeswap-amm-v3?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'));
    return dim(50, 'PancakeSwap AMM V3');
  };
}
test('lightweight protocol endpoints load history, current TVL and correct per-version slugs', async () => {
  const result = await protocolProvider(protocolReader());
  assert.equal(result.partial, false); assert.equal(result.data.tvl, 110);
  assert.equal(result.data.volume24h, 50); assert.equal(result.data.fees24h, 0);
  assert.ok(result.data.volumeHistory.length); assert.equal(result.data.versions[0].value, 50);
  assert.equal(result.data.versions.length, 1);
});
test('TVL detail timeout does not erase volume, current TVL, or dated chain/history fallback', async () => {
  const previous = snapshot.protocol.data;
  const result = await protocolProvider(protocolReader('tvl'), previous);
  assert.equal(result.data.tvl, 110); assert.equal(result.data.volume24h, 50);
  assert.deepEqual(result.data.chains, previous.chains); assert.deepEqual(result.data.tvlHistory, previous.tvlHistory);
  assert.equal(result.data.details.chainsAsOf, previous.details.chainsAsOf);
  assert.ok(result.data.details.cachedParts.includes('TVL 历史与链分布')); assert.equal(result.partial, true);
});
test('partial server fields cannot wipe existing charts or newer Binance quotes', () => {
  const quote = { ...snapshot.market.data, priceUSDT: 2.2, binanceAsOf: '2099-01-01T00:00:00Z' };
  assert.equal(preserveData('market', snapshot.market.data, quote).priceUSDT, 2.2);
  const next = { ...snapshot.protocol.data, tvl: null, chains: [], versions: [], volumeHistory: [] };
  const result = preserveData('protocol', next, snapshot.protocol.data);
  assert.equal(result.tvl, snapshot.protocol.data.tvl); assert.ok(result.chains.length); assert.ok(result.versions.length); assert.ok(result.volumeHistory.length);
});
test('unfinished daily candles are excluded and real fallback snapshots contain every requested series', () => {
  const result = normalizePrices([[1, 0, 0, 0, '2', 0, 10], [20, 0, 0, 0, '3', 0, 100]], 50);
  assert.deepEqual(result.points, [{ date: 1, value: 2 }]);
  assert.ok(snapshot.protocol.data.chains.length >= 5); assert.ok(snapshot.protocol.data.versions.length >= 4);
  for (const field of ['tvlHistory', 'volumeHistory', 'feesHistory', 'revenueHistory']) assert.ok(snapshot.protocol.data[field].length > 90);
  assert.ok(snapshot.prices.data.points.length > 90);
});
