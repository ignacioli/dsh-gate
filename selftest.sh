#!/bin/sh
# Foreground self-test for one already-installed project.
#
# Run from a normal Terminal (NOT from inside an agent sandbox: the daemon must
# be free to apply its own Seatbelt profile around project commands).
#
# Starts a daemon on this project's socket, runs status/doctor/build/test, prints
# the audit tail, stops the daemon. If the LaunchAgent is already running it
# holds the same socket; stop it first (launchctl bootout) or run the checks
# through the installed daemon instead.
set -eu

GATE_DIR=$(cd -P "$(dirname "$0")" && pwd)
ROOT_ARG=
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT_ARG=$2; shift 2 ;;
    --root=*) ROOT_ARG=${1#*=}; shift ;;
    -h|--help)
      echo "用法: selftest.sh [--root <project-checkout>]"
      echo "无 --root 时从当前目录的项目 checkout 推断；已有 daemon 在跑则直接复用它。"
      exit 0
      ;;
    *) echo "selftest: unknown option: $1" >&2; exit 64 ;;
  esac
done

NODE=${DSH_GATE_NODE:-$(command -v node 2>/dev/null || true)}
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "dsh-gate: node not found; set DSH_GATE_NODE" >&2
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
  echo "dsh-gate: choose the project to test:" >&2
  echo "  cd <project-checkout> && $GATE_DIR/selftest.sh" >&2
  echo "  or: $GATE_DIR/selftest.sh --root <project-checkout>" >&2
  exit 1
fi
ROOT=$(cd "$ROOT" && pwd -P)

DAEMON_PID=
DAEMON_LOG=
cleanup() {
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if (cd "$ROOT" && "$GATE_DIR/bin/dsh-gate" status >/dev/null 2>&1); then
  echo "dsh-gate: using the daemon that is already running"
else
  DAEMON_LOG=$(mktemp -t dsh-gate-selftest)
  "$NODE" "$GATE_DIR/daemon/dsh-gate-daemon.mjs" --root "$ROOT" >>"$DAEMON_LOG" 2>&1 &
  DAEMON_PID=$!
  i=0
  while [ "$i" -lt 100 ]; do
    if (cd "$ROOT" && "$GATE_DIR/bin/dsh-gate" status >/dev/null 2>&1); then break; fi
    i=$((i + 1))
    sleep 0.2
  done
  if [ "$i" -ge 100 ]; then
    echo "dsh-gate: daemon did not start; log:" >&2
    cat "$DAEMON_LOG" >&2
    exit 1
  fi
fi

cd "$ROOT"
echo "=== dsh-gate status ==="
"$GATE_DIR/bin/dsh-gate" status
echo "=== dsh-gate doctor ==="
"$GATE_DIR/bin/dsh-gate" doctor || echo "(doctor reported failures; inspect above)"
echo "=== dsh-gate build ==="
"$GATE_DIR/bin/dsh-gate" build
echo "=== dsh-gate test ==="
"$GATE_DIR/bin/dsh-gate" test
echo "=== dsh-gate audit ==="
"$GATE_DIR/bin/dsh-gate" audit --lines 5
echo "dsh-gate: selftest finished"
