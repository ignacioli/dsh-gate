# dsh-gate Design

English | [中文](DESIGN.zh.md)

> Version 0.1.0 · 2026-10-22 · Unofficial tool, not affiliated with DeepSeek.
> Code: repository root · User manual: [MANUAL.md](MANUAL.md)

## 1. Background: why this exists

FineCoach uses dsh (DeepSeek harness) for implementation and Claude Code for orchestration and
acceptance. On macOS, dsh wraps every bash command in a Seatbelt profile:

```
(allow default) (deny file-write*)
writable: workspaceRoot, /tmp, os.tmpdir(), /dev/null
```

That profile has two structural conflicts with the Xcode toolchain, both reproduced locally:

| Conflict | Symptom | Cause |
|---|---|---|
| Swift macro plugins | `xcodebuild build-for-testing` always fails: `sandbox-exec: sandbox_apply: Operation not permitted` then `SwiftUIMacros.StateMacro ... malformed response` | Xcode applies a second `sandbox-exec` around the macro plugin process. Any outer profile containing `deny file-write*` makes the inner `sandbox_apply` fail. Nine profile variants (adding `~/Library`, `/var/folders`, `/var/db`, `subpath "/"`, scoped denies) all failed: writable paths do not help. |
| Test execution | `xcodebuild test-without-building`: `Pseudo Terminal Setup Error / Operation not permitted` | Tests need a PTY (`/dev/ptmx`) and simulator writes (`~/Library/Developer/CoreSimulator`), both outside dsh's writable set. |

dsh config exposes only sandbox mode, workspace root, and approval policy; the writable set is fixed
in code. The headless profile has no approval answerer and fails closed. An unattended agent cannot
complete build+test by itself.

**Conclusion:** move the single privileged action — running the build/test toolchain — outside the
agent sandbox into a smaller, auditable executor. Do not widen the agent's write authority.

## 2. Goals and non-goals

Goals:

- Let a sandboxed agent complete build → test → read logs → edit code in one session.
- Enforce capability with the kernel (Seatbelt), not with a command allowlist.
- Keep the agent's write authority confined to its workspace; do not touch dsh configuration or `~/.dsh`.
- Audit every run and every rejection.
- Support multiple projects and several toolchains (iOS / macOS / Android), one instance per project.
- Keep the implementation small enough to review end to end.

Non-goals:

