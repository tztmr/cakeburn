"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowRight, RefreshCw, Bell, X, ExternalLink, ChevronDown, Flame, Activity, Layers3, ArrowDownToLine, Check, Plus, Trash2, Pause, Play, Info, CircleHelp, ShieldCheck } from "lucide-react";
import { BurnChart, TrendChart, EmptyChart, Sparkline, COLORS, compact, productColor } from "@/components/monitor-charts";
import { evaluateRule, isFresh, supplementMarket } from "@/lib/metrics";
import type { AlertEvent, AlertRule, Dashboard, Section, Source, Market } from "@/lib/monitor-types";

const KEYS: Section[] = ["market", "protocol", "burns", "chain", "prices"];
const NAV = [{ id: "overview", label: "总览" }, { id: "burn", label: "CAKE 销毁" }, { id: "protocol", label: "协议活动" }, { id: "supply", label: "供应与行情" }];
const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const empty: Dashboard = { market: null, protocol: null, burns: null, chain: null, prices: null };
const num = (n: number | null | undefined, digits = 2) => n === null || n === undefined ? "—" : compact(n, digits);
const usd = (n: number | null | undefined) => n === null || n === undefined ? "—" : `$${compact(n)}`;
const precise = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const dateTime = (n: string | null | undefined) => n ? new Date(n).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚未取得";
const dateUTC = (n: string | number) => new Date(n).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
function LinkOut({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) { return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} /></a>; }
function Change({ value }: { value: number | null | undefined }) { return value === null || value === undefined ? null : <span className={`change ${value >= 0 ? "positive" : "negative"}`}>{value >= 0 ? "+" : ""}{value.toFixed(2)}%<span className="change-time">24h</span></span>; }
function Stamp({ source }: { source: Source<unknown> | null }) {
  if (!source) return <span className="data-stamp"><i className="status-dot waiting" />连接数据源中</span>;
  return <span className={`data-stamp ${source.status !== "live" ? "warning-text" : ""}`} title={`采集：${dateTime(source.fetchedAt)}；数据截至：${dateTime(source.asOf)}`}><i className={`status-dot ${source.status}`} />{source.status === "cached" ? "历史快照" : source.status === "unavailable" ? "暂不可用" : source.status === "partial" ? "部分数据可用" : "来源已连接"}<span className="stamp-source"> · {source.source}</span></span>;
}
function Panel({ title, en, action, children, className = "" }: { title: string; en?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{en && <span className="en-label">{en}</span>}</div>{action}</div>{children}</section>;
}
function Range({ value, onChange, options = [30, 90, 180, 365] }: { value: number; onChange: (n: number) => void; options?: number[] }) {
  return <div className="range-control" aria-label="图表时间范围">{options.map((n) => <button key={n} className={value === n ? "selected" : ""} onClick={() => onChange(n)} aria-pressed={value === n}>{n === 365 ? "1年" : `${n}天`}</button>)}</div>;
}
function inRange<T extends { date: number }>(rows: T[], days: number): T[] { return rows.filter((p) => p.date >= Date.now() - days * 86_400_000); }
function Distribution({ items, unit = "CAKE" }: { items: { name: string; value: number }[]; unit?: string }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!items.length || total <= 0) return <EmptyChart message="暂无可用的分布数据" />;
  const data = items.length > 6 ? [...items.slice(0, 5), { name: "其他", value: items.slice(5).reduce((s, p) => s + p.value, 0) }] : items;
  return <div className="distribution"><div className="segmented-bar">{data.map((item, i) => <div key={item.name} style={{ width: `${item.value / total * 100}%`, background: unit === "CAKE" ? productColor(item.name) : COLORS[i % COLORS.length] }} title={`${item.name} · ${(item.value / total * 100).toFixed(2)}%`} />)}</div><div className="distribution-rows">{data.map((item, i) => <div className="distribution-row" key={item.name}><span><i style={{ background: unit === "CAKE" ? productColor(item.name) : COLORS[i % COLORS.length] }} />{item.name.replace("PancakeSwap ", "")}</span><strong>{unit === "USD" ? usd(item.value) : num(item.value)}<small>{(item.value / total * 100).toFixed(1)}%</small></strong></div>)}</div><span className="distribution-unit">单位：{unit} · 按已返回的数据计算占比</span></div>;
}
function Metric({ title, en, value, note, children, icon }: { title: string; en: string; value: string; note?: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return <div className="metric"><div className="metric-title">{title}{icon}</div><div className="en-label">{en}</div><div className="metric-value">{value}</div><div className="metric-note">{children ?? note ?? "等待数据"}</div></div>;
}
function validateRules(value: unknown): AlertRule[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v.id === "string" && ["price-above", "price-below", "burn-above"].includes(v.metric) && Number.isFinite(v.threshold) && v.threshold > 0 && typeof v.enabled === "boolean").slice(0, 20) : [];
}
export default function Monitor() {
  const [data, setData] = useState<Dashboard>(empty);
  const [view, setView] = useState("overview");
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshTime, setRefreshTime] = useState<string | null>(null);
  const [burnRange, setBurnRange] = useState(90);
  const [trendRange, setTrendRange] = useState(90);
  const [priceRange, setPriceRange] = useState(90);
  const [burnMode, setBurnMode] = useState<"products" | "net">("products");
  const [trendMetric, setTrendMetric] = useState("volume");
  const [visibleTx, setVisibleTx] = useState(8);
  const [query, setQuery] = useState("");
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState("");
  const [metric, setMetric] = useState<AlertRule["metric"]>("price-above");
  const [threshold, setThreshold] = useState("");
  const [permission, setPermission] = useState("default");
  const [alertError, setAlertError] = useState("");
  const running = useRef(false);
  const controllers = useRef<AbortController[]>([]);
  const fired = useRef<Record<string, { active: boolean; period: string; time: number }>>({});
  const modal = useRef<HTMLDivElement>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const notify = useCallback((text: string) => setToast(text), []);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true; setLoading(true);
    try {
      await Promise.allSettled(KEYS.map(async (key) => {
        const controller = new AbortController(); controllers.current.push(controller);
        const timeout = setTimeout(() => controller.abort(), 28_000);
        try {
          const response = await fetch(`/api/monitor?section=${key}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error("数据服务连接失败");
          let result = await response.json() as Source<unknown>;
          if (!["live", "partial", "cached", "unavailable"].includes(result.status)) throw new Error("返回数据无效");
          if (key === "market" && result.data && !(result.data as Market).priceUSD) {
            // The public browser endpoint can remain reachable when an edge provider is rate limited.
            try {
              const gecko = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=pancakeswap-token", { signal: controller.signal });
              if (!gecko.ok) throw new Error("行情补充读取失败");
              const augmented = supplementMarket(await gecko.json(), result.data as Market);
              result = { ...result, data: augmented, asOf: augmented.geckoAsOf, fetchedAt: new Date().toISOString(),
                status: augmented.priceUSDT !== null && isFresh(augmented.binanceAsOf) ? "live" : "partial", note: augmented.priceUSDT === null ? "USDT 报价暂不可用，价格提醒暂停。" : undefined };
            } catch { /* Keep the server's explicitly labelled partial result. */ }
          }
          setData((old) => ({ ...old, [key]: result }));
        } catch {
          if (controller.signal.aborted && !running.current) return;
          setData((old) => ({ ...old, [key]: old[key]?.data ? { ...old[key], status: "cached", note: "本次刷新失败，保留上次成功结果。" } : { data: null, status: "unavailable", fetchedAt: null, asOf: null, source: key, sourceUrl: "", note: "数据服务连接失败，请稍后刷新。" } }));
        } finally { clearTimeout(timeout); controllers.current = controllers.current.filter((c) => c !== controller); }
      }));
      setRefreshTime(new Date().toISOString());
    } finally { running.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (NAV.some((n) => n.id === hash)) setView(hash);
    try {
      const stored = JSON.parse(localStorage.getItem("cake-monitor-alerts-v1") ?? "{}");
      setRules(validateRules(stored.rules));
      setEvents(Array.isArray(stored.events) ? stored.events.filter((e: AlertEvent) => e && typeof e.message === "string" && typeof e.id === "string" && typeof e.time === "string").slice(0, 50) : []);
      if (stored.fired && typeof stored.fired === "object" && !Array.isArray(stored.fired)) fired.current = stored.fired;
    } catch { setToast("本地提醒设置未能读取，本次从空设置开始。"); }
    setHydrated(true);
    if ("Notification" in window) setPermission(Notification.permission);
    void refresh();
    return () => { running.current = false; controllers.current.forEach((c) => c.abort()); };
  }, [refresh]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onFocus); };
  }, [auto, refresh]);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem("cake-monitor-alerts-v1", JSON.stringify({ rules, events, fired: fired.current })); }
    catch { setAlertError("浏览器未能保存提醒设置；关闭页面后可能丢失。"); }
  }, [rules, events, hydrated]);
  useEffect(() => {
    if (!hydrated || !auto) return;
    const newEvents: AlertEvent[] = [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const isBurn = rule.metric === "burn-above";
      const source = isBurn ? data.burns : data.market;
      if (!source || !["live", "partial"].includes(source.status) || !isFresh(source.fetchedAt, isBurn ? 1_800_000 : 180_000)) continue;
      if (!isBurn && !isFresh(data.market?.data?.binanceAsOf)) continue;
      if (isBurn && !isFresh(source.asOf, 10 * 86_400_000)) continue;
      const result = evaluateRule(rule, data.market?.data?.priceUSDT ?? null, data.burns?.data?.periods.at(-1) ?? null);
      const previous = fired.current[rule.id] ?? { active: false, period: "", time: 0 };
      const shouldFire = result.triggered && (isBurn ? previous.period !== result.key : !previous.active && Date.now() - previous.time >= 15 * 60_000);
      fired.current[rule.id] = { ...previous, active: result.triggered };
      if (!shouldFire) continue;
      const message = isBurn ? `本期产品销毁 ${precise(result.value)} CAKE，达到 ${precise(rule.threshold)} CAKE。` : `CAKE/USDT 为 ${result.value?.toFixed(4)}，${rule.metric === "price-above" ? "达到或高于" : "达到或低于"} ${rule.threshold}。`;
      fired.current[rule.id] = { active: true, period: result.key, time: Date.now() };
      newEvents.push({ id: crypto.randomUUID(), ruleId: rule.id, time: new Date().toISOString(), message });
      if ("Notification" in window && Notification.permission === "granted") { try { new Notification("CAKE Monitor 提醒", { body: message, icon: "/favicon.svg" }); } catch { /* In-page history remains available. */ } }
    }
    if (newEvents.length) { setEvents((old) => [...newEvents, ...old].slice(0, 50)); setToast(newEvents[0].message); }
    else { try { localStorage.setItem("cake-monitor-alerts-v1", JSON.stringify({ rules, events, fired: fired.current })); } catch { /* Save errors are surfaced by the settings effect. */ } }
  }, [data, rules, hydrated, auto, events]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(""), 6000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    if (!alertsOpen) return;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAlertsOpen(false);
      if (e.key === "Tab") {
        const els = modal.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,[href]');
        if (!els?.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === els[els.length - 1]) { e.preventDefault(); els[0].focus(); }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keyboard); triggerButton.current?.focus(); };
  }, [alertsOpen]);

  const market = data.market?.data;
  const protocol = data.protocol?.data;
  const burns = data.burns?.data;
  const last = burns?.periods.at(-1);
  const liveCount = KEYS.filter((k) => data[k]?.status === "live").length;
  const allDone = KEYS.every((k) => !!data[k]);
  const historyPeak = burns?.supplyHistory.length ? Math.max(...burns.supplyHistory.map((p) => p.value)) : null;
  const peakReduction = historyPeak && burns ? (historyPeak - burns.totalSupply) / historyPeak * 100 : null;
  const trendPoints = trendMetric === "tvl" ? protocol?.tvlHistory : trendMetric === "fees" ? protocol?.feesHistory : trendMetric === "revenue" ? protocol?.revenueHistory : protocol?.volumeHistory;
  const trendTitle = trendMetric === "tvl" ? "总锁仓量" : trendMetric === "fees" ? "交易手续费" : trendMetric === "revenue" ? "协议收入" : "协议交易额";
  const switchView = (id: string) => { setView(id); window.history.replaceState(null, "", `#${id}`); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const transactions = burns?.transactions.filter((tx) => tx.tx.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const exportCSV = () => {
    if (!transactions.length) return;
    const rows = [["date_UTC", "gross_burn_CAKE", "transaction", "from", "to"], ...transactions.map((t) => [new Date(t.date).toISOString(), t.amount, t.tx, t.from, t.to])];
    const url = URL.createObjectURL(new Blob(["\ufeff" + rows.map((r) => r.join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "CAKE-burn-transactions.csv"; a.click(); URL.revokeObjectURL(url); notify(`已导出 ${transactions.length} 笔链上毛销毁记录。`);
  };
  const addRule = (e: React.FormEvent) => {
    e.preventDefault(); const n = Number(threshold);
    if (!Number.isFinite(n) || n <= 0) { setAlertError("请输入大于 0 的有效阈值。"); return; }
    if (rules.length >= 20) { setAlertError("最多保存 20 条提醒，请先删除不用的规则。"); return; }
    setRules((old) => [...old, { id: crypto.randomUUID(), metric, threshold: n, enabled: true }]); setThreshold(""); setAlertError(""); notify("已添加提醒，自动监控时首次满足条件即会记录。");
  };
  const burnPanel = <Panel title="CAKE 销毁历史" en="PRODUCT BURNS & SUPPLY CHANGE" action={<Range value={burnRange} onChange={setBurnRange} />}>
    <div className="chart-toolbar"><div className="text-tabs"><button className={burnMode === "products" ? "active" : ""} onClick={() => setBurnMode("products")}>产品销毁</button><button className={burnMode === "net" ? "active" : ""} onClick={() => setBurnMode("net")}>净供应变化</button></div><span className="chart-unit">单位：CAKE</span></div>
    {burns ? <BurnChart periods={inRange(burns.periods, burnRange)} mode={burnMode} /> : <EmptyChart message={data.burns ? "销毁数据暂不可用" : undefined} />}
    <div className="panel-foot"><Stamp source={data.burns} /><span>按官方每周统计期 · UTC</span></div>
  </Panel>;
  const protocolPanel = <Panel title="协议活动趋势" en="PANCAKESWAP ACTIVITY" action={<Range value={trendRange} onChange={setTrendRange} />}>
    <div className="chart-toolbar"><div className="text-tabs">{[{ id: "volume", text: "交易额" }, { id: "tvl", text: "TVL" }, { id: "fees", text: "手续费" }, { id: "revenue", text: "协议收入" }].map((t) => <button key={t.id} className={trendMetric === t.id ? "active" : ""} onClick={() => setTrendMetric(t.id)}>{t.text}</button>)}</div><span className="chart-unit">USD</span></div>
    {protocol ? <TrendChart points={inRange(trendPoints ?? [], trendRange)} label={trendTitle} /> : <EmptyChart message={data.protocol ? "协议数据暂不可用" : undefined} />}
    <div className="panel-foot"><Stamp source={data.protocol} /><span>日度数据 · 不填补缺失日期</span></div>
  </Panel>;

  return <>
    <header className="site-header"><div className="header-inner"><button className="brand" onClick={() => switchView("overview")} aria-label="CAKE Monitor 首页"><img src="/favicon.svg" alt="" /><span>CAKE<span className="brand-light">MONITOR</span><small>PancakeSwap 数据终端</small></span></button><nav aria-label="主导航">{NAV.map((n) => <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => switchView(n.id)} aria-current={view === n.id ? "page" : undefined}>{n.label}</button>)}</nav><div className="header-actions"><LinkOut href="https://pancakeswap.finance/burn-dashboard" className="official-link">官方仪表板</LinkOut><button className="alert-trigger" ref={triggerButton} onClick={() => setAlertsOpen(true)}><Bell size={16} /><span>监控提醒</span>{rules.some((r) => r.enabled) && <i />}</button></div></div></header>
    <main className="main-container">
      <div className="connection-bar"><span><i className={`status-dot ${liveCount === 5 ? "live" : allDone ? "cached" : "waiting"}`} />{!allDone ? "正在连接公开数据源" : `${liveCount}/5 数据源完整${liveCount < 5 ? " · 部分数据待恢复" : ""}`}<span className="connection-detail"> · {auto ? "每 60 秒检查" : "自动检查已暂停"}</span></span><div><button className="icon-button" onClick={() => setAuto((v) => !v)} title={auto ? "暂停自动检查" : "恢复自动检查"} aria-label={auto ? "暂停自动检查" : "恢复自动检查"}>{auto ? <Pause size={13} /> : <Play size={13} />}</button><button className="refresh-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} className={loading ? "spin" : ""} />{loading ? "更新中" : "刷新"}</button></div></div>
      {view === "overview" ? <section className="hero"><div className="hero-copy"><span className="eyebrow"><i />ONCHAIN SIGNALS, CLEARER.</span><h1>看见协议的增长，<br />读懂 <em>CAKE</em> 的变化。</h1><p>从交易活跃到产品销毁，让每一次供应变化都有据可查。</p><div className="hero-links"><button onClick={() => switchView("burn")}>探索销毁数据<ArrowRight size={15} /></button><a href="#methodology">了解数据口径<CircleHelp size={14} /></a></div></div><div className="hero-market"><div className="token-label"><img src="/favicon.svg" alt="CAKE" /><div><strong>PancakeSwap</strong><span>CAKE / {market?.priceUSD !== null && market?.priceUSD !== undefined ? "USD" : "USDT"}</span></div><span className="network-pill">BNB Chain</span></div><div className="hero-price">{market?.priceUSD != null ? `$${market.priceUSD.toFixed(3)}` : market?.priceUSDT != null ? market.priceUSDT.toFixed(3) : "—"}<Change value={market?.priceUSD != null ? market?.changeUSD : market?.changeUSDT} /></div><Sparkline points={data.prices?.data?.points ?? []} /><div className="market-mini-grid"><div><span>流通市值</span><strong>{usd(market?.marketCap)}</strong></div><div><span>流通供应量</span><strong>{num(market?.circulating)}<small> CAKE</small></strong></div><div><span>协议总锁仓量</span><strong>{usd(protocol?.tvl)}</strong></div></div><Stamp source={data.market} /></div></section> : <section className="page-title"><span className="eyebrow">PANCAKESWAP DATA TERMINAL</span><h1>{view === "burn" ? "CAKE 销毁与通缩" : view === "protocol" ? "每一笔交易背后的协议活动" : "供应变化，与市场同步观察"}</h1><p>{view === "burn" ? "把产品销毁、毛销毁和净供应变化分开，追踪每个统计期的真实记录。" : view === "protocol" ? "观察 PancakeSwap 的交易额、TVL、交易手续费和协议收入。" : "对照官方供应历史、市场流通量与链上合约余额，理解不同的数据口径。"}</p></section>}
      {(view === "overview" || view === "burn") && <div className="metrics-grid">
        <Metric title={view === "burn" ? "本期链上毛销毁" : "24H 协议交易额"} en={view === "burn" ? "GROSS ONCHAIN BURN" : "PROTOCOL VOLUME"} value={view === "burn" ? num(burns?.weeklyBurn) : usd(protocol?.volume24h)} note={view === "burn" ? "含为排放核算而铸造后销毁的 CAKE" : "DefiLlama · PancakeSwap 全协议"}>{view === "overview" ? <><Change value={protocol?.volumeChange} /><span>较上一统计日</span></> : undefined}</Metric>
        <Metric title={view === "burn" ? "本期链上铸造" : "24H 交易手续费"} en={view === "burn" ? "GROSS TOKEN MINT" : "SWAP FEES"} value={view === "burn" ? num(burns?.weeklyMint) : usd(protocol?.fees24h)} note={view === "burn" ? "官方仪表板本期累计铸造口径" : "用户支付的交易手续费"} />
        <Metric title="最新一期产品销毁" en="LATEST PRODUCT BURN" value={num(last?.productBurn)} icon={<Flame size={15} />} note={last ? `${dateUTC(last.date)} · CAKE · 官方统计期` : "等待官方产品数据"} />
        <Metric title="最新一期净供应变化" en="NET SUPPLY CHANGE" value={last ? `${last.netMint > 0 ? "+" : ""}${num(last.netMint)}` : "—"} note={last ? `${last.netMint <= 0 ? "净减少" : "净增加"} · CAKE · 铸造减销毁` : "负数表示净通缩"} />
      </div>}
      {view === "protocol" && <div className="metrics-grid"><Metric title="协议总锁仓量" en="TOTAL VALUE LOCKED" value={usd(protocol?.tvl)} note="不含 staking / pool2 的附加口径" /><Metric title="24H 协议交易额" en="PROTOCOL VOLUME" value={usd(protocol?.volume24h)} note="多链、多版本聚合" /><Metric title="24H 交易手续费" en="SWAP FEES" value={usd(protocol?.fees24h)} note="用户支付的费用" /><Metric title="24H 协议收入" en="PROTOCOL REVENUE" value={usd(protocol?.revenue24h)} note="金库与持币者收入，非全部用于销毁" /></div>}
      {(view === "overview" || view === "burn") && <div className="content-grid"><div className="wide-column">{burnPanel}</div><Panel title="产品销毁构成" en="BURN BY PRODUCT" action={<span className="small-pill">最新一期</span>}><div className="side-total"><span>本期产品合计</span><strong>{num(last?.productBurn)}<small> CAKE</small></strong><p>{last ? dateUTC(last.date) : "—"} · 官方产品统计</p></div><Distribution items={last?.products.map((p) => ({ name: p.name, value: p.amount })) ?? []} /></Panel></div>}
      {(view === "overview" || view === "protocol") && <div className="content-grid"><div className="wide-column">{protocolPanel}</div>{view === "overview" ? <section className="supply-summary"><div className="supply-summary-top"><Layers3 size={20} /><span>SUPPLY IN FOCUS</span></div><h2>销毁之后，<br />供应还剩多少？</h2><div className="supply-summary-value"><span>官方当前总供应量</span><strong>{num(burns?.totalSupply)}<small> CAKE</small></strong></div><div className="supply-summary-detail"><span>较官方历史峰值减少</span><strong>{peakReduction === null ? "—" : `${peakReduction.toFixed(2)}%`}</strong></div><button onClick={() => switchView("supply")}>查看供应与链上核对<ArrowUpRight size={16} /></button><span className="summary-date">截至 {data.burns?.asOf ? dateUTC(data.burns.asOf) : "—"} · 官方口径</span></section> : <Panel title="TVL 链分布" en="LIQUIDITY BY CHAIN"><Distribution items={protocol?.chains ?? []} unit="USD" /><Stamp source={data.protocol} /></Panel>}</div>}
      {view === "protocol" && <div className="content-grid"><Panel title="交易额版本构成" en="VOLUME BY VERSION"><Distribution items={protocol?.versions ?? []} unit="USD" /><p className="fine-print">最近完整统计日；同一版本在各链的交易额合并。</p></Panel><Panel title="费用如何关联 CAKE" en="FEES → REVENUE → BURNS"><div className="flow-step"><span>01</span><div><h3>用户交易产生手续费</h3><p>交易手续费包含支付给流动性提供者的部分。</p></div></div><div className="flow-step"><span>02</span><div><h3>部分费用计入协议收入</h3><p>收入按产品规则在金库、持币者等用途间分配。</p></div></div><div className="flow-step"><span>03</span><div><h3>按实际产品数据记录销毁</h3><p>不把协议收入按当前币价直接折算成已销毁 CAKE。</p></div></div><LinkOut href="https://blog.pancakeswap.finance/articles/pancake-swap-cake-burn-mechanics-a-comprehensive-guide" className="inline-link">查看官方销毁机制说明</LinkOut></Panel></div>}
      {view === "supply" && <>
        <div className="metrics-grid"><Metric title="官方当前总供应量" en="OFFICIAL TOTAL SUPPLY" value={num(burns?.totalSupply)} note="PancakeSwap 焚毁仪表板 · CAKE" /><Metric title="市场流通供应量" en="CIRCULATING SUPPLY" value={num(market?.circulating)} note="CoinGecko 流通口径 · CAKE" /><Metric title="市场供应上限" en="REPORTED MAX SUPPLY" value={num(market?.maxSupply)} note="CoinGecko 报告值，非合约强制上限" /><Metric title="历史峰值以来供应减少" en="SUPPLY REDUCTION" value={peakReduction === null ? "—" : `${peakReduction.toFixed(2)}%`} note="根据官方历史供应快照计算" /></div>
        <Panel title="CAKE 总供应量历史" en="OFFICIAL WEEKLY SUPPLY SNAPSHOTS" action={<Range value={burnRange} onChange={setBurnRange} />}><TrendChart points={inRange(burns?.supplyHistory ?? [], burnRange)} label="CAKE Supply" unit="CAKE" zero={false} color="#ed854c" /><div className="panel-foot"><Stamp source={data.burns} /><span>每周供应快照 · 不等于流通量</span></div></Panel>
        <div className="content-grid supply-grid"><Panel title="CAKE / USDT 市场走势" en="COMPLETED DAILY CLOSES" action={<Range value={priceRange} onChange={setPriceRange} />}><div className="price-heading"><strong>{market?.priceUSDT != null ? market.priceUSDT.toFixed(4) : "—"}<small> USDT</small></strong><Change value={market?.changeUSDT} /></div><TrendChart points={inRange(data.prices?.data?.points ?? [], priceRange)} label="CAKE / USDT" unit="USDT" zero={false} color="#ed854c" /><div className="panel-foot"><Stamp source={data.prices} /><span>仅包含已完成 UTC 日线</span></div></Panel><Panel title="链上余额核对" en="SAME-BLOCK VERIFICATION" action={<ShieldCheck size={17} className="teal" />}><p className="body-note">在同一个已确认区块读取 CAKE 合约的累计铸造量和 0x…dEaD 余额。</p><div className="audit-rows"><div><span>合约累计铸造量</span><strong>{num(data.chain?.data?.minted)} CAKE</strong></div><div><span>销毁地址累计余额</span><strong>{num(data.chain?.data?.deadBalance)} CAKE</strong></div><div className="audit-result"><span>两者差额</span><strong>{num(data.chain?.data?.outstanding)} CAKE</strong></div><div><span>区块高度</span><strong>{data.chain?.data ? <LinkOut href={`https://bscscan.com/block/${data.chain.data.block}`}>#{data.chain.data.block.toLocaleString("en-US")}</LinkOut> : "—"}</strong></div></div><Stamp source={data.chain} /><p className="fine-print">该差额包含待后续销毁的铸造量，不直接作为流通量，也不与官方总供应量混用。</p><LinkOut href={`https://bscscan.com/token/${CAKE}`} className="inline-link">在 BscScan 核对合约</LinkOut></Panel></div>
        <div className="metrics-grid small-metrics"><Metric title="24H 最高价" en="BINANCE CAKE/USDT" value={market?.highUSDT?.toFixed(4) ?? "—"} note="USDT" /><Metric title="24H 最低价" en="BINANCE CAKE/USDT" value={market?.lowUSDT?.toFixed(4) ?? "—"} note="USDT" /><Metric title="24H 币安成交额" en="BINANCE QUOTE VOLUME" value={num(market?.volumeUSDT)} note="USDT · 单一交易市场" /><Metric title="24H 代币全市场成交额" en="TOKEN MARKET VOLUME" value={usd(market?.tokenVolume)} note="CoinGecko · 不等于协议交易额" /></div>
      </>}
      {view === "burn" && <Panel title="最近链上销毁记录" en="VERIFIABLE BURN TRANSACTIONS" action={<button className="text-button" onClick={exportCSV} disabled={!transactions.length}><ArrowDownToLine size={14} />导出 CSV</button>}><div className="table-toolbar"><p>这里列示链上毛销毁，包含排放核算相关的销毁，金额通常大于产品销毁。</p><input aria-label="搜索交易哈希" placeholder="搜索交易哈希…" value={query} onChange={(e) => { setQuery(e.target.value); setVisibleTx(8); }} /></div><div className="table-scroll"><table><thead><tr><th>统计日期（UTC）</th><th>链上毛销毁 / CAKE</th><th>交易哈希</th><th>发送方</th></tr></thead><tbody>{transactions.slice(0, visibleTx).map((tx) => <tr key={tx.tx}><td>{dateUTC(tx.date)}</td><td className="tabular">{precise(tx.amount)}</td><td><LinkOut href={`https://bscscan.com/tx/${tx.tx}`}>{tx.tx.slice(0, 8)}…{tx.tx.slice(-6)}</LinkOut></td><td><LinkOut href={`https://bscscan.com/address/${tx.from}`}>{tx.from.slice(0, 6)}…{tx.from.slice(-4)}</LinkOut></td></tr>)}</tbody></table>{!transactions.length && <div className="table-empty">{query ? "未找到符合条件的交易" : "暂无可用的交易记录"}</div>}</div><div className="table-bottom"><span>已显示 {Math.min(visibleTx, transactions.length)} / {transactions.length} 笔</span>{visibleTx < transactions.length && <button onClick={() => setVisibleTx((v) => v + 20)}>查看更多<ChevronDown size={14} /></button>}</div></Panel>}
      <section className="sources-section" id="methodology"><div className="section-heading"><div><span className="eyebrow">TRACEABLE BY DESIGN</span><h2>数据有出处，变化有依据。</h2></div><span className="source-updated">最近检查：{dateTime(refreshTime)}（北京时间）</span></div><div className="source-grid">{KEYS.map((key) => <div key={key} className="source-card"><div className="source-card-top"><span>{({ market: "行情与流通量", protocol: "协议活动", burns: "销毁与供应历史", chain: "链上余额核对", prices: "CAKE / USDT 日线" })[key]}</span><i className={`status-dot ${data[key]?.status ?? "waiting"}`} /></div><strong>{data[key]?.source ?? ({ market: "CoinGecko · Binance", protocol: "DefiLlama", burns: "PancakeSwap", chain: "BNB Chain", prices: "Binance" })[key]}</strong><small>数据截至 {dateTime(data[key]?.asOf)}</small><small>采集于 {dateTime(data[key]?.fetchedAt)}</small>{data[key]?.note && <p className="source-warning">{data[key]?.note}</p>}{data[key]?.sourceUrl && <LinkOut href={data[key]!.sourceUrl} className="source-link">查看来源</LinkOut>}</div>)}</div><details className="methodology"><summary><Info size={15} />统计口径与监控说明<ChevronDown size={15} /></summary><div className="methodology-content"><p><strong>销毁的三个口径。</strong>产品销毁来自官方 burnTimeSeries，按产品逐项汇总；链上毛销毁使用 weekly_burn 和交易记录；净供应变化使用官方 deflationTimeSeries，负数表示铸造少于销毁。三者不相加。大额铸造、待销毁余额与核算时点可能造成单期净变化跳动。</p><p><strong>供应与市场。</strong>官方总供应量使用 total_supply；流通量和市值使用 CoinGecko。链上核对是同一区块的 totalSupply() 减销毁地址余额，含未完成核算的部分。市场报价同时区分 USD 与 USDT。</p><p><strong>时间与缺失值。</strong>统计日期、日线和销毁周期采用 UTC；采集时间展示为北京时间。页面每 60 秒检查，服务端按源缓存 1–30 分钟，数据源各自按其周期发布。图表不把缺失记录补成 0；源异常保留有日期的快照并显示提示。日线不包含未收盘日。</p><p><strong>提醒范围。</strong>规则仅保存在当前浏览器。本页面打开、可见且自动检查开启时判断；浏览器后台可能限制刷新，关闭页面后不会继续推送。价格规则只使用新鲜的 Binance USDT 报价，单条规则至少间隔 15 分钟并需重新越过阈值；同一期产品销毁仅提醒一次。</p><p><strong>设计参考。</strong>信息结构参考 <a href="https://www.defiburn.com/zh" target="_blank" rel="noopener noreferrer">DeFiBurn</a>，本项目独立实现 CAKE 数据接入。本站与 PancakeSwap 官方无隶属关系。</p></div></details></section>
      <footer><div className="footer-brand"><img src="/favicon.svg" alt="" /><strong>CAKE MONITOR</strong><span>让协议数据，更清楚一点。</span></div><div><LinkOut href="https://www.defiburn.com/zh">灵感来自 DeFiBurn</LinkOut><span>公开数据 · 仅作信息展示</span></div></footer>
    </main>
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast("")}><X size={14} /></button></div>}
    {alertsOpen && <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setAlertsOpen(false); }}><div className="alert-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="alert-title"><div className="modal-heading"><div><span className="eyebrow">YOUR SIGNALS</span><h2 id="alert-title">CAKE 监控提醒</h2></div><button ref={closeButton} className="icon-button" aria-label="关闭监控提醒" onClick={() => setAlertsOpen(false)}><X size={21} /></button></div><p className="modal-description">保存你的关注阈值，条件首次满足时在页面内提醒。</p><div className="alert-notice"><Info size={16} /><p>本页面打开且自动检查开启时工作。关闭页面后不会推送；规则仅保存在当前浏览器。</p></div>{!auto && <div className="alert-paused">自动检查已暂停。<button onClick={() => setAuto(true)}>恢复监控</button></div>}<form onSubmit={addRule} className="rule-form"><label>监控条件<select value={metric} onChange={(e) => setMetric(e.target.value as AlertRule["metric"])}><option value="price-above">CAKE/USDT 价格 ≥</option><option value="price-below">CAKE/USDT 价格 ≤</option><option value="burn-above">本期产品销毁 ≥</option></select></label><label>提醒阈值（{metric === "burn-above" ? "CAKE" : "USDT"}）<input type="number" step="any" min="0.00000001" required placeholder={metric === "burn-above" ? "例如 500000" : "例如 2.00"} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><button type="submit" className="primary-button"><Plus size={16} />添加</button></form>{alertError && <p className="form-error" role="alert">{alertError}</p>}<div className="rules-list">{rules.length ? rules.map((rule) => <div className="rule" key={rule.id}><button className={`switch ${rule.enabled ? "on" : ""}`} role="switch" aria-checked={rule.enabled} aria-label={`${rule.enabled ? "暂停" : "开启"} ${rule.metric} ${rule.threshold} 提醒`} onClick={() => setRules((old) => old.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}><span /></button><div><strong>{rule.metric === "burn-above" ? "本期产品销毁" : "CAKE/USDT 价格"} {rule.metric === "price-below" ? "≤" : "≥"} {precise(rule.threshold)}</strong><small>{rule.metric === "burn-above" ? "每个统计期提醒一次" : "跨过阈值时提醒 · 至少间隔 15 分钟"}</small></div><button className="icon-button" aria-label="删除提醒" onClick={() => { delete fired.current[rule.id]; setRules((old) => old.filter((r) => r.id !== rule.id)); }}><Trash2 size={15} /></button></div>) : <div className="no-rules"><Bell size={23} /><span>还没有提醒规则，添加一个关注的阈值。</span></div>}</div><div className="notification-row"><div><strong>桌面通知</strong><span>{permission === "granted" ? "已允许 · 满足规则时通知" : permission === "denied" ? "已被浏览器阻止，可在浏览器设置中调整" : "可选，页面内提醒始终可用"}</span></div><button className="text-button" disabled={permission === "granted" || permission === "denied"} onClick={async () => { if (!("Notification" in window)) { setAlertError("当前浏览器不支持桌面通知，仍可查看页面内提醒。"); return; } try { setPermission(await Notification.requestPermission()); } catch { setAlertError("未能开启桌面通知，仍可使用页面内提醒。"); } }}>{permission === "granted" ? <><Check size={14} />已开启</> : "开启通知"}</button></div><div className="event-heading"><h3>最近触发记录</h3>{events.length > 0 && <button onClick={() => setEvents([])}>清空记录</button>}</div><div className="events-list">{events.length ? events.map((event) => <div className="event" key={event.id}><i /><div><p>{event.message}</p><span>{dateTime(event.time)} · 北京时间</span></div></div>) : <p className="muted small">条件满足后，触发记录会显示在这里。</p>}</div></div></div>}
  </>;
}
