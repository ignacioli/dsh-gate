#!/bin/sh
# Install (or reinstall) the dsh-gate daemon for one primary checkout.
#
# Run once from a normal Terminal, not from inside an agent sandbox: the daemon
# must be free to apply its own Seatbelt profile around project commands, and
# the per-project config must land outside the agent-writable checkout.
#
# Options for validation/automation:
#   --dry-run       print computed root/key/config instead of writing anything
#   --no-launchctl  write config + plist but do not load a LaunchAgent
set -eu

LABEL_PREFIX=com.dsh-gate
GATE_DIR=$(cd -P "$(dirname "$0")" && pwd)

usage() {
  cat <<'EOF'
用法: install.sh [options]
  --template <ios|macos|android|<file.json>>  命令模板（默认 ios）
  --project <path/to.xcodeproj>               Xcode 项目路径（macOS 模板可自动探测根目录）
  --destination <xcodebuild 目标>             默认自动选一个 iPhone 模拟器（iOS 模板）
  --root <project-checkout>                   被门禁的项目 checkout（从项目目录运行时自动推断）
  --force                                     覆盖已存在的 config.json
  --dry-run                                   只打印，不写文件、不加载 LaunchAgent
  --no-launchctl                              写配置和 plist，但不加载 LaunchAgent
EOF
}

TEMPLATE=ios
PROJECT=
DESTINATION=
ROOT_ARG=
FORCE=no
DRY_RUN=no
NO_LAUNCHCTL=no
while [ $# -gt 0 ]; do
  case "$1" in
    --template) TEMPLATE=$2; shift 2 ;;
    --template=*) TEMPLATE=${1#*=}; shift ;;
    --project) PROJECT=$2; shift 2 ;;
    --project=*) PROJECT=${1#*=}; shift ;;
    --destination) DESTINATION=$2; shift 2 ;;
    --destination=*) DESTINATION=${1#*=}; shift ;;
    --root) ROOT_ARG=$2; shift 2 ;;
    --root=*) ROOT_ARG=${1#*=}; shift ;;
    --force) FORCE=yes; shift ;;
    --dry-run) DRY_RUN=yes; shift ;;
    --no-launchctl) NO_LAUNCHCTL=yes; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install: unknown option: $1" >&2; usage; exit 64 ;;
  esac
done

NODE=${DSH_GATE_NODE:-$(command -v node 2>/dev/null || true)}
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node
if [ ! -x "$NODE" ]; then
  echo "install: node not found; install Node.js 18+ (brew install node) or set DSH_GATE_NODE" >&2
  exit 1
fi

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
  echo "install: choose the project this daemon gates:" >&2
  echo "  cd <project-checkout> && $GATE_DIR/install.sh" >&2
  echo "  or: $GATE_DIR/install.sh --root <project-checkout>" >&2
  exit 1
fi
ROOT=$(cd "$ROOT" && pwd -P)

