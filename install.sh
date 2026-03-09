#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="worklog"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="${PLUGIN_SRC:-$SCRIPT_DIR}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
INSTALL_DIR="${OPENCLAW_HOME}/extensions/${PLUGIN_ID}"
MODE=""
SKIP_BUILD=0
RESTART_GATEWAY=1
FORCE=0
UPDATE_REPO=1
GIT_REF=""
DOCTOR=0

usage() {
  cat <<USAGE
OpenClaw worklog 安装 / 升级 / 修复脚本

用法：
  bash install.sh [选项]

常见场景：
  bash install.sh
  bash install.sh --copy
  bash install.sh --doctor
  bash install.sh --git-ref master

选项：
  --openclaw-home <dir>   指定 OpenClaw Home，默认 ~/.openclaw
  --install-dir <dir>     指定插件安装目录，默认 ~/.openclaw/extensions/worklog
  --source-dir <dir>      指定插件源码目录，默认脚本所在目录
  --copy                  用复制模式安装或升级
  --symlink               用软链接模式安装或修复
  --upgrade               显式启用源码仓库更新（默认已开启）
  --git-update            等同于 --upgrade
  --no-pull               跳过源码仓库更新，只做安装 / 修复
  --git-ref <ref>         升级源码仓库时切到指定分支 / tag / commit
  --doctor                只检查安装 / 软链接状态，不执行写入
  --skip-build            跳过 npm 构建
  --no-restart            安装后不重启 openclaw-gateway
  --force                 已有异常安装时自动备份后覆盖
  -h, --help              显示帮助
USAGE
}

log() {
  printf '[worklog/install] %s\n' "$*"
}

die() {
  printf '[worklog/install] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令：$1"
}

DOCTOR_ERRORS=0
DOCTOR_WARNINGS=0

doctor_ok() {
  printf '[worklog/doctor] OK: %s\n' "$*"
}

doctor_warn() {
  DOCTOR_WARNINGS=$((DOCTOR_WARNINGS + 1))
  printf '[worklog/doctor] WARN: %s\n' "$*"
}

doctor_error() {
  DOCTOR_ERRORS=$((DOCTOR_ERRORS + 1))
  printf '[worklog/doctor] ERROR: %s\n' "$*" >&2
}

resolve_mode() {
  if [[ -n "$MODE" ]]; then
    return
  fi
  if [[ -L "$INSTALL_DIR" ]]; then
    MODE="symlink"
    return
  fi
  if [[ -d "$INSTALL_DIR" ]]; then
    MODE="copy"
    return
  fi
  MODE="symlink"
}

json_has_plugin_id() {
  local file="$1"
  python3 - "$file" "$PLUGIN_ID" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
expected = sys.argv[2]
try:
    data = json.loads(path.read_text(encoding='utf-8'))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if isinstance(data, dict) and str(data.get('id', '')).strip() == expected else 1)
PY
}

