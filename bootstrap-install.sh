#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/vikingleo/openclaw-worklog.git"
DEFAULT_REF="master"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CLONE_DIR_DEFAULT="${OPENCLAW_HOME}/src/openclaw-worklog"

REPO_URL="${OPENCLAW_WORKLOG_REPO_URL:-$DEFAULT_REPO_URL}"
REF_NAME="${OPENCLAW_WORKLOG_REF:-$DEFAULT_REF}"
CLONE_DIR="$CLONE_DIR_DEFAULT"
INSTALL_MODE="copy"
PASSTHROUGH_ARGS=()

usage() {
  cat <<USAGE
OpenClaw worklog 远程一键安装脚本

用法：
  bash bootstrap-install.sh [选项] [-- install.sh参数...]

选项：
  --repo <git-url>      指定仓库地址，默认 https://github.com/vikingleo/openclaw-worklog.git
  --ref <git-ref>       指定分支 / tag / commit，默认 master
  --clone-dir <dir>     指定持久源码目录，默认 ~/.openclaw/src/openclaw-worklog
  --copy                调用 install.sh 时用复制模式，默认
  --symlink             调用 install.sh 时用软链接模式
  -h, --help            显示帮助

install.sh 常见透传参数：
  --force
  --openclaw-home <dir>
  --no-restart
  --no-pull
  --doctor

示例：
  bash bootstrap-install.sh -- --force
  bash bootstrap-install.sh -- --force          # 重跑即可升级 / 修复
  bash bootstrap-install.sh --symlink -- --force
USAGE
}

log() {
  printf '[worklog/bootstrap] %s\n' "$*"
}

die() {
  printf '[worklog/bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令：$1"
}

clone_or_update_repo() {
  require_cmd git
  local parent_dir
  parent_dir="$(dirname "$CLONE_DIR")"
  mkdir -p "$parent_dir"

  if [[ -d "$CLONE_DIR/.git" ]]; then
    log "发现已有源码目录，更新仓库：$CLONE_DIR"
    git -C "$CLONE_DIR" remote set-url origin "$REPO_URL"
    git -C "$CLONE_DIR" fetch --tags origin
  else
    if [[ -e "$CLONE_DIR" ]]; then
      die "克隆目录已存在但不是 git 仓库：$CLONE_DIR"
    fi
    log "正在克隆仓库到：$CLONE_DIR"
    git clone "$REPO_URL" "$CLONE_DIR"
  fi

  if ! git -C "$CLONE_DIR" rev-parse --verify --quiet "${REF_NAME}^{commit}" >/dev/null; then
    git -C "$CLONE_DIR" fetch --tags origin "$REF_NAME" || true
  fi
  git -C "$CLONE_DIR" checkout "$REF_NAME"
  if git -C "$CLONE_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF_NAME"; then
    git -C "$CLONE_DIR" reset --hard "origin/$REF_NAME"
  fi
}

run_install() {
  local install_script="$CLONE_DIR/install.sh"
  [[ -f "$install_script" ]] || die "仓库内缺少 install.sh：$install_script"

  local args=(--source-dir "$CLONE_DIR")
  if [[ "$INSTALL_MODE" == "copy" ]]; then
    args+=(--copy)
  else
    args+=(--symlink)
  fi
  args+=("${PASSTHROUGH_ARGS[@]}")

  log "开始执行 install.sh ${args[*]}"
  bash "$install_script" "${args[@]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="$2"
      shift 2
      ;;
    --ref)
      REF_NAME="$2"
      shift 2
      ;;
    --clone-dir)
      CLONE_DIR="$2"
      shift 2
      ;;
    --copy)
      INSTALL_MODE="copy"
      shift
      ;;
    --symlink)
      INSTALL_MODE="symlink"
      shift
      ;;
    --)
      shift
      PASSTHROUGH_ARGS=("$@")
      break
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

require_cmd bash
clone_or_update_repo
run_install

cat <<DONE

bootstrap 安装完成。
- repo: $REPO_URL
- ref: $REF_NAME
- source: $CLONE_DIR

重跑同一条命令即可完成升级、修复或重装。
DONE
