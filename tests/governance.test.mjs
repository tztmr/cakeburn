import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGovernance, governanceProvider, GOVERNANCE_URL, GOVERNANCE_SPACE } from '../lib/governance.ts';
import { preserveData } from '../lib/client-data.ts';

const archive = JSON.parse(readFileSync(new URL('../data/governance-snapshot.json', import.meta.url)));
const base = 1_792_600_000;

const fixture = () => ({
  data: {
    space: {
      id: 'cakevote.eth', name: 'PancakeSwap', proposalsCount: 3741, followersCount: 111383,
      voting: { delay: 900, period: 259200, quorum: 1 }, strategies: [{ name: 'erc20-balance-of' }],
    },
    proposals: [
      { id: '0x' + 'a'.repeat(64), title: 'Proposal A', state: 'closed', created: base, start: base + 900, end: base + 259200,
        author: '0x' + '1'.repeat(40), choices: ['For', 'Against'], scores: [100, 50], scores_total: 150, votes: 10, quorum: 1, snapshot: 123 },
      { id: '0x' + 'a'.repeat(64), title: 'Duplicate A', state: 'closed', created: base, start: base, end: base + 1,
        author: '0x' + '2'.repeat(40), choices: ['For'], scores: [1], scores_total: 1, votes: 1, quorum: 0, snapshot: 1 },
      { id: '0x' + 'b'.repeat(64), title: 'Proposal B', state: 'active', created: base + 10, start: base + 20, end: base + 30,
        author: '0x' + '3'.repeat(40), choices: ['Yes', 'No'], scores: [7, 2], scores_total: 9, votes: 3, quorum: 0, snapshot: 456 },
      { id: 'bad-id', title: 'Invalid', state: 'closed', created: base, start: base, end: base + 1, author: '0x0', choices: ['For'], scores: [1], scores_total: 1, votes: 1 },
    ],
  },
});

test('real Snapshot archive contains complete, unique CAKE governance proposals', () => {
  const { space, voting, proposals } = archive.data;
  assert.equal(space.id, GOVERNANCE_SPACE); assert.equal(space.name, 'PancakeSwap');
  assert.ok(space.proposals > 3000); assert.ok(space.followers > 100000);
  assert.deepEqual(voting, { delay: 900, period: 259200, quorum: 1 });
  assert.ok(proposals.length >= 40);
  assert.ok(Number.isFinite(Date.parse(archive.collectedAt)));
  const ids = new Set();
  for (const proposal of proposals) {
    assert.match(proposal.id, /^0x[\da-f]{64}$/i); assert.ok(!ids.has(proposal.id)); ids.add(proposal.id);
    assert.ok(proposal.title.length > 0);
    assert.ok(['active', 'pending', 'closed'].includes(proposal.state));
    assert.equal(proposal.choices.length, proposal.scores.length);
    assert.ok(proposal.scores.length > 0);
    assert.ok(proposal.scoresTotal >= Math.max(...proposal.scores));
    assert.equal(proposal.link, `https://snapshot.box/#/s:cakevote.eth/proposal/${proposal.id}`);
    assert.ok(proposal.created > 1e12 && proposal.end >= proposal.start);
  }
  assert.deepEqual(proposals.map((p) => p.created), [...proposals.map((p) => p.created)].sort((a, b) => b - a));
});

test('GraphQL responses are validated, deduplicated, sorted and converted to milliseconds', () => {
  const result = normalizeGovernance(fixture());
  assert.equal(result.space.proposals, 3741);
  assert.equal(result.voting.period, 259200);
  assert.deepEqual(result.strategies, ['erc20-balance-of']);
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0].title, 'Proposal B');
  assert.equal(result.proposals[0].created, (base + 10) * 1000);
  assert.equal(result.proposals[1].scoresTotal, 150);
  assert.equal(result.proposals[1].author, '0x' + '1'.repeat(40));
});

test('wrong spaces, GraphQL errors, empty proposals and malformed rows are rejected', () => {
  const wrong = fixture(); wrong.data.space.id = 'uniswap.eth';
  assert.throws(() => normalizeGovernance(wrong), /空间不匹配/);
  assert.throws(() => normalizeGovernance({ errors: [{ message: 'rate limited' }] }), /错误/);
  assert.throws(() => normalizeGovernance({ data: { ...fixture().data, proposals: [] } }), /为空/);
  const malformed = fixture();
  malformed.data.proposals[2].scores = [7];
  assert.equal(normalizeGovernance(malformed).proposals.length, 1);
});

test('provider posts the fixed space and limit to the Snapshot endpoint', async () => {
  let captured;
  const result = await governanceProvider(async (url, body, timeoutMs) => {
    captured = { url, body: JSON.parse(body), timeoutMs };
    return fixture();
  });
  assert.equal(captured.url, GOVERNANCE_URL);
  assert.equal(captured.body.variables.space, GOVERNANCE_SPACE);
  assert.equal(captured.body.variables.limit, 60);
  assert.match(captured.body.query, /proposals\(first: \$limit/);
  assert.ok(captured.timeoutMs > 0);
  assert.ok(Number.isFinite(Date.parse(result.asOf)));
  assert.equal(result.data.proposals.length, 2);
});

test('a Snapshot outage falls back to the dated archive instead of an empty list', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error('offline'); };
  const { getSection } = await import('../lib/data.ts');
  const result = await getSection('governance');
  assert.equal(result.status, 'cached');
  assert.equal(result.fetchedAt, archive.collectedAt);
  assert.equal(result.data.space.id, GOVERNANCE_SPACE);
  assert.ok(result.data.proposals.length >= 40);
  assert.match(result.note, /历史快照/);
});

test('a newer closed status replaces an older active copy while older proposals are retained', () => {
  const previous = {
    space: { id: GOVERNANCE_SPACE, name: 'PancakeSwap', proposals: 3741, followers: 1 },
    voting: { delay: 900, period: 259200, quorum: 1 }, strategies: ['erc20-balance-of'],
    proposals: [
      { id: '0x' + 'c'.repeat(64), title: 'C', state: 'active', created: 20, start: 21, end: 22, author: '0x0', choices: ['For'], scores: [1], scoresTotal: 1, votes: 1, quorum: 0, snapshot: null, link: 'x' },
      { id: '0x' + 'd'.repeat(64), title: 'D', state: 'closed', created: 10, start: 11, end: 12, author: '0x0', choices: ['For'], scores: [1], scoresTotal: 1, votes: 1, quorum: 0, snapshot: null, link: 'x' },
    ],
  };
  const next = { ...previous, proposals: [{ ...previous.proposals[0], state: 'closed' }] };
  const merged = preserveData('governance', next, previous);
  assert.equal(merged.proposals.length, 2);
  assert.equal(merged.proposals.find((p) => p.id === previous.proposals[0].id).state, 'closed');
  assert.equal(preserveData('governance', { ...previous, proposals: [] }, previous), previous);
});