doctor_run() {
  resolve_mode
  [[ -f "$PLUGIN_SRC/package.json" ]] && doctor_ok "找到 package.json：$PLUGIN_SRC/package.json" || doctor_error "缺少 package.json：$PLUGIN_SRC/package.json"
  if [[ -f "$PLUGIN_SRC/openclaw.plugin.json" ]] && json_has_plugin_id "$PLUGIN_SRC/openclaw.plugin.json"; then
    doctor_ok "插件清单正常：$PLUGIN_SRC/openclaw.plugin.json"
  else
    doctor_error "插件清单缺失或 id 不匹配：$PLUGIN_SRC/openclaw.plugin.json"
  fi

  if [[ -d "$PLUGIN_SRC/.git" ]]; then
    doctor_ok "源码目录是 git 仓库：$PLUGIN_SRC"
  else
    doctor_warn "源码目录不是 git 仓库；将跳过自动更新"
  fi

  if [[ "$MODE" == "symlink" ]]; then
    if [[ -L "$INSTALL_DIR" ]]; then
      local current
      current="$(readlink "$INSTALL_DIR" || true)"
      if [[ "$current" == "$PLUGIN_SRC" ]]; then
        doctor_ok "软链接正常：$INSTALL_DIR -> $PLUGIN_SRC"
      else
        doctor_warn "软链接指向不对：$INSTALL_DIR -> $current；重跑 install.sh 可修复"
      fi
    elif [[ -e "$INSTALL_DIR" ]]; then
      doctor_warn "安装目录存在但不是软链接：$INSTALL_DIR"
    else
      doctor_warn "尚未安装到：$INSTALL_DIR"
    fi
  else
    if [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/openclaw.plugin.json" ]] && json_has_plugin_id "$INSTALL_DIR/openclaw.plugin.json"; then
      doctor_ok "复制安装目录正常：$INSTALL_DIR"
    elif [[ -e "$INSTALL_DIR" ]]; then
      doctor_warn "安装目录存在，但不像是有效插件：$INSTALL_DIR"
    else
      doctor_warn "尚未安装到：$INSTALL_DIR"
    fi
  fi

  if [[ "$DOCTOR_ERRORS" -gt 0 ]]; then
    log "体检完成：error=$DOCTOR_ERRORS warning=$DOCTOR_WARNINGS"
    return 1
  fi
  log "体检完成：error=$DOCTOR_ERRORS warning=$DOCTOR_WARNINGS"
  return 0
}

update_repo_if_needed() {
  [[ "$UPDATE_REPO" -eq 1 ]] || { log "已按要求跳过仓库更新。"; return; }
  if [[ ! -d "$PLUGIN_SRC/.git" ]]; then
    log "源码目录不是 git 仓库，跳过更新。"
    return
  fi
  if ! command -v git >/dev/null 2>&1; then
    log "未找到 git，跳过仓库更新。"
    return
  fi
  if ! git -C "$PLUGIN_SRC" diff --quiet || ! git -C "$PLUGIN_SRC" diff --cached --quiet; then
    log "源码目录有未提交改动，跳过 git pull，避免把你的现场搞乱。"
    return
  fi

  log "正在更新源码仓库：$PLUGIN_SRC"
  git -C "$PLUGIN_SRC" fetch --tags --prune origin

  if [[ -n "$GIT_REF" ]]; then
    if git -C "$PLUGIN_SRC" show-ref --verify --quiet "refs/remotes/origin/$GIT_REF"; then
      git -C "$PLUGIN_SRC" checkout -B "$GIT_REF" "origin/$GIT_REF"
    else
      git -C "$PLUGIN_SRC" checkout "$GIT_REF"
    fi
  else
    local branch
    branch="$(git -C "$PLUGIN_SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
      log "当前不是普通分支，跳过 git pull；如需指定版本请使用 --git-ref。"
      return
    fi
    if git -C "$PLUGIN_SRC" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      git -C "$PLUGIN_SRC" pull --ff-only origin "$branch"
    else
      log "origin 上未找到分支 $branch，跳过 pull。"
    fi
  fi
}

build_plugin() {
  require_cmd npm
  (cd "$PLUGIN_SRC" && npm install)
  (cd "$PLUGIN_SRC" && npm run build)
}

backup_existing_install() {
  local target="$1"
  local backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
  mv "$target" "$backup"
  log "发现已有安装，已备份到：$backup"
}

is_install_healthy() {
  if [[ "$MODE" == "symlink" ]]; then
    [[ -L "$INSTALL_DIR" ]] || return 1
    [[ "$(readlink "$INSTALL_DIR" || true)" == "$PLUGIN_SRC" ]] || return 1
    [[ -f "$INSTALL_DIR/package.json" ]] || return 1
    [[ -f "$INSTALL_DIR/openclaw.plugin.json" ]] || return 1
    return 0
  fi

  [[ -d "$INSTALL_DIR" ]] || return 1
  [[ -f "$INSTALL_DIR/package.json" ]] || return 1
  [[ -f "$INSTALL_DIR/openclaw.plugin.json" ]] || return 1
  return 0
}

prepare_install_target() {
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [[ ! -e "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]]; then
    return
  fi

  if is_install_healthy; then
    log "检测到现有安装状态正常，执行升级/覆盖安装。"
    return
  fi

  log "检测到现有安装异常，准备自动修复：$INSTALL_DIR"
  if [[ -L "$INSTALL_DIR" ]]; then
    rm -f "$INSTALL_DIR"
    return
  fi
  if [[ -d "$INSTALL_DIR" ]]; then
    backup_existing_install "$INSTALL_DIR"
    return
  fi
  if [[ "$FORCE" -eq 1 ]]; then
    backup_existing_install "$INSTALL_DIR"
    return
  fi
  rm -f "$INSTALL_DIR" 2>/dev/null || true
}

install_plugin() {
  prepare_install_target

  if [[ "$MODE" == "copy" ]]; then
    require_cmd rsync
    rm -f "$INSTALL_DIR" 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude 'dist' \
      "$PLUGIN_SRC/" "$INSTALL_DIR/"
    log "已复制安装到：$INSTALL_DIR"
    return
  fi

  if [[ -L "$INSTALL_DIR" ]]; then
    local current
    current="$(readlink "$INSTALL_DIR" || true)"
    if [[ "$current" == "$PLUGIN_SRC" ]]; then
      log "软链接安装已正确指向当前源码。"
      return
    fi
    rm -f "$INSTALL_DIR"
  elif [[ -e "$INSTALL_DIR" ]]; then
    backup_existing_install "$INSTALL_DIR"
  fi

  ln -s "$PLUGIN_SRC" "$INSTALL_DIR"
  log "已创建软链接：$INSTALL_DIR -> $PLUGIN_SRC"
}

restart_gateway() {
  if [[ "$RESTART_GATEWAY" -ne 1 ]]; then
    log "已按要求跳过重启网关。"
    return
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user restart openclaw-gateway.service >/dev/null 2>&1; then
      log "已重启 openclaw-gateway.service"
      return
    fi
  fi
  log "未能自动重启 openclaw-gateway.service，请手动重启。"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-home)
      OPENCLAW_HOME="$2"
      INSTALL_DIR="${OPENCLAW_HOME}/extensions/${PLUGIN_ID}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --source-dir)
      PLUGIN_SRC="$2"
      shift 2
      ;;
    --copy)
      MODE="copy"
      shift
      ;;
    --symlink)
      MODE="symlink"
      shift
      ;;
    --upgrade|--git-update)
      UPDATE_REPO=1
      shift
      ;;
    --no-pull)
      UPDATE_REPO=0
      shift
      ;;
    --git-ref)
      GIT_REF="$2"
      shift 2
      ;;
    --doctor)
      DOCTOR=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-restart)
      RESTART_GATEWAY=0
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

PLUGIN_SRC="$(cd "$PLUGIN_SRC" && pwd)"
resolve_mode

if [[ "$DOCTOR" -eq 1 ]]; then
  doctor_run
  exit $?
fi

[[ -f "$PLUGIN_SRC/package.json" ]] || die "找不到 package.json：$PLUGIN_SRC"
[[ -f "$PLUGIN_SRC/openclaw.plugin.json" ]] || die "找不到 openclaw.plugin.json：$PLUGIN_SRC"

update_repo_if_needed
if [[ "$SKIP_BUILD" -ne 1 ]]; then
  build_plugin
else
  log "已跳过构建。"
fi
install_plugin
restart_gateway

cat <<NEXT

安装完成。

本脚本支持：
- 新安装
- 升级安装（重复执行即可）
- 自动检查并修复异常软链接 / 安装目录
- --doctor 只检查不写入

下一步建议：
1. 在 OpenClaw 宿主配置里启用插件 worklog
2. 参考示例配置：$PLUGIN_SRC/config/plugin-config.example.json5
3. 如未自动重启，请手动重启 openclaw-gateway

常用命令：
  openclaw plugins info worklog
  openclaw worklog self-test
NEXT
