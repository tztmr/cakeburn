# CAKE Monitor

参考 [DeFiBurn](https://www.defiburn.com/zh) 的信息结构，为 PancakeSwap / CAKE 独立实现的中文数据监控站。

## Linux 服务器一键部署

服务器部署入口为 `cakeburn.sh`，参考 CloudMail 的中文部署/运维菜单，配套 Dockerfile、Compose 和可选 Caddy 自动 HTTPS。默认从本仓库 `main` 分支拉取完整源码，不需要 ChatGPT / Cloudflare 账号、数据库或 API 密钥。服务器版为公开的只读监控站。

适用于可访问 GitHub、npm 和 Docker 镜像仓库的 Debian / Ubuntu / Rocky Linux 等常见 Linux 服务器，支持 x86_64、ARM64。建议至少 2 GB 内存，并为首次依赖安装、构建及镜像预留约 5 GB 磁盘；小内存服务器可能需要增加 swap。脚本在缺少依赖时自动安装 Git、Docker Engine 和 Compose 插件。

以 root 身份执行；普通用户也可以使用 sudo：

```sh
curl -fL --retry 3 https://raw.githubusercontent.com/tztmr/cakeburn/main/cakeburn.sh -o cakeburn.sh
sudo bash cakeburn.sh deploy
```

默认目录 `/opt/cakeburn`，默认访问地址 `http://服务器IP:4519`。首次交互部署可设置端口，也可以通过 `--port 8080` 指定。需要在云服务器安全组放行对应 TCP 端口；脚本会尝试放行已启用的 UFW / firewalld。没有 sudo 时，使用 root 运行；未安装 curl 的系统需要先通过系统包管理器安装 curl。

已有部署会保留 `.env` 中的端口设置。更新并切换为 4519：

```sh
sudo bash /opt/cakeburn/cakeburn.sh update --port 4519
```

以后直接打开菜单：

```sh
sudo bash /opt/cakeburn/cakeburn.sh
```

也可直接执行命令：

```sh
sudo bash /opt/cakeburn/cakeburn.sh status
sudo bash /opt/cakeburn/cakeburn.sh logs
sudo bash /opt/cakeburn/cakeburn.sh restart
sudo bash /opt/cakeburn/cakeburn.sh stop
sudo bash /opt/cakeburn/cakeburn.sh start
sudo bash /opt/cakeburn/cakeburn.sh update
```

更新使用 `git pull --ff-only`，发现源码有本地修改时停止，不覆盖修改；先构建再替换容器，构建失败时保留原有运行服务。`.env` 不进入 Git、不进入镜像，也不会在更新时被重置。不同的安装/管理命令请使用相同用户（以上示例均为 sudo）。

### 域名与 HTTPS

先把域名的 DNS A 记录指向服务器 IPv4；只有服务器可提供 IPv6 服务时才设置 AAAA 记录。确保宿主机的 80/443 端口未被其他程序占用，并在安全组放行 TCP 80/443，然后执行：

```sh
sudo bash /opt/cakeburn/cakeburn.sh enable-ssl --domain cake.example.com
```

将示例替换为自己的域名。脚本会启动 Caddy，自动申请、续期证书，并将应用的 HTTP 端口（默认 4519）绑定到 `127.0.0.1`。申请结果可通过 `logs` 查看；脚本会尝试验证 HTTPS，尚未签发时会明确提示。UDP 443 可选，用于 HTTP/3。已有 Nginx、宝塔或其他反向代理时，可以直接将其指向 `127.0.0.1:4519`，不启用脚本内置 HTTPS：

```sh
sudo CAKEBURN_BIND=127.0.0.1 bash /opt/cakeburn/cakeburn.sh deploy
```

已有反向代理时，可在 `.env` 设置 `SITE_URL=https://自己的域名`，再运行 `deploy` 更新页面规范地址；`SITE_URL` 在构建时生效。未配置时服务器版不输出指向预览平台的规范地址。

### 其他部署方式

```sh
# 预演：不安装依赖、不写配置、不启停容器
bash cakeburn.sh --dry-run deploy --port 8080

# 自定义安装位置与端口
sudo bash cakeburn.sh deploy --install-dir /opt/cakeburn --port 8080 --yes

# 卸载保留源码、配置、Caddy 证书数据卷，不执行 down -v
sudo bash /opt/cakeburn/cakeburn.sh uninstall
# 无人值守卸载必须明确追加 --yes
```

也可自行克隆本仓库，在仓库目录执行 `cp .env.example .env`、修改配置，然后执行 `docker compose --project-name cakeburn up -d --build`。手动使用 HTTPS 需设置 `.env` 中的域名、`SITE_URL` 和回环绑定，并追加 `--profile https`。容器提供 `/api/health` 健康检查；开机自动恢复依赖 Docker 服务启动和容器的 `unless-stopped` 策略。停止过的容器需要手动 `start`。

本地验证服务器构建，不需要 Docker：

```sh
npm ci
npm run build:server
HOSTNAME=0.0.0.0 PORT=4519 npm run start:server
```

服务器构建使用 Next.js standalone，原有 `npm run dev` / `build` / `start` 保留预览平台的 Vinext / Workers 流程。服务器版同样使用公开上游接口；上游接口不可用时仍明确标记过期快照，不会因部署方式变化而将历史数据当作实时数据。

## 已实现

- 总览：代币行情、流通市值、供应量、协议 TVL、协议交易额与手续费。
- 销毁：官方产品销毁堆叠图、周报净铸造、总供应变化、产品贡献、交易搜索、分页、CSV 导出。
- 协议：交易额、TVL、手续费、收入趋势；TVL 分链、交易额分版本。
- 供应与行情：官方总供应历史、CAKE/USDT 完整日线、同一已确认区块的 CAKE 合约余额核对。
- 治理提案：Snapshot 空间 `cakevote.eth` 的提案标题、投票窗口、CAKE 权重结果、状态筛选、分页与空间参数；标题保留原文。veCAKE Gauge 投票不在本页范围。
- 监控提醒：价格上下限、产品销毁阈值、本地持久化、触发历史、可选桌面通知。
- 响应式页面、源状态、各源更新时间、缺失值处理、完整请求超时、服务端缓存与历史快照回退。

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
| CAKE/USDT 报价与已收盘日线 | Binance 官方公共接口 data-api.binance.vision / api.binance.com |
| TVL、协议交易额、费用、收入 | DefiLlama PancakeSwap 父协议聚合接口 |
| 治理提案、选项、票数与空间参数 | Snapshot GraphQL，空间固定为 `cakevote.eth` |
| 累计铸造、销毁地址余额 | BNB Chain 公共 RPC，校验 chainId=56，同区块读取，保留 15 个区块确认距离 |

服务端行情缓存 1 分钟、销毁与治理缓存 15 分钟、链上缓存 5 分钟、协议和日线缓存 30 分钟；部分失败的数据 1 分钟后重试。服务端行情、协议、日线或治理连接受限时，浏览器会独立补取对应公开接口，包括服务端返回空数据的情况。USD 与 USDT 始终保留独立字段，币安报价展示自身的时间；过期报价不能触发提醒。

协议交易额使用不带历史版本分解的轻量接口，版本构成按子协议的轻量 24H 接口独立读取；已退役的适配器不当作零交易额。TVL 总量、历史与链分布分别读取，保留上次成功的图表和字段。网络超时覆盖响应头和 JSON 正文，Worker 请求之间只复用已完成结果，避免取消请求留下永久等待的共享任务。

周报相关指标会随官方销毁接口更新，按官方返回的统计日期选择最新一期，不需要每周更新代码或重新部署。页面打开、可见且自动检查开启时每 60 秒检查，服务端销毁数据缓存 15 分钟；官方发布新一期后，缓存到期后的有效刷新会显示新数据。官方未发布时保留最后一期，接口失败时标明历史快照及日期。关闭页面后停止浏览器轮询，下次打开再请求数据；当前没有无人访问时的定时采集、周报文件归档或自动发送任务。

`data/burn-snapshot.json` 是带采集时间的官方数据存档，不是生成的示例数据。仅在官方接口失败时使用，并明确标记历史快照；快照不触发提醒。其采集时间和上游时间均在页面展示。

`data/service-snapshot.json` 保存 2026-11-03 实际读取的 CoinGecko、Binance 和 DefiLlama 规范化结果及来源地址，供冷启动时接口不可用的情况回退。读取成功后由新数据替换；保留的链分布、版本构成和报价分别展示时间及缓存提示，不把存档重新标成实时行情。

产品销毁、链上毛销毁、周报净铸造与总供应变化是独立口径。周报净铸造为净新增排放减产品销毁，不含 CAKE Burn 循环；总供应变化使用官方 deflationTimeSeries。不能把毛销毁全部当作买回销毁。官方总供应量不与市场流通量或合约余额差额混用。日线排除未收盘 UTC 日期。缺失项留空，不补为零。

## 提醒的运行范围

提醒规则和事件仅保存到当前浏览器。页面打开、可见、自动检查开启时每 60 秒检查一次；关闭页面后不会推送。浏览器可能限制后台计时，不能作为无人值守的后台提醒服务。

价格提醒只判断新鲜的 Binance USDT 报价，重新跨过阈值后至少间隔 15 分钟。产品销毁按官方统计期去重，过期或快照数据不触发提醒。未配置邮件、Telegram、交易权限、私钥或任何交易操作。

## 项目结构

- `app/page.tsx`：五个页面视图、轮询、提醒、交易导出。
- `components/monitor-charts.tsx`：图表、周期切换和图例。
- `lib/data.ts`：固定上游连接、缓存、部分失败与快照回退。
- `lib/governance.ts`：Snapshot 治理查询、空间/提案校验与规范化。
- `lib/providers.ts` / `lib/client-data.ts`：共享数据校验、独立补取和最近成功值保留。
- `lib/http.ts`：覆盖完整响应的截止时间与取消处理。
- `lib/metrics.ts`：数值、口径规范化、精确余额相减及提醒条件。
- `app/api/monitor/route.ts`：只读数据接口；只接受固定 section。
- `tests/metrics.test.mjs`：真实官方数据对账及关键边界检查。
- `tests/governance.test.mjs`：治理存档完整性、空间校验、去重排序与状态合并检查。
- `tests/data-loading.test.mjs`：接口超时、空响应补取、部分失败保留与报价新鲜度回归检查。

原预览平台站点默认仅所有者可访问，发布身份保存在 `.openai/hosting.json`；自行部署的服务器版对可访问其端口的用户公开。

## 品牌素材

站点图标及导航 Logo 使用 PancakeSwap 官网的 `logo.png` / `favicon.ico`，首页 CAKE 兔子形象使用 CoinGecko 的 CAKE 代币图标。素材原样保存于 `public/`，未重绘或修改标识。页面为独立的数据监控看板。

- https://pancakeswap.finance/logo.png
- https://pancakeswap.finance/favicon.ico
- https://coin-images.coingecko.com/coins/images/12632/large/pancakeswap-cake-logo_%281%29.png?1696512440