KEY=$("$NODE" --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(mod.projectKey(process.argv[2]));
' "$GATE_DIR/lib/common.mjs" "$ROOT")

PROJECT_DIR="$HOME/.config/dsh-gate/$KEY"
CONFIG="$PROJECT_DIR/config.json"
LABEL="$LABEL_PREFIX.$KEY"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$GATE_DIR/templates/$TEMPLATE.json" ]; then
  TEMPLATE_FILE="$GATE_DIR/templates/$TEMPLATE.json"
elif [ -f "$TEMPLATE" ]; then
  TEMPLATE_FILE="$TEMPLATE"
else
  echo "install: template not found: $TEMPLATE" >&2
  exit 1
fi

if [ -z "$PROJECT" ]; then
  case "$TEMPLATE" in
    ios)
      if [ -d "$ROOT/ios/FineCoach.xcodeproj" ]; then PROJECT=ios/FineCoach.xcodeproj; fi
      ;;
    macos)
      for candidate in "$ROOT"/*.xcodeproj; do
        if [ -d "$candidate" ]; then PROJECT=$(basename "$candidate"); break; fi
      done
      ;;
  esac
fi
if grep -q '@PROJECT@' "$TEMPLATE_FILE" && [ -z "$PROJECT" ]; then
  echo "install: this template needs --project <path/to.xcodeproj>" >&2
  exit 1
fi

if grep -q '@DESTINATION@' "$TEMPLATE_FILE" && [ -z "$DESTINATION" ]; then
  DESTINATION=$("$NODE" -e '
    const { execFileSync } = require("node:child_process");
    const data = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" }));
    const phones = Object.values(data.devices).flat().filter((device) => /^iPhone/.test(device.name));
    const pick = phones.find((device) => device.state === "Booted") || phones[0];
    if (!pick) { console.error("no available iPhone simulator"); process.exit(1); }
    process.stdout.write("platform=iOS Simulator,id=" + pick.udid);
  ') || { echo "install: could not detect a simulator; pass --destination" >&2; exit 1; }
fi

render_config() {
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@PROJECT@|$PROJECT|g" -e "s|@DESTINATION@|$DESTINATION|g" "$TEMPLATE_FILE"
}

render_plist() {
  path_value="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
  sed \
    -e "s|__LABEL__|$LABEL|" \
    -e "s|__NODE__|$NODE|" \
    -e "s|__DAEMON__|$GATE_DIR/daemon/dsh-gate-daemon.mjs|" \
    -e "s|__ROOT__|$ROOT|" \
    -e "s|__LOG__|$PROJECT_DIR/logs|" \
    -e "s|__PATH__|$path_value|" \
    "$GATE_DIR/launchd/$LABEL_PREFIX.plist.template"
}

if [ "$DRY_RUN" = yes ]; then
  echo "dsh-gate: project: $ROOT"
  echo "dsh-gate: key:     $KEY"
  echo "dsh-gate: config:  $CONFIG"
  echo "dsh-gate: label:   $LABEL"
  echo "dsh-gate: plist:   $PLIST"
  echo "--- config.json ---"
  render_config
  echo "--- plist ---"
  render_plist
  exit 0
fi

if [ -f "$CONFIG" ] && [ "$FORCE" != yes ]; then
  echo "dsh-gate: keeping existing config: $CONFIG"
  echo "dsh-gate: (use --force to re-render it from templates/$TEMPLATE.json)"
else
  mkdir -p "$PROJECT_DIR/run" "$PROJECT_DIR/logs"
  render_config > "$CONFIG"
  "$NODE" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$CONFIG" \
    || { echo "install: rendered config is not valid JSON" >&2; exit 1; }
  echo "dsh-gate: wrote $CONFIG"
fi
mkdir -p "$PROJECT_DIR/run" "$PROJECT_DIR/logs"

mkdir -p "$HOME/Library/LaunchAgents"
render_plist > "$PLIST"
echo "dsh-gate: wrote $PLIST"

if [ "$NO_LAUNCHCTL" = yes ]; then
  echo "dsh-gate: --no-launchctl: skipped LaunchAgent load"
else
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  sleep 1
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "dsh-gate: LaunchAgent $LABEL loaded"
  else
    echo "dsh-gate: LaunchAgent failed to load; inspect $PROJECT_DIR/logs/daemon.err.log" >&2
    exit 1
  fi
  if [ -d "$HOME/bin" ]; then
    ln -sf "$GATE_DIR/bin/dsh-gate" "$HOME/bin/dsh-gate"
    echo "dsh-gate: linked $HOME/bin/dsh-gate"
  else
    echo "dsh-gate: add $GATE_DIR/bin to PATH, or call $GATE_DIR/bin/dsh-gate directly"
  fi
fi

echo "dsh-gate: project key: $KEY"
echo "dsh-gate: config: $CONFIG"
echo "dsh-gate: audit:  $PROJECT_DIR/audit.jsonl"
echo "dsh-gate: logs:   $PROJECT_DIR/logs"
echo "dsh-gate: next:   cd $ROOT && $GATE_DIR/bin/dsh-gate doctor"
