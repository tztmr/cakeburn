#!/usr/bin/env bash
# CakeBurn / CAKE Monitor Docker 一键部署与运维。
set -Eeuo pipefail

if [[ -t 1 ]]; then
  BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'
else
  BLUE=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${CAKEBURN_REPO_URL:-https://github.com/tztmr/cakeburn.git}"
BRANCH="${CAKEBURN_BRANCH:-main}"
STATE_DIR="${CAKEBURN_STATE_DIR:-${HOME}/.cakeburn}"
STATE_FILE="${STATE_DIR}/project-dir"
if (( EUID == 0 )); then DEFAULT_DIR=/opt/cakeburn; else DEFAULT_DIR="${HOME}/cakeburn"; fi
INSTALL_DIR="${CAKEBURN_INSTALL_DIR:-$DEFAULT_DIR}"
DIR_OVERRIDE="${CAKEBURN_INSTALL_DIR:-}"
PORT_OVERRIDE="${CAKEBURN_PORT:-}"
BIND_OVERRIDE="${CAKEBURN_BIND:-}"
DOMAIN_OVERRIDE=''
PROJECT_ROOT=''; ENV_FILE=''; WEB_PORT=4519; BIND_ADDRESS=0.0.0.0; DOMAIN=''; PUBLIC_URL=''
ACTION=''; DRY_RUN=0; ASSUME_YES=0
DOCKER=(docker); COMPOSE=(docker compose); TEMP_FILES=()
# Compose should read the validated .env, without inherited values masking it.
unset CAKEBURN_PORT CAKEBURN_BIND CAKEBURN_DOMAIN SITE_URL COMPOSE_PROFILES

info() { printf '%s[INFO]%s %s\n' "$BLUE" "$RESET" "$*"; }
ok() { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
interactive() { [[ -t 0 && -t 1 ]]; }
cleanup() { local file; for file in "${TEMP_FILES[@]:-}"; do [[ -z "$file" ]] || rm -f -- "$file"; done; }
trap cleanup EXIT
trap 'warn "操作失败（第 ${LINENO} 行）。可运行 bash cakeburn.sh status 或 logs 查看服务。"' ERR

usage() {
  cat <<'EOF'
用法：bash cakeburn.sh [命令] [选项]

命令：
  deploy       安装依赖、准备源码、构建并启动（保留现有配置）
  status       查看容器状态
  logs         查看最近 150 行并持续跟踪日志（Ctrl+C 退出）
  restart      重启服务并检查健康状态
  stop         停止服务
  start        启动已有容器并检查健康状态
  update       git pull --ff-only 后重新构建
  enable-ssl   绑定域名，使用 Caddy 自动申请和续期 HTTPS 证书
  uninstall    删除容器和网络，保留源码、配置及证书数据卷
  menu         中文交互菜单

选项：
  --port 4519             HTTP 映射端口，仅用于 deploy / update
  --install-dir /opt/cakeburn  指定源码目录
  --domain cake.example.com   用于 enable-ssl
  --dry-run               只展示操作，不安装、不写文件、不启停服务
  --yes                   跳过部署询问；允许非交互卸载
  -h, --help              显示帮助

无命令时：交互终端进入菜单，非交互环境执行 deploy。
环境变量：CAKEBURN_INSTALL_DIR、CAKEBURN_PORT、CAKEBURN_BIND、
          CAKEBURN_REPO_URL、CAKEBURN_BRANCH、CAKEBURN_STATE_DIR。
EOF
}

while (( $# )); do
  case "$1" in
    deploy|status|logs|restart|stop|start|update|enable-ssl|uninstall|menu)
      [[ -z "$ACTION" ]] || die '一次只能指定一个命令'; ACTION="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --port|--install-dir|--domain)
      (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || die "$1 缺少参数"
      case "$1" in
        --port) PORT_OVERRIDE="$2" ;;
        --install-dir) INSTALL_DIR="$2"; DIR_OVERRIDE="$2" ;;
        --domain) DOMAIN_OVERRIDE="$2" ;;
      esac
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

run() {
  if (( DRY_RUN )); then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

as_root() {
  if (( EUID == 0 )); then run "$@"
  elif has sudo; then run sudo "$@"
  else die '自动安装依赖需要 root 或 sudo 权限'; fi
}

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
valid_domain() {
  local label; local -a labels
  [[ ${#1} -le 253 && "$1" == *.* && "$1" != *..* && "$1" != *[!a-zA-Z0-9.-]* ]] || return 1
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] || return 1
  done
  [[ "$1" != *. && ! "$1" =~ ^[0-9.]+$ ]]
}

[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / && "$INSTALL_DIR" != *$'\n'* ]] || die '安装目录必须为非根目录的绝对路径'
[[ -z "$PORT_OVERRIDE" ]] || valid_port "$PORT_OVERRIDE" || die '端口必须在 1–65535 之间'
[[ -z "$DOMAIN_OVERRIDE" ]] || valid_domain "$DOMAIN_OVERRIDE" || die '域名格式错误，请填写完整域名，不带 http(s):// 或路径'

project_exists() { [[ -f "$1/package.json" && -f "$1/Dockerfile" && -f "$1/docker-compose.yml" && -f "$1/cakeburn.sh" ]]; }

locate_project() {
  local saved=''
  if [[ -n "$DIR_OVERRIDE" ]]; then PROJECT_ROOT="$INSTALL_DIR"
  elif project_exists "$SCRIPT_DIR"; then PROJECT_ROOT="$SCRIPT_DIR"
  elif project_exists "$PWD"; then PROJECT_ROOT="$PWD"
  elif [[ -f "$STATE_FILE" ]] && IFS= read -r saved < "$STATE_FILE" && project_exists "$saved"; then PROJECT_ROOT="$saved"
  else PROJECT_ROOT="$INSTALL_DIR"; fi
  ENV_FILE="$PROJECT_ROOT/.env"
}

install_packages() {
  if has apt-get; then
    as_root apt-get update
    as_root apt-get install -y "$@"
  elif has dnf; then as_root dnf install -y "$@"
  elif has yum; then as_root yum install -y "$@"
  else die "请先手动安装依赖：$*"; fi
}

prepare_source() {
  has git || install_packages git
  if project_exists "$PROJECT_ROOT"; then return 0; fi
  if [[ -e "$PROJECT_ROOT" ]]; then
    [[ -d "$PROJECT_ROOT" && -z "$(ls -A "$PROJECT_ROOT")" ]] || die "目录已存在且不是 CakeBurn 项目：${PROJECT_ROOT}；请另选 --install-dir"
  fi
  run mkdir -p -- "$(dirname -- "$PROJECT_ROOT")"
  run git clone --branch "$BRANCH" --single-branch -- "$REPO_URL" "$PROJECT_ROOT"
  (( DRY_RUN )) || project_exists "$PROJECT_ROOT" || die '仓库缺少部署文件，请检查仓库地址和分支'
}

prepare_docker() {
  local installer allow_install="${1:-0}"
  if ! has docker; then
    (( allow_install || DRY_RUN )) || die '未检测到 Docker，请先运行 deploy 安装'
    has curl || install_packages curl ca-certificates
    if (( DRY_RUN )); then
      info '[dry-run] 从 https://get.docker.com 下载安装 Docker Engine 及 Compose 插件'
    else
      installer="$(mktemp)"; TEMP_FILES+=("$installer")
      curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 https://get.docker.com -o "$installer"
      as_root sh "$installer"
    fi
  fi
  if (( DRY_RUN )); then COMPOSE=(docker compose); return 0; fi
  if ! docker info >/dev/null 2>&1; then
    if (( allow_install )) && has systemctl; then as_root systemctl enable --now docker; fi
    if ! docker info >/dev/null 2>&1; then
      if (( EUID != 0 )) && has sudo && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
      else die 'Docker 未启动或当前用户无权限，请启动 Docker 后重试'; fi
    fi
  fi
  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    (( allow_install )) || die '未检测到 Docker Compose 插件，请先运行 deploy 安装'
    install_packages docker-compose-plugin
  fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die '需要 Docker Compose 插件（docker compose）'
  COMPOSE=("${DOCKER[@]}" compose)
}

read_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  # Read only known, validated values. Never source or evaluate a .env file.
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

set_env() {
  local key="$1" value="$2" temporary
  if (( DRY_RUN )); then info "[dry-run] 写入 ${ENV_FILE}：$key=$value"; return 0; fi
  temporary="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"; TEMP_FILES+=("$temporary")
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { if (!found++) print key "=" value; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$ENV_FILE"
}

load_config() {
  WEB_PORT="$(read_env CAKEBURN_PORT)"; WEB_PORT="${WEB_PORT:-4519}"
  BIND_ADDRESS="$(read_env CAKEBURN_BIND)"; BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
  DOMAIN="$(read_env CAKEBURN_DOMAIN)"; PUBLIC_URL="$(read_env SITE_URL)"
  valid_port "$WEB_PORT" || die "配置文件中的 CAKEBURN_PORT 无效：$WEB_PORT"
  WEB_PORT="$((10#$WEB_PORT))"
  [[ "$BIND_ADDRESS" == 0.0.0.0 || "$BIND_ADDRESS" == 127.0.0.1 ]] || die 'CAKEBURN_BIND 仅支持 0.0.0.0 或 127.0.0.1'
  [[ -z "$DOMAIN" ]] || valid_domain "$DOMAIN" || die '配置文件中的 CAKEBURN_DOMAIN 无效'
  [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]{1,5})?/?$ ]] || die 'SITE_URL 必须是 http(s)://域名[:端口]，不能带路径'
}

prepare_config() {
  local answer
  if [[ ! -f "$ENV_FILE" ]]; then
    run cp -- "$PROJECT_ROOT/.env.example" "$ENV_FILE"
    run chmod 600 "$ENV_FILE"
    if [[ -z "$PORT_OVERRIDE" ]] && interactive && (( ! ASSUME_YES )); then
      printf '网站端口 [4519]: ' >&2
      IFS= read -r answer || answer=''
      PORT_OVERRIDE="${answer:-4519}"
    fi
  fi
  load_config
  if [[ -n "$PORT_OVERRIDE" ]]; then
    valid_port "$PORT_OVERRIDE" || die '端口必须在 1–65535 之间'
    WEB_PORT="$((10#$PORT_OVERRIDE))"; set_env CAKEBURN_PORT "$WEB_PORT"
  fi
  if [[ -n "$BIND_OVERRIDE" ]]; then
    [[ "$BIND_OVERRIDE" == 0.0.0.0 || "$BIND_OVERRIDE" == 127.0.0.1 ]] || die 'CAKEBURN_BIND 仅支持 0.0.0.0 或 127.0.0.1'
    BIND_ADDRESS="$BIND_OVERRIDE"; set_env CAKEBURN_BIND "$BIND_ADDRESS"
  fi
}

compose() {
  local -a args=(--project-name cakeburn --project-directory "$PROJECT_ROOT" --env-file "$ENV_FILE" -f "$PROJECT_ROOT/docker-compose.yml")
  [[ -z "$DOMAIN" ]] || args+=(--profile https)
  run "${COMPOSE[@]}" "${args[@]}" "$@"
}

require_project() {
  locate_project
  project_exists "$PROJECT_ROOT" || die '未找到部署，请先运行 deploy，或用 --install-dir 指定目录'
  [[ -f "$ENV_FILE" ]] || die '未找到 .env，请先运行 deploy'
  load_config
  prepare_docker
}

save_state() {
  if (( DRY_RUN )); then info "[dry-run] 保存部署目录至 $STATE_FILE"; return 0; fi
  mkdir -p -- "$STATE_DIR"; chmod 700 "$STATE_DIR"
  printf '%s\n' "$PROJECT_ROOT" > "$STATE_FILE"; chmod 600 "$STATE_FILE"
}

wait_healthy() {
  local id state attempt
  if (( DRY_RUN )); then info '[dry-run] 等待 /api/health 健康检查通过'; return 0; fi
  id="$(compose ps -a -q cakeburn)"
  [[ -n "$id" ]] || die '未找到应用容器'
  info '等待应用健康检查…'
  for (( attempt=0; attempt<60; attempt++ )); do
    state="$("${DOCKER[@]}" inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")"
    case "$state" in
      running/healthy) ok '应用健康检查通过'; return 0 ;;
      exited/*|dead/*|running/unhealthy) break ;;
    esac
    sleep 2
  done
  compose logs --tail 80 cakeburn
  die '应用未通过健康检查，请根据日志修复后重试'
}

allow_port() {
  if (( DRY_RUN )); then info "[dry-run] 如启用系统防火墙，放行 TCP $1"; return 0; fi
  if has ufw && as_root ufw status | grep -q 'Status: active'; then
    as_root ufw allow "$1/tcp" || warn "请手动放行 TCP $1"
  fi
  if has firewall-cmd && as_root firewall-cmd --state >/dev/null 2>&1; then
    if as_root firewall-cmd --permanent --add-port="$1/tcp"; then
      as_root firewall-cmd --reload || warn "请手动放行 TCP $1"
    else warn "请手动放行 TCP $1"; fi
  fi
}

show_access() {
  if (( DRY_RUN )); then ok '部署预演完成，未修改系统'; return 0; fi
  ok "服务已启动；源码与配置：$PROJECT_ROOT"
  if [[ -n "$DOMAIN" ]]; then
    info "访问地址：https://${DOMAIN}（证书状态见 Caddy 日志）"
  elif [[ "$BIND_ADDRESS" == 127.0.0.1 ]]; then
    info "本机访问：http://127.0.0.1:${WEB_PORT}；可接入现有反向代理"
  else
    info "访问地址：http://你的服务器IP:$WEB_PORT"
    info "请在云服务器安全组中放行 TCP $WEB_PORT"
  fi
}

build_and_start() {
  compose config --quiet
  # Build first; a failed build leaves the current service running.
  compose build --pull cakeburn
  save_state
  compose up -d
  wait_healthy
  if [[ -n "$DOMAIN" ]]; then allow_port 80; allow_port 443
  elif [[ "$BIND_ADDRESS" == 0.0.0.0 ]]; then allow_port "$WEB_PORT"; fi
  show_access
}

deploy() {
  (( DRY_RUN )) || [[ "$(uname -s)" == Linux ]] || die '自动部署面向 Linux 服务器；本机可使用 --dry-run 预演'
  locate_project; prepare_source; prepare_config; prepare_docker 1; build_and_start
}

update_app() {
  require_project
  [[ -d "$PROJECT_ROOT/.git" || -f "$PROJECT_ROOT/.git" ]] || die '此目录没有 Git 记录，请用 Git 克隆方式安装'
  [[ -z "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=no)" ]] || die '源码存在本地修改，请先保存或提交，再运行 update；不会覆盖本地修改'
  run git -C "$PROJECT_ROOT" pull --ff-only
  prepare_config; build_and_start
}

enable_ssl() {
  require_project
  local selected="$DOMAIN_OVERRIDE" reply=''
  if [[ -z "$selected" ]] && interactive; then
    printf '绑定域名（请先将 DNS 指向本服务器）[%s]: ' "$DOMAIN" >&2
    IFS= read -r reply || reply=''; selected="${reply:-$DOMAIN}"
  fi
  [[ -n "$selected" ]] || selected="$DOMAIN"
  valid_domain "$selected" || die '请用 --domain 指定完整域名，并将 DNS A/AAAA 记录指向本服务器'
  [[ "$WEB_PORT" != 80 && "$WEB_PORT" != 443 ]] || die 'HTTPS 需要使用 80/443；请先用 deploy --port 4519 更换应用端口'
  DOMAIN="$(printf '%s' "$selected" | tr '[:upper:]' '[:lower:]')"
  PUBLIC_URL="https://$DOMAIN"; BIND_ADDRESS=127.0.0.1
  set_env CAKEBURN_DOMAIN "$DOMAIN"; set_env SITE_URL "$PUBLIC_URL"; set_env CAKEBURN_BIND "$BIND_ADDRESS"
  build_and_start
  if (( DRY_RUN )); then info "[dry-run] 检查 $PUBLIC_URL/api/health"; return 0; fi
  if has curl && curl -fsS --connect-timeout 5 --max-time 20 "$PUBLIC_URL/api/health" | grep -q '"service":"cakeburn"'; then
    ok "HTTPS 验证通过：$PUBLIC_URL"
  else
    warn '域名代理已启动，HTTPS 尚未验证通过。首次申请证书需要时间；请确认 DNS 和安全组 TCP 80/443，再运行 logs 查看 Caddy 日志。'
  fi
}

uninstall_app() {
  require_project
  local answer=''
  warn '将删除 CakeBurn 容器及网络，保留源码、.env 与证书数据卷'
  if (( ! ASSUME_YES && ! DRY_RUN )); then
    interactive || die '非交互卸载需要显式添加 --yes'
    printf '确认卸载？[y/N]: ' >&2; IFS= read -r answer || answer=''
    [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]] || return 0
  fi
  compose down
  if [[ -f "$STATE_FILE" ]] && [[ "$(cat "$STATE_FILE")" == "$PROJECT_ROOT" ]]; then run rm -f -- "$STATE_FILE"; fi
  if (( DRY_RUN )); then ok '卸载预演完成，未修改系统'
  else ok '容器已移除，保留的配置可用于重新部署'; fi
}

menu() {
  local choice
  while true; do
    printf '\n========= CakeBurn / CAKE Monitor =========\n'
    printf '1) 一键部署\n2) 查看状态\n3) 查看日志\n4) 重启服务\n5) 更新应用\n6) 启用 HTTPS\n7) 停止服务\n8) 启动服务\n9) 卸载（保留数据）\n0) 退出\n'
    printf '请选择 [0-9]: ' >&2
    IFS= read -r choice || return 0
    case "$choice" in
      1) deploy ;;
      2) require_project; compose ps -a ;;
      3) require_project; compose logs -f --tail 150 ;;
      4) require_project; compose restart; wait_healthy ;;
      5) update_app ;;
      6) enable_ssl ;;
      7) require_project; compose stop ;;
      8) require_project; compose up -d; wait_healthy ;;
      9) uninstall_app ;;
      0) return 0 ;;
      *) warn '请输入 0–9' ;;
    esac
  done
}

if [[ -z "$ACTION" ]]; then
  if interactive; then ACTION=menu; else ACTION=deploy; fi
fi
[[ -z "$DOMAIN_OVERRIDE" || "$ACTION" == enable-ssl ]] || die '--domain 仅用于 enable-ssl'
[[ -z "$PORT_OVERRIDE" || "$ACTION" == deploy || "$ACTION" == update || "$ACTION" == menu ]] || die '--port 仅用于 deploy / update'
case "$ACTION" in
  deploy) deploy ;;
  update) update_app ;;
  enable-ssl) enable_ssl ;;
  uninstall) uninstall_app ;;
  status) require_project; compose ps -a ;;
  logs) require_project; compose logs -f --tail 150 ;;
  restart) require_project; compose restart; wait_healthy ;;
  stop) require_project; compose stop ;;
  start) require_project; compose up -d; wait_healthy ;;
  menu) menu ;;
esac
