# dsh-gate Manual

> **Unofficial tool. Not affiliated with DeepSeek.** It addresses a conflict between the
> DeepSeek Harness (dsh) sandbox and macOS build toolchains.
> Design details: [DESIGN.md](DESIGN.md).

## 1. What it is

One user-level background process per project (a LaunchAgent) plus the `dsh-gate` command:

```
dsh-gate build                      run the project's configured build steps in the daemon sandbox
dsh-gate test [--scope S] [--only F]  run the configured test steps
dsh-gate status                     show this project's daemon state and config
dsh-gate doctor                     self-check: config, commands, write boundary, simulator
dsh-gate audit [--lines N]          show the audit trail
```

A sandboxed agent no longer calls `xcodebuild` / `gradlew` directly; it calls `dsh-gate`. The daemon
runs the real command outside the agent sandbox under a write-restricted Seatbelt profile. **The
daemon only runs the fixed commands from the config file; the agent cannot make it execute arbitrary
commands and cannot edit that config.**

## 2. Prerequisites

- macOS with Xcode (and command line tools)
- Node.js 18+ (`brew install node`)
- The tool checkout (recommended: a separate repository; a `.dsh/gate/` copy inside the gated
  project also works for validation)
- git 2.31+ (the client uses `git rev-parse --path-format=absolute --git-common-dir`)

## 3. Install (once per project, run by a human)

> Warning: run this from a normal Terminal, not from inside an agent sandbox. The daemon must be
> able to apply its own Seatbelt profile around project commands.

When the tool lives in its own repository, point `--root` at the gated project checkout (recommended):

```sh
cd <dsh-gate-checkout>
./install.sh --root /path/to/project-checkout            # iOS (auto-detects the project and simulator)
./install.sh --root /path/to/project --dry-run           # print root/key/rendered config and plist only
./install.sh --root /path/to/project --template macos    # macOS app (auto-detects *.xcodeproj)
./install.sh --root /path/to/project --template android  # Android (Gradle template; adapt steps)
```

You can also `cd` into the project checkout and call `install.sh` without `--root` (the current
project is inferred):

```sh
cd /path/to/project-checkout
<dsh-gate-checkout>/install.sh
```

Install does the following:

1. Determines the project's primary checkout (`--root` or the current directory) and derives the
   project key (for example `finecoach-2a67619b`);
2. Renders `~/.config/dsh-gate/<key>/config.json` (kept if it already exists; `--force` overwrites);
3. Writes and loads the LaunchAgent `~/Library/LaunchAgents/com.dsh-gate.<key>.plist`;
4. Links `~/bin/dsh-gate` when `~/bin` exists;
5. Prints the state and the next step.

`--no-launchctl` writes the config and plist without loading the LaunchAgent (for validation or
testing).

### 3.1 Why the config is not in the repository

Command templates, audit, and logs live in `~/.config/dsh-gate/<key>/`. The agent can write the
repository (workspace-write) but not the home directory. Keeping command templates in the repository
would let the agent rewrite them and make the daemon execute arbitrary commands. The in-repo
`templates/` are read only at install time.

### 3.2 Config file (user-owned; edit directly)

| Field | Meaning |
|---|---|
| `root` | absolute primary checkout path; must match the daemon root |
| `project` | relative Xcode project path (`{project}`) |
| `schemes` | named schemes (`{scheme:name}`) |
| `destination` | xcodebuild destination (`{destination}`); may be omitted for Android |
| `derivedDataRoot` | per-worktree hashed subdirectory; default `/tmp/dsh-gate` |
| `allowedCwdRoots` | checkouts allowed to send requests (relative to `root` or absolute) |
| `writeRoots` | extra writable paths for child processes (toolchain caches, simulators) |
| `steps.build` | array of build steps |
| `steps.test.<scope>` | test steps; each key is a `--scope` value |
| `timeoutsMs` | build / test timeouts |
| `testStopOnFirstFailure` | stop after the first failing scope |

Placeholders: `{workspace}`, `{root}`, `{project}`, `{derivedData}`, `{destination}`,
`{scheme:name}`, `{only}`. An argv element containing `{only}` is dropped entirely when no filter is
given.

## 4. First checks

```sh
dsh-gate doctor        # config, root, command executability, write boundary, simulator
dsh-gate build
dsh-gate test --scope unit
```

`dsh-gate test` starts the simulator for iOS; the macOS template does not need one.

## 5. Daily usage (agent side)

```sh
cd <repository or any worktree>
dsh-gate build
dsh-gate test --scope unit
dsh-gate test --scope integration
dsh-gate test --scope unit --only FineCoachTests/NumberFormatScanTests
```

