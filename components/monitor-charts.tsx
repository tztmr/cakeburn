"use client";
import { useState } from "react";
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, LineChart, Line, AreaChart, Area, Cell, ReferenceLine } from "recharts";
import type { BurnPeriod, Point } from "@/lib/monitor-types";

export const COLORS = ["#28bdc9", "#9380e9", "#f0b860", "#71a4ed", "#e991b5", "#97ba97", "#91aabd", "#c8af8e"];
export function productColor(name: string) {
  const known: Record<string, string> = { "AMM (v3)": COLORS[0], "AMM (v2)": COLORS[1], "AMM (Inf)": COLORS[2], Lottery: COLORS[3], Perpetuals: COLORS[4] };
  return known[name] ?? COLORS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % COLORS.length];
}
export function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  const unit = a >= 1e9 ? 1e9 : a >= 1e6 ? 1e6 : a >= 1e3 ? 1e3 : 1;
  return (n / unit).toLocaleString("en-US", { maximumFractionDigits: digits }) + (unit === 1e9 ? "B" : unit === 1e6 ? "M" : unit === 1e3 ? "K" : "");
}
export function day(value: number): string { return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "UTC" }); }
function fullDay(value: unknown) { return new Date(Number(value)).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }); }
const tooltipStyle = { border: "1px solid #e1e9f5", borderRadius: 10, fontSize: 12, color: "#526d8c", boxShadow: "0 5px 22px #29497515" };
const axes = { tickLine: false, axisLine: false, tick: { fontSize: 11, fill: "#9baac0" } };
export function EmptyChart({ message = "正在连接数据源…" }: { message?: string }) { return <div className="empty-chart"><span className="chart-placeholder">↗</span><p>{message}</p></div>; }

export function BurnChart({ periods, mode }: { periods: BurnPeriod[]; mode: "products" | "net" }) {
  const [hidden, setHidden] = useState<string[]>([]);
  if (!periods.length) return <EmptyChart message="这个时间范围暂无可用记录" />;
  const names = [...new Set(periods.flatMap((p) => p.products.map((v) => v.name)))];
  const data = periods.map((p) => Object.assign({ date: p.date, net: p.netMint }, ...names.map((name, i) => ({ [`p${i}`]: p.products.find((v) => v.name === name)?.amount }))));
  return <>
    <div className="chart-box" role="img" aria-label={mode === "products" ? "各产品每周 CAKE 销毁量，悬停查看金额" : "每周总供应变化，负数表示通缩"}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 237 }}><BarChart data={data} margin={{ top: 12, right: 6, left: -12, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke="#edf2f9" strokeDasharray="3 4" />
        <XAxis dataKey="date" tickFormatter={day} {...axes} minTickGap={28} />
        <YAxis tickFormatter={(n) => compact(n, 1)} {...axes} width={68} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f1f7fb" }} labelFormatter={fullDay} formatter={(value, name) => [value === undefined ? "缺失" : `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} CAKE`, name]} />
        {mode === "products" ? names.map((name, i) => <Bar key={name} dataKey={`p${i}`} name={name} stackId="burn" fill={productColor(name)} hide={hidden.includes(name)} maxBarSize={38} />) : <Bar dataKey="net" name="总供应变化（负数为通缩）" maxBarSize={38}>{periods.map((p) => <Cell key={p.date} fill={p.netMint < 0 ? "#41b397" : "#f0b860"} />)}</Bar>}
        {mode === "net" && <ReferenceLine y={0} stroke="#d8e2f0" />}
      </BarChart></ResponsiveContainer>
    </div>
    {mode === "products" && <div className="chart-legend">{names.map((name) => <button key={name} className={hidden.includes(name) ? "muted" : ""} onClick={() => setHidden((old) => old.includes(name) ? old.filter((n) => n !== name) : [...old, name])}><i style={{ background: productColor(name) }} />{name}</button>)}</div>}
    {mode === "net" && <div className="chart-legend"><span><i style={{ background: "#41b397" }} />总供应减少</span><span><i style={{ background: "#f0b860" }} />总供应增加</span></div>}
  </>;
}
export function TrendChart({ points, color = "#27b7c4", unit = "USD", label, zero = true }: { points: Point[]; color?: string; unit?: string; label: string; zero?: boolean }) {
  if (!points.length) return <EmptyChart message="暂无可用的趋势数据" />;
  const id = `fill-${label.replace(/[^a-z]/gi, "") || "trend"}`;
  return <div className="chart-box" role="img" aria-label={`${label}历史趋势，单位${unit}`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 237 }}><AreaChart data={points} margin={{ top: 15, right: 8, left: -8, bottom: 0 }}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.16} /><stop offset="100%" stopColor={color} stopOpacity={0.01} /></linearGradient></defs>
      <CartesianGrid vertical={false} stroke="#edf2f9" strokeDasharray="3 4" />
      <XAxis dataKey="date" tickFormatter={day} {...axes} minTickGap={38} />
      <YAxis {...axes} tickFormatter={(n) => compact(n, unit === "USDT" ? 3 : 1)} width={68} domain={zero ? [0, "auto"] : ["auto", "auto"]} />
      <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: color, strokeDasharray: "4 3" }} labelFormatter={fullDay} formatter={(v) => [`${Number(v).toLocaleString("en-US", { maximumFractionDigits: unit === "USDT" ? 4 : 2 })} ${unit}`, label]} />
      <Area type="linear" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={false} connectNulls={false} />
    </AreaChart></ResponsiveContainer>
  </div>;
}
export function Sparkline({ points }: { points: Point[] }) {
  if (points.length < 2) return null;
  return <div className="sparkline" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 237 }}><LineChart data={points.slice(-30)}><YAxis hide domain={["dataMin", "dataMax"]} /><Line dataKey="value" stroke="#45b8c3" strokeWidth={1.8} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>;
}