- No full CI (no remote, no queue beyond a single slot, no matrix, no cache management).
- No read or network confinement (matching dsh's existing bash posture).
- No replacement for the acceptance gate (self-check is not acceptance, see section 8).
- No commits and no modifications to tracked repository files.

## 3. Architecture

```
<tool checkout>/                    dsh-gate repository root (recommended layout)
  bin/, client/, daemon/, lib/, templates/, launchd/, *.sh

~/.config/dsh-gate/<key>/          state outside agent write authority
  config.json                      project command templates (written by install.sh)
  logs/*.log                       full output of every run
  audit.jsonl                      audit trail
  run/gate.sock, gate.pid          local socket (0600)

agent (sandboxed) -- dsh-gate build|test --> daemon (outside sandbox, one per project)
                                              `- sandbox-exec -p <profile> <template argv>`
Claude (host)    -- dsh-gate status|audit|doctor
```

| Component | File | Responsibility |
|---|---|---|
| Client | `bin/dsh-gate`, `client/dsh-gate.mjs` | Resolve the primary checkout via `git rev-parse --git-common-dir`, derive the project key, connect to that project's socket, stream output, mirror the exit code |
| Daemon | `daemon/dsh-gate-daemon.mjs` | One instance per project; validate requests, read the user-owned config, build fixed argv, apply Seatbelt, write audit |
| Shared rules | `lib/common.mjs` | Project key, config loading, writable roots, Seatbelt profile, placeholder resolution, command plan |
| Templates | `templates/{ios,macos,android}.json` | Rendered into `~/.config/dsh-gate/<key>/config.json` at install time |
| Install | `install.sh`, `uninstall.sh`, `selftest.sh` | LaunchAgent (`com.dsh-gate.<key>`), first-time config, self-test |

**Config and audit live outside the agent's write authority.** The agent can write the repository
(workspace-write), so command templates, audit, and logs must not live there. They live under
`~/.config/dsh-gate/`. The in-repo `templates/` are read only at install time; editing them does not
affect an installed daemon.

**Project key:** `<repo-dir-name>-<sha1(primary checkout realpath)[0:8]>`, for example
`finecoach-2a67619b`. Any worktree of the same checkout resolves to the same key through the git
common dir, so `dsh-gate` works from every worktree.

## 4. Configuration model

`~/.config/dsh-gate/<key>/config.json` (rendered by install.sh, then user-editable; not writable by
the agent):

```jsonc
{
  "version": 1,
  "root": "/abs/primary/checkout",              // must match the daemon root
  "project": "ios/FineCoach.xcodeproj",         // optional; used by {project}
  "schemes": { "build": "FineCoach", "unit": "FineCoachTests" }, // optional; {scheme:name}
  "destination": "platform=iOS Simulator,id=...", // optional; {destination}
  "derivedDataRoot": "/tmp/dsh-gate",           // per-worktree hashed subdirectory
  "allowedCwdRoots": [".", ".worktrees", ".agents/worktrees"],
  "writeRoots": ["~/Library/Developer", "~/Library/Logs", "~/Library/Caches"],
  "steps": {
    "build": [ { "label": "build-for-testing", "argv": ["/usr/bin/xcodebuild", "..."] } ],
    "test":  { "unit": [ "..." ], "integration": [ "..." ] }  // keys are --scope values
  },
  "timeoutsMs": { "build": 900000, "test": 1800000 },
  "testStopOnFirstFailure": false
}
```

Placeholders resolved by the daemon (the client cannot inject them):

| Placeholder | Value |
|---|---|
| `{workspace}` | request cwd (canonical) |
| `{root}` | project primary checkout |
| `{project}` | `{workspace}/<config.project>` |
| `{derivedData}` | `<derivedDataRoot>/<sha1(workspace)[0:12]>` |
| `{destination}` | `config.destination` |
| `{scheme:<name>}` | `config.schemes[name]` |
| `{only}` | client `--only` filter; the whole argv element is dropped when empty |

Unresolved placeholders or empty arguments are rejected (`CONFIG_INVALID`); no partial string reaches
a shell.

**Scope:** the keys of `steps.test` are the `--scope` values; `all` (the default) runs every scope in
configuration order. `--only` applies only to steps containing `{only}`; otherwise `ONLY_UNSUPPORTED`.

## 5. Permission model

### 5.1 Seatbelt profile

Generated per run (`lib/common.mjs: seatbeltProfile`):

```
(version 1)
(allow default)                                   ; reads, network, mach unrestricted
(deny file-write*)                                ; all writes denied by default
(allow file-write* (subpath <workspace>)          ; the checkout being built
                   (subpath <derivedData>)         ; /tmp/dsh-gate/<hash>
                   (subpath "/tmp") (subpath <tmpdir>) (subpath "/dev")
                   (subpath ~/Library/Developer) (subpath ~/Library/Logs)
                   (subpath ~/Library/Caches)
                   <config.writeRoots...>)         ; per-template toolchain paths
```

**Why Xcode templates must keep `OTHER_SWIFT_FLAGS=-disable-sandbox`:** any outer Seatbelt profile
with `(deny file-write*)` prevents Xcode's macro plugin from applying its own sandbox (section 1).
The flag disables only the compiler subprocess sandbox; it does not weaken the file boundary above.
It appears only in self-check commands generated by the daemon, never in the acceptance gate.

The Android template has no nested-sandbox issue; it only needs broader writable roots
(`~/.gradle`, `~/.android`, the Android SDK). That difference is the point: the generic gate layer
is separate from the Xcode-specific workaround.

### 5.2 Boundary verification

`dsh-gate doctor` runs `write-outside-denied`: it attempts to write `~/.dsh-gate-doctor-*` inside the
profile and requires the write to be denied and absent afterwards.

### 5.3 What it does not protect

- Reads and network are unrestricted (same posture as dsh's bash sandbox).
- Build scripts and test code can execute arbitrary commands; the boundary is the profile, not a
  command allowlist.
- Single user, single machine; the daemon runs as you and the socket is mode 0600.
- `~/.config/dsh-gate/` protects against a sandboxed agent, not against an unsandboxed process
  running as your user.

## 6. Request protocol

Unix socket (0600), one JSON request per line:

```json
{ "v": 1, "op": "build|test|doctor|status", "cwd": "/abs/path", "pid": 1234,
  "scope": "all", "only": "FineCoachTests/NumberFormatScanTests" }
```

Response events: `log`, `status`, `doctor`, `error`, `exit`.

Rejection codes: `CONFIG_MISSING`, `CONFIG_INVALID`, `CONFIG_ROOT_MISMATCH`, `CWD_INVALID`,
`CWD_NOT_ALLOWED`, `SCOPE_INVALID`, `ONLY_INVALID`, `ONLY_UNSUPPORTED`, `NO_STEPS`, `BAD_OP`,
`BAD_REQUEST`, `BAD_VERSION`, `BUSY` (exit 75). Rejections are audited too.

## 7. Audit and logs

- Audit: `~/.config/dsh-gate/<key>/audit.jsonl` — one line per request (`ts`, `id`, `op`, `scope`,
  `only`, `cwd`, `steps`, `exit`, `durationMs`, `log`); rejections record `exit: null` and `error`.
- Logs: `~/.config/dsh-gate/<key>/logs/<timestamp>-<id>-<op>.log`.
- Daemon output: LaunchAgent `logs/daemon.out.log` / `daemon.err.log`.

## 8. Self-check is not acceptance

| Layer | Who runs it | Command | Purpose |
|---|---|---|---|
| Self-check | agent | `dsh-gate build` / `dsh-gate test` (daemon sandbox; Xcode templates use `-disable-sandbox`) | eliminate compile/test round trips |
| Acceptance | human or orchestrator on the host | standard commands, **without** `-disable-sandbox` | the only valid gate; review diff and logs |

The audit lets the orchestrator confirm cheaply that only build/test ran; it is not acceptance
evidence.

## 9. Failure modes and degradation

| Situation | Symptom | Handling |
|---|---|---|
| Daemon not running | client exits 69 with install hint | agent reports BLOCKED; orchestrator runs the gate on the host |
| Config missing or broken | `CONFIG_MISSING` / `CONFIG_INVALID`, exit 2 | reinstall or fix config |
| Request cwd outside allowed roots | `CWD_NOT_ALLOWED`, exit 2, audited | fix cwd |
| Daemon busy | `BUSY`, exit 75 | retry serially |
| Step failed | original log and exit code streamed back | agent reads the log and fixes code |
| Timeout | process group SIGTERM then SIGKILL, non-zero exit | narrow with `--only` or raise `timeoutsMs` |
| New toolchain path blocked | `Operation not permitted` pointing at a new path | add it to `config.writeRoots`, restart daemon |
| launchd throttles the build | the same command takes 519s instead of 67s | do not set `ProcessType=Background` in the plist; keep the default Standard |

## 10. Platform support

| Template | Status | Notes |
|---|---|---|
| `ios` | **Verified** (this project, Xcode 27.1) | simulator destination, PTY, macro flag |
| `macos` | Template provided, not verified locally (no macOS target in this repo) | `platform=macOS`, no simulator or PTY; adjust scheme names |
| `android` | Template provided, not verified locally (no Gradle/SDK/AVD check) | Gradle has no nested-sandbox issue; `writeRoots` must cover `~/.gradle`, the SDK, and AVD; instrumentation needs an emulator or device |

To onboard a new project: `install.sh --template macos --project <xcodeproj>`, or copy
`templates/android.json` and adapt `steps` / `writeRoots`.

## 11. Alternatives considered

| Option | One-session loop | Security | Verdict |
|---|---|---|---|
| Session-level `danger-full-access` | yes | whole machine writable, no audit | rejected |
| Custom headless approval-answerer plugin | yes | approval requests carry no command arguments, so it can only approve blindly; requires editing `~/.dsh` | rejected |
| Split into "implementation session + run-only verification session" | no | fixing test code would bounce back to the implementer | rejected |
| Dedicated macOS user / VM | yes | strong | fallback; higher operational cost |
| **This design (one daemon per project, custom profile)** | **yes** | **kernel boundary + audit + config outside agent write authority** | **adopted** |

## 12. Maintenance

- After Xcode / simulator / Gradle upgrades: run `dsh-gate doctor`; extend `config.writeRoots` if a
  new path is denied.
- Change commands: edit `~/.config/dsh-gate/<key>/config.json` (user-owned, not in the repository).
- Upgrade the tool: update the tool checkout, then `./install.sh --root <project> --force`, or
  `launchctl kickstart -k gui/$(id -u)/com.dsh-gate.<key>`.
- Audit is not rotated automatically; archive it as needed.

## 13. Measured record (0.1.0, 2026-10-22)

Environment: macOS, Xcode 27.1 (27A9275), Node v26.8.2, iPhone 17 simulator.

| Item | Result |
|---|---|
| Install | LaunchAgent `com.dsh-gate.finecoach-2a67619b` loaded; config in `~/.config/dsh-gate/<key>/` |
| `doctor` | 7/7 PASS including `write-outside-denied` |
| Build | cold 67s, incremental 2s |
| Unit tests | 528 tests (1 skipped), 0 failures |
| Integration tests | 198 tests, 0 failures |
| `test` step total | 78s |
| Client from worktree and primary checkout | resolves the same project key |
| Rejections | `BUSY`, `SCOPE_INVALID`, `ONLY_INVALID`, not-a-git-checkout verified |
| Note | `ProcessType=Background` in the LaunchAgent plist stretched the cold build from 67s to 519s; the default Standard is correct |
