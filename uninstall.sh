#!/bin/sh
# Remove the dsh-gate LaunchAgent for one project checkout.
# Logs, audit and config are kept unless --purge is given.
set -eu

LABEL_PREFIX=com.dsh-gate
GATE_DIR=$(cd -P "$(dirname "$0")" && pwd)
PURGE=no
ROOT_ARG=
DRY_RUN=no
PREFIX=${DSH_GATE_PREFIX:-$HOME/.local}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT_ARG=$2; shift 2 ;;
    --root=*) ROOT_ARG=${1#*=}; shift ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --prefix=*) PREFIX=${1#*=}; shift ;;
    --purge) PURGE=yes; shift ;;
    --dry-run) DRY_RUN=yes; shift ;;
    -h|--help)
      echo "用法: uninstall.sh [--root <project-checkout>] [--prefix <dir>] [--purge] [--dry-run]"
      echo "  --prefix   安装前缀（默认 ~/.local）；最后一个项目卸载时一并删除 <dir>/share/dsh-gate 与 <dir>/bin/dsh-gate"
      echo "  --purge    同时删除 ~/.config/dsh-gate/<key>/"
      echo "  --dry-run  只打印将删除的 label/plist/目录"
      exit 0
      ;;
    *) echo "uninstall: unknown option: $1" >&2; exit 64 ;;
  esac
done

NODE=${DSH_GATE_NODE:-$(command -v node 2>/dev/null || true)}
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node

TOOL_ROOT=$(git -C "$GATE_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [ -n "$TOOL_ROOT" ]; then TOOL_ROOT=$(dirname "$TOOL_ROOT"); else TOOL_ROOT=$GATE_DIR; fi
STANDALONE=no
if [ "$(cd "$GATE_DIR" && pwd -P)" = "$(cd "$TOOL_ROOT" && pwd -P)" ]; then STANDALONE=yes; fi

CWD_ROOT=
CWD_COMMON=$(git -C "$PWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [ -n "$CWD_COMMON" ]; then CWD_ROOT=$(dirname "$CWD_COMMON"); fi

ROOT=
if [ -n "$ROOT_ARG" ]; then
  ROOT=$ROOT_ARG
elif [ -n "$CWD_ROOT" ] && { [ "$CWD_ROOT" != "$TOOL_ROOT" ] || [ "$STANDALONE" = no ]; }; then
  ROOT=$CWD_ROOT
fi
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "uninstall: choose the project:" >&2
  echo "  cd <project-checkout> && $GATE_DIR/uninstall.sh" >&2
  echo "  or: $GATE_DIR/uninstall.sh --root <project-checkout>" >&2
  exit 1
fi
ROOT=$(cd "$ROOT" && pwd -P)

KEY=$("$NODE" --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(mod.projectKey(process.argv[2]));
' "$GATE_DIR/lib/common.mjs" "$ROOT")

INSTALL_DIR="$PREFIX/share/dsh-gate"
BIN_DIR="$PREFIX/bin"
PROJECT_DIR="$HOME/.config/dsh-gate/$KEY"
LABEL="$LABEL_PREFIX.$KEY"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$DRY_RUN" = yes ]; then
  echo "dsh-gate: project: $ROOT"
  echo "dsh-gate: key:     $KEY"
  echo "dsh-gate: label:   $LABEL"
  echo "dsh-gate: plist:   $PLIST"
  echo "dsh-gate: state:   $PROJECT_DIR (purge: $PURGE)"
  echo "dsh-gate: runtime: $INSTALL_DIR (removed only when no other project remains)"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -f "$PROJECT_DIR/run/gate.sock" "$PROJECT_DIR/run/gate.pid"
if [ -L "$HOME/bin/dsh-gate" ]; then rm -f "$HOME/bin/dsh-gate"; fi

remaining=$(ls "$HOME/Library/LaunchAgents/$LABEL_PREFIX".*.plist 2>/dev/null | wc -l | tr -d ' ')
if [ "$remaining" = 0 ]; then
  if [ -L "$BIN_DIR/dsh-gate" ] && [ "$(readlink "$BIN_DIR/dsh-gate")" = "$INSTALL_DIR/bin/dsh-gate" ]; then
    rm -f "$BIN_DIR/dsh-gate"
  fi
  case "$INSTALL_DIR" in
    */share/dsh-gate) rm -rf "$INSTALL_DIR"; echo "dsh-gate: removed runtime $INSTALL_DIR" ;;
  esac
else
  echo "dsh-gate: kept runtime $INSTALL_DIR ($remaining other project(s) still installed)"
fi

echo "dsh-gate: LaunchAgent $LABEL removed"
if [ "$PURGE" = yes ]; then
  rm -rf "$PROJECT_DIR"
  echo "dsh-gate: purged $PROJECT_DIR"
else
  echo "dsh-gate: kept $PROJECT_DIR (config, logs, audit); use --purge to delete"
fi
