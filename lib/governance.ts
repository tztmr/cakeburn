import type { Governance, GovernanceProposal, GovernanceState } from "./monitor-types.ts";
import type { ProviderResult } from "./providers.ts";
import { numeric } from "./metrics.ts";

export const GOVERNANCE_URL = "https://hub.snapshot.org/graphql";
export const GOVERNANCE_SPACE = "cakevote.eth";
export const GOVERNANCE_PAGE = "https://snapshot.box/#/s:cakevote.eth";
export const GOVERNANCE_LIMIT = 60;
export const GOVERNANCE_SOURCE = "Snapshot · cakevote.eth";

// Snapshot proposals are keyed by a 0x hash; the space is fixed so an unexpected
// deployment cannot silently relabel another project's governance as CAKE's.
const QUERY = `query CakeGovernance($space: String!, $limit: Int!) {
  space(id: $space) {
    id name proposalsCount followersCount
    voting { delay period quorum }
    strategies { name }
  }
  proposals(first: $limit, where: { space: $space }, orderBy: "created", orderDirection: desc) {
    id title state created start end author choices scores scores_total votes quorum snapshot
  }
}`;

export type PostReader = (url: string, body: string, timeoutMs?: number) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("治理数据格式异常");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string") throw new Error(`治理提案的 ${field} 缺失`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`治理提案的 ${field} 无效`);
  return result;
}
function amount(value: unknown): number {
  const n = numeric(value);
  if (n === null || n < 0) throw new Error("治理投票权重无效");
  return n;
}
function seconds(value: unknown): number {
  const n = numeric(value);
  if (n === null || n <= 0) throw new Error("治理提案时间无效");
  return n * 1000;
}
const states: GovernanceState[] = ["active", "pending", "closed"];

export function normalizeProposal(raw: unknown): GovernanceProposal {
  const row = asRecord(raw);
  const id = text(row.id, "编号", 66);
  if (!/^0x[\da-f]{64}$/i.test(id)) throw new Error("治理提案编号无效");
  if (typeof row.state !== "string" || !states.includes(row.state as GovernanceState)) throw new Error("治理提案状态无效");
  const choices = Array.isArray(row.choices) ? row.choices.map((choice) => text(choice, "选项", 300)) : [];
  const scores = Array.isArray(row.scores) ? row.scores.map(amount) : [];
  if (!choices.length || choices.length > 12 || choices.length !== scores.length) throw new Error("治理提案选项或票数缺失");
  const total = amount(row.scores_total);
  const created = seconds(row.created); const start = seconds(row.start); const end = seconds(row.end);
  if (end < start) throw new Error("治理提案投票窗口无效");
  const rawSnapshot = numeric(row.snapshot);
  const rawQuorum = numeric(row.quorum);
  const author = typeof row.author === "string" && /^0x[\da-f]{40}$/i.test(row.author) ? row.author : "未公开";
  return {
    id, title: text(row.title, "标题", 480), state: row.state as GovernanceState,
    created, start, end, author, choices, scores,
    scoresTotal: Math.max(total, ...scores), votes: Math.max(0, Math.round(numeric(row.votes) ?? 0)),
    quorum: rawQuorum !== null && rawQuorum >= 0 ? rawQuorum : null,
    snapshot: rawSnapshot !== null && Number.isSafeInteger(rawSnapshot) ? rawSnapshot : null,
    link: `${GOVERNANCE_PAGE}/proposal/${id}`,
  };
}

export function normalizeGovernance(raw: unknown): Governance {
  const root = asRecord(raw);
  if (Array.isArray(root.errors) && root.errors.length) throw new Error("治理接口返回错误");
  const data = asRecord(root.data ?? root);
  const space = asRecord(data.space);
  if (space.id !== GOVERNANCE_SPACE) throw new Error("治理空间不匹配");
  const seen = new Set<string>();
  const proposals = (Array.isArray(data.proposals) ? data.proposals : []).flatMap((row) => {
    try {
      const proposal = normalizeProposal(row);
      if (seen.has(proposal.id)) return [];
      seen.add(proposal.id);
      return [proposal];
    } catch { return []; }
  }).sort((a, b) => b.created - a.created).slice(0, GOVERNANCE_LIMIT);
  if (!proposals.length) throw new Error("治理提案为空");
  const voting = asRecord(space.voting ?? {});
  const strategies = (Array.isArray(space.strategies) ? space.strategies : []).flatMap((row) => {
    try { const name = asRecord(row).name; return typeof name === "string" && name ? [name] : []; } catch { return []; }
  });
  const count = (value: unknown) => { const n = numeric(value); return n !== null && n >= 0 ? Math.round(n) : 0; };
  const voteSetting = (value: unknown) => { const n = numeric(value); return n !== null && n >= 0 ? n : null; };
  return {
    space: { id: GOVERNANCE_SPACE, name: typeof space.name === "string" && space.name ? space.name : "PancakeSwap",
      proposals: count(space.proposalsCount), followers: count(space.followersCount) },
    voting: { delay: voteSetting(voting.delay), period: voteSetting(voting.period), quorum: voteSetting(voting.quorum) },
    strategies: strategies.length ? strategies : ["erc20-balance-of"],
    proposals,
  };
}

export async function governanceProvider(read: PostReader): Promise<ProviderResult<Governance>> {
  const body = JSON.stringify({ query: QUERY, variables: { space: GOVERNANCE_SPACE, limit: GOVERNANCE_LIMIT } });
  const data = normalizeGovernance(await read(GOVERNANCE_URL, body, 7_000));
  return { data, asOf: new Date().toISOString() };
}
