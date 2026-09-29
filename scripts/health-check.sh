#!/usr/bin/env bash
# health-check.sh —— 逐项体检「Codex → WorkBuddy」派活链路
#
# 用法：
#   bash scripts/health-check.sh            # 全检（含真实调用一次 WB，约 10–60 秒）
#   bash scripts/health-check.sh --static   # 只查静态配置，不调用 WB
#
# 环境变量（都可选）：
#   BRIDGE=~/mcp-servers/workbuddy-bridge/server.mjs
#   MODEL=hy3

set -uo pipefail

BRIDGE="${BRIDGE:-$HOME/mcp-servers/workbuddy-bridge/server.mjs}"
MODEL="${MODEL:-hy3}"
CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
MODE="${1:-full}"
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
head_() { printf '\n%s\n' "$1"; }

head_ "1. 运行环境"
if command -v node >/dev/null 2>&1; then ok "node: $(node -v) （$(command -v node)）"; else bad "找不到 node，请先安装 Node.js"; fi

head_ "2. 桥脚本"
if [ -f "$BRIDGE" ]; then ok "找到桥：$BRIDGE"; else bad "找不到桥脚本：$BRIDGE（把 bridge/server.mjs 复制到这里，或用 BRIDGE= 指定）"; fi

head_ "3. Codex 配置注册"
if [ -f "$CONFIG" ]; then
  ok "配置文件：$CONFIG"
  if grep -q '^\[mcp_servers\.workbuddy\]' "$CONFIG"; then
    ok "已注册 [mcp_servers.workbuddy]"
    if grep -A3 '^\[mcp_servers\.workbuddy\]' "$CONFIG" | grep -q 'enabled *= *true'; then
      ok "该桥已启用（enabled = true）"
    else
      bad "桥被禁用了：enabled 不是 true"
    fi
    CLI_FROM_CONF="$(grep -m1 'WORKBUDDY_CLI' "$CONFIG" | sed -E 's/.*"([^"]+)".*/\1/')"
    [ -n "${CLI_FROM_CONF:-}" ] && ok "配置里的 WB 命令行：$CLI_FROM_CONF"
  else
    bad "没找到 [mcp_servers.workbuddy]，按 README 第 2 步加进去，然后完全重启 Codex"
  fi
else
  bad "找不到 $CONFIG"
fi

head_ "4. WorkBuddy 命令行"
CLI="${CLI_FROM_CONF:-}"
if [ -z "$CLI" ]; then
  for c in "$HOME/.local/bin/wb-codebuddy" \
           "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"; do
    [ -x "$c" ] && CLI="$c" && break
  done
fi
if [ -n "$CLI" ] && [ -x "$CLI" ]; then
  ok "可用：$CLI"
else
  CLI=""
  bad "没找到可执行的 WB 命令行（先装 WorkBuddy 桌面端，或安装独立 CLI）"
fi

head_ "5. 实调用（可跳过：--static）"
if [ "$MODE" = "--static" ]; then
  warn "已按 --static 跳过真实调用"
elif [ -z "$CLI" ]; then
  bad "没有可用命令行，跳过实调用"
else
  warn "正在调一次 WB（约 10–60 秒）。注意：别和别的 WB 任务同时跑，会抢端口。"
  OUT="$(timeout 120 "$CLI" -p '只回复两个字符：ok。不要做任何其他事。' -y --debug --max-turns 1 --model "$MODEL" 2>&1 || true)"
  if printf '%s' "$OUT" | grep -qi 'ok'; then
    ok "链路通了，模型 $MODEL 有回应"
  else
    bad "没拿到有效回应。常见原因：① WB 命令行没独立登录过（终端跑一次 $CLI 扫码）② 端口被桌面端占住 ③ 模型名不被支持"
    printf '\n----- 原始输出（前 20 行）-----\n%s\n' "$(printf '%s' "$OUT" | head -20)"
  fi
  case "$OUT" in
    *"fetch config failed"*) warn "出现 'fetch config failed' 属已知噪音，能出结果就忽略" ;;
  esac
fi

head_ "结论"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m全部通过。\033[0m 最后一步：让 Codex 派一个「读真实文件并落盘」的小任务，你亲手对照源文件确认结果真实。\n'
else
  printf '  \033[31m有项目未通过\033[0m，按上面标 ✗ 的提示逐条处理；README 第六节有症状对照表。\n'
fi
exit "$FAIL"