Rules:

- The cwd must be the primary checkout or an allowed worktree, otherwise `CWD_NOT_ALLOWED` (exit 2).
  The client finds the primary checkout through git, so it works from any worktree.
- Exit codes mirror the build command; daemon unreachable is 69; rejected request is 2; busy is 75.
- Full output is under `~/.config/dsh-gate/<key>/logs/`; the audit trail is `.../audit.jsonl`.
- A daemon runs one request at a time (`BUSY` is intentional).

### 5.1 Snippet for the agent prompt

```markdown
## Verification
- Run lint locally (it is unaffected by the sandbox).
- Use dsh-gate for build/test instead of running xcodebuild/gradlew directly:
  - `dsh-gate build`
  - `dsh-gate test --scope unit` / `--scope integration`
  - while iterating, add `--only <scheme>/<Class>` to run a single class
- Exit codes match the build command; the full log path is printed at the end of the command.
- dsh-gate is a self-check, not the acceptance gate; acceptance is run on the host with standard
  commands.
- Never add `-disable-sandbox` to any official gate command.
```

## 6. Multiple projects

One instance per project: separate `~/.config/dsh-gate/<key>/`, separate LaunchAgent
(`com.dsh-gate.<key>`), separate socket and audit. Projects cannot see or operate on each other.

`~/bin/dsh-gate` is a single symlink (pointing at the last installed checkout). With several
projects, either keep the tool versions identical or call each checkout's
`.dsh/gate/bin/dsh-gate` by absolute path in the task instructions.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cannot reach the daemon ... ENOENT` | not installed or not running: `./install.sh` or `launchctl kickstart -k gui/$(id -u)/com.dsh-gate.<key>` |
| exit 69 | same as above: the client cannot find the socket |
| exit 68 `not inside a git checkout` | the cwd is not in any git repository; `cd` back into the project or a worktree |
| `CWD_NOT_ALLOWED` | the directory belongs to the repository but is not under an `allowedCwdRoots` entry |
| `CONFIG_MISSING` | not installed yet, or `~/.config/dsh-gate/<key>/config.json` was deleted |
| `CONFIG_ROOT_MISMATCH` | the config root and the daemon root differ (reinstall or fix the config) |
| `SCOPE_INVALID` | `--scope` is not a `steps.test` key (or `all`) |
| `ONLY_INVALID` / `ONLY_UNSUPPORTED` | the filter is invalid, or the template has no `{only}` placeholder |
| `BUSY` | wait for the current request (single slot) |
| `sandbox-exec: ... Operation not permitted` at a new path | the toolchain moved after an upgrade; add the path to `writeRoots` and restart the daemon |
| `sandbox-exec: sandbox_apply: Operation not permitted` | the Xcode template lost `OTHER_SWIFT_FLAGS=-disable-sandbox` |
| Tests hang or time out | narrow with `--only`, or raise `timeoutsMs` |
| Build is unexpectedly slow (minutes) | the LaunchAgent plist sets `ProcessType=Background`, which the system throttles; use the default Standard and restart |
| Android build cannot find the SDK | add the SDK path to `writeRoots`; instrumentation needs an emulator or device |

## 8. Security notes

**Kernel-enforced:** child processes may write only the worktree, DerivedData, `/tmp`, the system
temp directory, `~/Library/{Developer,Logs,Caches}`, `/dev`, and the paths listed in `writeRoots`.
Writes to `~/.ssh`, `~/.dsh`, other repositories, and system directories are denied. Every run and
every rejection is audited.

**Outside the boundary:** reads and network are unrestricted; build scripts and test code can
execute arbitrary commands, so the boundary lives in the profile rather than in a command allowlist;
single user, single machine; `~/.config/dsh-gate/` is not writable by a sandboxed agent, but it is
writable by you and by any unsandboxed process running as your user.

## 9. Uninstall

```sh
cd /path/to/project-checkout
<dsh-gate-checkout>/uninstall.sh                 # remove the LaunchAgent and socket; keep config/logs/audit
<dsh-gate-checkout>/uninstall.sh --purge         # also delete ~/.config/dsh-gate/<key>/
<dsh-gate-checkout>/uninstall.sh --dry-run       # print the label/plist/directory that would be removed
```

When running from the tool checkout, pass `--root <project-checkout>`.

## 10. Maintenance

- After Xcode / simulator / Gradle upgrades: `dsh-gate doctor`; extend `writeRoots` if needed.
- Upgrade the tool: update the tool checkout, then `./install.sh --root <project> --force` (or
  `--no-launchctl` and restart the daemon yourself).
- Audit is not rotated automatically; archive it as needed.
