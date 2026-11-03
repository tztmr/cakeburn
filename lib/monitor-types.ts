export type SourceStatus = "live" | "partial" | "cached" | "unavailable";

export type Source<T> = {
  data: T | null;
  status: SourceStatus;
  fetchedAt: string | null;
  asOf: string | null;
  source: string;
  sourceUrl: string;
  note?: string;
};

export type Point = { date: number; value: number };
export type Market = {
  priceUSD: number | null;
  priceUSDT: number | null;
  changeUSD: number | null;
  changeUSDT: number | null;
  highUSDT: number | null;
  lowUSDT: number | null;
  volumeUSDT: number | null;
  marketCap: number | null;
  tokenVolume: number | null;
  circulating: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  geckoAsOf: string | null;
  binanceAsOf: string | null;
};

export type Protocol = {
  tvl: number | null;
  volume24h: number | null;
  volumeChange: number | null;
  fees24h: number | null;
  revenue24h: number | null;
  tvlHistory: Point[];
  volumeHistory: Point[];
  feesHistory: Point[];
  revenueHistory: Point[];
  chains: { name: string; value: number }[];
  versions: { name: string; value: number }[];
  coverage: { tvl: boolean; volume: boolean; fees: boolean; revenue: boolean };
  details?: { chainsAsOf?: string | null; tvlHistoryAsOf?: string | null; versionsAsOf?: string | null; cachedParts?: string[] };
};

export type BurnPeriod = {
  date: number;
  productBurn: number | null;
  netMint: number;
  grossBurn: number;
  grossMint: number;
  products: { name: string; amount: number }[];
};
export type BurnTransaction = { date: number; amount: number; from: string; to: string; tx: string };
export type Burns = {
  totalBurn: number;
  totalMint: number;
  totalSupply: number;
  weeklyBurn: number;
  weeklyMint: number;
  supplyHistory: Point[];
  periods: BurnPeriod[];
  transactions: BurnTransaction[];
};
export type Chain = {
  block: number;
  blockTime: string;
  minted: number;
  deadBalance: number;
  outstanding: number;
};
export type Prices = { points: Point[]; currency: "USDT" };
export type Sections = { market: Market; protocol: Protocol; burns: Burns; chain: Chain; prices: Prices };
export type Section = keyof Sections;
export type Dashboard = { [K in Section]: Source<Sections[K]> | null };

export type AlertRule = {
  id: string;
  metric: "price-above" | "price-below" | "burn-above";
  threshold: number;
  enabled: boolean;
};
export type AlertEvent = { id: string; ruleId: string; time: string; message: string };
