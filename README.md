# CAKE Monitor

参考 [DeFiBurn](https://www.defiburn.com/zh) 的信息结构，为 PancakeSwap / CAKE 独立实现的中文数据监控站。

## 已实现

- 总览：代币行情、流通市值、供应量、协议 TVL、协议交易额与手续费。
- 销毁：官方产品销毁堆叠图、净供应变化、产品贡献、交易搜索、分页、CSV 导出。
- 协议：交易额、TVL、手续费、收入趋势；TVL 分链、交易额分版本。
- 供应与行情：官方总供应历史、CAKE/USDT 完整日线、同一已确认区块的 CAKE 合约余额核对。
- 监控提醒：价格上下限、产品销毁阈值、本地持久化、触发历史、可选桌面通知。
- 响应式页面、源状态、各源更新时间、缺失值处理、超时、并发去重、服务端缓存与历史快照回退。

## 本地运行

需要 Node.js 22.18 或以上版本。

```sh
npm install
npm run dev -- --host 127.0.0.1 --port 4173
```

打开 http://127.0.0.1:4173/ 。

```sh
npm test
npm run typecheck
npm run build
```

## 数据来源与口径

| 数据 | 来源 |
| --- | --- |
| 产品销毁、毛销毁、净变化、总供应历史、交易记录 | PancakeSwap 官方仪表板使用的 https://burn-stats.pancakeswap.com/data.json |
| 代币美元行情、市值、流通量、报告供应上限 | CoinGecko markets，代币 ID 为 pancakeswap-token |
| CAKE/USDT 报价与已收盘日线 | Binance 公共市场数据接口 data-api.binance.vision |
| TVL、协议交易额、费用、收入 | DefiLlama PancakeSwap 父协议聚合接口 |
| 累计铸造、销毁地址余额 | BNB Chain 公共 RPC，校验 chainId=56，同区块读取，保留 15 个区块确认距离 |

服务端行情缓存 1 分钟、销毁缓存 15 分钟、链上缓存 5 分钟、协议和日线缓存 30 分钟；部分失败的数据 1 分钟后重试。服务端 CoinGecko 连接受限时，浏览器会尝试同一公开接口，保留 USD 与 USDT 的独立字段。

`data/burn-snapshot.json` 是带采集时间的官方数据存档，不是生成的示例数据。仅在官方接口失败时使用，并明确标记历史快照；快照不触发提醒。其采集时间和上游时间均在页面展示。

产品销毁、链上毛销毁、净供应变化是独立口径。净变化为铸造减销毁，负数表示通缩；不能把毛销毁全部当作买回销毁。官方总供应量不与市场流通量或合约余额差额混用。日线排除未收盘 UTC 日期。缺失项留空，不补为零。

## 提醒的运行范围

提醒规则和事件仅保存到当前浏览器。页面打开、可见、自动检查开启时每 60 秒检查一次；关闭页面后不会推送。浏览器可能限制后台计时，不能作为无人值守的后台提醒服务。

价格提醒只判断新鲜的 Binance USDT 报价，重新跨过阈值后至少间隔 15 分钟。产品销毁按官方统计期去重，过期或快照数据不触发提醒。未配置邮件、Telegram、交易权限、私钥或任何交易操作。

## 项目结构

- `app/page.tsx`：四个页面视图、轮询、提醒、交易导出。
- `components/monitor-charts.tsx`：图表、周期切换和图例。
- `lib/data.ts`：固定上游连接、缓存、部分失败与快照回退。
- `lib/metrics.ts`：数值、口径规范化、精确余额相减及提醒条件。
- `app/api/monitor/route.ts`：只读数据接口；只接受固定 section。
- `tests/metrics.test.mjs`：真实官方数据对账及关键边界检查。

站点默认仅所有者可访问，发布身份保存在 `.openai/hosting.json`。
