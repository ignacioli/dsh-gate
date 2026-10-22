# dsh-gate

English | [中文](README.zh.md)

> **Unofficial tool. Not affiliated with DeepSeek.** This project addresses a conflict between
> the DeepSeek Harness (dsh) macOS sandbox and local build toolchains. It is not part of the
> DeepSeek product line.

A local build/test gate for coding agents that are confined by their own sandbox. The agent does
not invoke `xcodebuild` / `gradlew` directly; it invokes `dsh-gate`. A daemon outside the agent
sandbox runs the real command under a write-restricted Seatbelt profile and records an audit trail.

## Why it exists

dsh wraps every bash command on macOS in a Seatbelt profile:

```
(allow default) (deny file-write*)
writable: workspace root, /tmp, os.tmpdir(), /dev/null
```

That profile has two structural conflicts with the Xcode toolchain (both reproduced locally):

| Conflict | Symptom | Cause |
|---|---|---|
| Swift macro plugins | `build-for-testing` always fails: `sandbox-exec: sandbox_apply: Operation not permitted` then `SwiftUIMacros.StateMacro ... malformed response` | Xcode applies a second Seatbelt sandbox around the macro plugin process. Any outer profile containing `deny file-write*` makes the inner `sandbox_apply` fail. Adding writable paths does not help (9 profile variants tested). |
| Test execution | `Pseudo Terminal Setup Error / Operation not permitted` | Tests need a PTY (`/dev/ptmx`) and simulator writes under `~/Library/Developer/CoreSimulator`, outside dsh's writable set. |

dsh exposes only three knobs (sandbox mode, workspace root, approval policy); the writable set is
fixed in code, and the headless profile has no approval answerer (fail-closed by design). An
unattended agent therefore cannot complete build+test on its own.

## What it does

- The agent keeps editing code under its own sandbox.
- Build/test runs go through `dsh-gate build|test` to one daemon per primary checkout.
- The daemon runs only the fixed command templates stored in
  `~/.config/dsh-gate/<project-key>/config.json` and confines each step with a profile that allows
  writes only to the worktree, DerivedData, toolchain caches, and `/dev`.
- Config and audit live in your home directory, outside the agent's write authority, so the agent
  cannot rewrite the command templates.
- Self-check is not acceptance: the official gate is still run by a human (or the orchestrating
  agent) on the host with standard commands.

## Install

Requirements: macOS + Xcode + Node.js 18+ (git 2.31+); the gated project must be a git checkout.

```sh
git clone <this-repo> dsh-gate
cd dsh-gate
./install.sh --root /path/to/project-checkout             # iOS (default template)
./install.sh --root /path/to/project --template macos     # macOS app
./install.sh --root /path/to/project --template android   # Android (Gradle)
./install.sh --root /path/to/project --dry-run            # print only, write nothing
```

Then, from the project directory:

```sh
cd /path/to/project-checkout
/path/to/dsh-gate/bin/dsh-gate doctor
/path/to/dsh-gate/bin/dsh-gate build
/path/to/dsh-gate/bin/dsh-gate test --scope unit
```

## Status

- Version: **0.1.0** (first release).
- Platform: macOS; Node 18+; git 2.31+.
- Templates: **iOS verified** (FineCoach, Xcode 27.1) — LaunchAgent installed, `doctor` 7/7,
  cold build 67s, incremental 2s, 528 unit + 198 integration tests green. The macOS and Android
  templates are provided but not verified against a real project; adjust `schemes` / `steps` /
  `writeRoots` as needed.
- Size: about 1.2k lines of code, Node.js standard library only.

## Documentation

- [DESIGN.md](DESIGN.md) — problem evidence, architecture, config model, permission model,
  platform support, trade-offs.
- [MANUAL.md](MANUAL.md) — install, usage, multiple projects, troubleshooting, security boundary,
  uninstall.

## Security boundary

Kernel-enforced write boundary plus a per-run audit record. Reads and network are unrestricted.
Build scripts and test code can execute arbitrary commands, so the boundary lives in the Seatbelt
profile rather than in a command allowlist. Single user, single machine. See [MANUAL.md](MANUAL.md)
section 8.
