# dsh-gate 设计

中文 | [English](DESIGN.md)

> 版本 0.1.0 · 2026-10-22 · 非官方工具，与 DeepSeek 无关。
> 代码：仓库根目录 · 用户手册：[MANUAL.zh.md](MANUAL.zh.md)

## 1. 背景：为什么存在

FineCoach 用 dsh（DeepSeek harness）做实现、用 Claude Code 做编排与验收。dsh 在 macOS 上给每条 bash 命令套 Seatbelt：

```
(allow default) (deny file-write*)
可写：workspaceRoot、/tmp、os.tmpdir()、/dev/null
```

该 profile 与 Xcode 工具链有两处结构性冲突，均已在本机复现：

| 冲突 | 现象 | 原因 |
|---|---|---|
| Swift 宏插件 | `xcodebuild build-for-testing` 必然失败：`sandbox-exec: sandbox_apply: Operation not permitted`，随后 `SwiftUIMacros.StateMacro ... malformed response` | Xcode 会给宏插件进程再套一层 `sandbox-exec`。外层只要存在 `deny file-write*`，内层 `sandbox_apply` 就失败。九种 profile 变体（补 `~/Library`、`/var/folders`、`/var/db`、`subpath "/"`、局部 deny）全部失败：补可写路径无效。 |
| 测试执行 | `xcodebuild test-without-building`：`Pseudo Terminal Setup Error / Operation not permitted` | 测试需要 PTY（`/dev/ptmx`）和模拟器写入（`~/Library/Developer/CoreSimulator`），都在 dsh 可写集合之外。 |

dsh 的配置只暴露沙箱模式、工作区根和审批策略；可写集合写死在代码里。headless profile 没有审批应答器，会 fail-closed。无人值守的 agent 无法独立完成构建+测试。

**结论：**把唯一的特权动作——运行构建/测试工具链——移出 agent 沙箱，交给一个更小、可审计的执行者。不要放宽 agent 的写权限。

## 2. 目标与非目标

目标：

- 让被沙箱约束的 agent 在一个会话内完成 构建 → 测试 → 读日志 → 改代码 的闭环。
- 用内核（Seatbelt）强制能力边界，而不是命令白名单。
- agent 的写权限仍限制在工作区；不改 dsh 配置、不碰 `~/.dsh`。
- 每次运行和每次拒绝都留审计。
- 支持多项目、多工具链（iOS / macOS / Android），每个项目一个实例。
- 实现小到可以完整审查。

非目标：

- 不做完整 CI（无远端、无多并发槽、无矩阵、无缓存管理）。
- 不做读/网络限制（与 dsh 现有 bash 姿态一致）。
- 不替代验收门禁（自检 ≠ 验收，见第 8 节）。
- 不提交、不修改仓库受跟踪文件。

## 3. 架构

```
<tool checkout>/                     dsh-gate 仓库根（推荐布局）
  bin/, client/, daemon/, lib/, templates/, launchd/, *.sh

~/.config/dsh-gate/<key>/           agent 写权限之外的状态目录
  config.json                       项目命令模板（install.sh 写入）
  logs/*.log                        每次运行的完整输出
  audit.jsonl                       审计
  run/gate.sock, gate.pid           本地 socket（0600）

agent（沙箱内） -- dsh-gate build|test --> daemon（沙箱外，每项目一个）
                                            `- sandbox-exec -p <profile> <template argv>`
Claude（宿主）  -- dsh-gate status|audit|doctor
```

| 组件 | 文件 | 职责 |
|---|---|---|
| 客户端 | `bin/dsh-gate`、`client/dsh-gate.mjs` | 用 `git rev-parse --git-common-dir` 找到主 checkout，推导项目 key，连接该项目 socket，转发输出，镜像退出码 |
| daemon | `daemon/dsh-gate-daemon.mjs` | 每项目一个实例；校验请求、读取用户配置、生成固定 argv、套 Seatbelt、写审计 |
| 共享规则 | `lib/common.mjs` | 项目 key、配置读取、可写根、Seatbelt profile、占位符解析、命令计划 |
| 模板 | `templates/{ios,macos,android}.json` | 安装时渲染到 `~/.config/dsh-gate/<key>/config.json` |
| 安装 | `install.sh`、`uninstall.sh`、`selftest.sh` | LaunchAgent（`com.dsh-gate.<key>`）、首次生成配置、自检 |

**配置与审计在 agent 的写权限之外。** agent 能写仓库（workspace-write），所以命令模板、审计和日志不能放在仓库里，统一放在 `~/.config/dsh-gate/`。仓库内的 `templates/` 只在安装时被读取，修改它不会影响已安装的 daemon。

**项目 key：**`<仓库目录名>-<sha1(主 checkout realpath)[0:8]>`，例如 `finecoach-2a67619b`。同一 checkout 的任意 worktree 都通过 git common dir 解析到同一个 key，所以 `dsh-gate` 在每个 worktree 里都能用。

## 4. 配置模型

`~/.config/dsh-gate/<key>/config.json`（由 install.sh 渲染，之后用户可编辑；agent 不可写）：

```jsonc
{
  "version": 1,
  "root": "/abs/primary/checkout",              // 必须与 daemon root 一致
  "project": "ios/FineCoach.xcodeproj",         // 可选；用于 {project}
  "schemes": { "build": "FineCoach", "unit": "FineCoachTests" }, // 可选；{scheme:name}
  "destination": "platform=iOS Simulator,id=...", // 可选；{destination}
  "derivedDataRoot": "/tmp/dsh-gate",           // 每个 worktree 一个哈希子目录
  "allowedCwdRoots": [".", ".worktrees", ".agents/worktrees"],
  "writeRoots": ["~/Library/Developer", "~/Library/Logs", "~/Library/Caches"],
  "steps": {
    "build": [ { "label": "build-for-testing", "argv": ["/usr/bin/xcodebuild", "..."] } ],
    "test":  { "unit": [ "..." ], "integration": [ "..." ] }  // 键名即 --scope 取值
  },
  "timeoutsMs": { "build": 900000, "test": 1800000 },
  "testStopOnFirstFailure": false
}
```

由 daemon 解析的占位符（客户端无法注入）：

| 占位符 | 值 |
|---|---|
| `{workspace}` | 请求 cwd（canonical） |
| `{root}` | 项目主 checkout |
| `{project}` | `{workspace}/<config.project>` |
| `{derivedData}` | `<derivedDataRoot>/<sha1(workspace)[0:12]>` |
| `{destination}` | `config.destination` |
| `{scheme:<name>}` | `config.schemes[name]` |
| `{only}` | 客户端 `--only` 过滤串；为空时整个 argv 元素被丢弃 |

未解析的占位符或空参数会被拒绝（`CONFIG_INVALID`），不会有半截字符串进入 shell。

**scope：**`steps.test` 的键就是 `--scope` 的取值；`all`（默认）按配置顺序跑全部。`--only` 只对包含 `{only}` 的步骤生效，否则返回 `ONLY_UNSUPPORTED`。

## 5. 权限模型

### 5.1 Seatbelt profile

每次运行生成（`lib/common.mjs: seatbeltProfile`）：

```
(version 1)
(allow default)                                   ; 读、网络、mach 不受限
(deny file-write*)                                ; 写默认全拒
(allow file-write* (subpath <workspace>)          ; 被构建的 checkout
                   (subpath <derivedData>)         ; /tmp/dsh-gate/<hash>
                   (subpath "/tmp") (subpath <tmpdir>) (subpath "/dev")
                   (subpath ~/Library/Developer) (subpath ~/Library/Logs)
                   (subpath ~/Library/Caches)
                   <config.writeRoots...>)         ; 各模板的工具链路径
```

**为什么 Xcode 模板必须保留 `OTHER_SWIFT_FLAGS=-disable-sandbox`：**任何带 `(deny file-write*)` 的外层 Seatbelt 都会让 Xcode 的宏插件无法再套自己的沙箱（第 1 节）。该开关只关闭编译器子进程的沙箱，不会削弱上面的文件边界；它只出现在 daemon 生成的自检命令里，绝不进入验收门禁。

Android 模板没有嵌套沙箱问题，只需要更宽的可写根（`~/.gradle`、`~/.android`、Android SDK）。这正是通用门禁层与 Xcode 专用补丁的区别。

### 5.2 边界验证

`dsh-gate doctor` 会执行 `write-outside-denied`：在 profile 内尝试写 `~/.dsh-gate-doctor-*`，要求写入被拒且文件不存在。

### 5.3 不保护什么

- 读与网络不受限制（与 dsh 的 bash 沙箱姿态一致）。
- 构建脚本和测试代码本身可执行任意命令；边界在 profile 上，不在命令白名单上。
- 单机单用户；daemon 以你的身份运行，socket 权限 0600。
- `~/.config/dsh-gate/` 防的是沙箱内的 agent，不是以你的用户身份运行的未沙箱进程。

## 6. 请求协议

Unix socket（0600），一行一个 JSON 请求：

```json
{ "v": 1, "op": "build|test|doctor|status", "cwd": "/abs/path", "pid": 1234,
  "scope": "all", "only": "FineCoachTests/NumberFormatScanTests" }
```

响应事件：`log`、`status`、`doctor`、`error`、`exit`。

拒绝码：`CONFIG_MISSING`、`CONFIG_INVALID`、`CONFIG_ROOT_MISMATCH`、`CWD_INVALID`、`CWD_NOT_ALLOWED`、`SCOPE_INVALID`、`ONLY_INVALID`、`ONLY_UNSUPPORTED`、`NO_STEPS`、`BAD_OP`、`BAD_REQUEST`、`BAD_VERSION`、`BUSY`（exit 75）。被拒绝的请求同样写审计。

## 7. 审计与日志

- 审计：`~/.config/dsh-gate/<key>/audit.jsonl`，每请求一行（`ts`、`id`、`op`、`scope`、`only`、`cwd`、`steps`、`exit`、`durationMs`、`log`）；被拒请求记 `exit: null` 和 `error`。
- 日志：`~/.config/dsh-gate/<key>/logs/<时间>-<id>-<op>.log`。
- daemon 输出：LaunchAgent 的 `logs/daemon.out.log` / `daemon.err.log`。

## 8. 自检 ≠ 验收

| 层级 | 谁跑 | 命令 | 目的 |
|---|---|---|---|
| 自检 | agent | `dsh-gate build` / `dsh-gate test`（daemon 沙箱；Xcode 模板带 `-disable-sandbox`） | 消除编译/测试往返 |
| 验收 | 人或宿主上的编排者 | 标准命令，**不带** `-disable-sandbox` | 唯一有效门禁；审查 diff 与日志 |

审计让编排者可以低成本确认只跑了构建/测试，但审计不是验收证据。

## 9. 失败模式与降级

| 情况 | 现象 | 处理 |
|---|---|---|
| daemon 未运行 | 客户端 exit 69 并给安装提示 | agent 报告 BLOCKED；编排者在宿主跑门禁 |
| 配置缺失或损坏 | `CONFIG_MISSING` / `CONFIG_INVALID`，exit 2 | 重新安装或修配置 |
| 请求 cwd 越界 | `CWD_NOT_ALLOWED`，exit 2，留审计 | 修正 cwd |
| daemon 忙 | `BUSY`，exit 75 | 串行重试 |
| 步骤失败 | 原样回传日志和退出码 | agent 读日志改代码 |
| 超时 | 进程组 SIGTERM 后 SIGKILL，非零退出 | 用 `--only` 缩小范围或调大 `timeoutsMs` |
| 新工具链路径被挡 | `Operation not permitted` 指向新路径 | 加入 `config.writeRoots` 后重启 daemon |
| launchd 给构建降优先级 | 同一条命令从 67s 变成 519s | 不要在 plist 里设 `ProcessType=Background`，保持默认 Standard |

## 10. 平台支持

| 模板 | 状态 | 说明 |
|---|---|---|
| `ios` | **已实测**（本仓库，Xcode 27.1） | 模拟器 destination、PTY、宏开关 |
| `macos` | 模板已提供，未在本机实测（本仓库无 macOS target） | `platform=macOS`，不需要模拟器和 PTY；scheme 名需按项目调整 |
| `android` | 模板已提供，未在本机实测（未验证 Gradle/SDK/AVD） | Gradle 无嵌套沙箱问题；`writeRoots` 要覆盖 `~/.gradle`、SDK 和 AVD；instrumentation 需要模拟器或真机 |

接入新项目：`install.sh --template macos --project <xcodeproj>`，或复制 `templates/android.json` 并调整 `steps` / `writeRoots`。

## 11. 备选方案

| 方案 | 单会话闭环 | 安全 | 结论 |
|---|---|---|---|
| 会话级 `danger-full-access` | 是 | 整机可写、无审计 | 否决 |
| 自定义 headless 审批应答器插件 | 是 | 审批请求不含命令参数，只能盲批准；需要改 `~/.dsh` | 否决 |
| 拆成「实现会话 + 只跑命令的验证会话」 | 否 | 修测试代码要回退到实现会话 | 否决 |
| 独立 macOS 用户 / VM | 是 | 强 | 备选；运维成本更高 |
| **本设计（每项目一个 daemon + 自定 profile）** | **是** | **内核边界 + 审计 + 配置在 agent 写权限之外** | **采用** |

## 12. 维护

- Xcode / 模拟器 / Gradle 升级后：跑 `dsh-gate doctor`；若出现新的被拒路径，补 `config.writeRoots`。
- 改命令：直接编辑 `~/.config/dsh-gate/<key>/config.json`（用户文件，不进仓库）。
- 升级工具：更新源码 checkout 后 `./install.sh --root <project>`（重新复制运行文件到 `<prefix>/share/dsh-gate` 并重载 daemon）。
- 审计不自动轮转，按需归档。

## 13. 实测记录（0.1.0，2026-10-22）

环境：macOS、Xcode 27.1（27A9275）、Node v26.8.2、iPhone 17 模拟器。

| 项 | 结果 |
|---|---|
| 安装 | LaunchAgent `com.dsh-gate.finecoach-2a67619b` 已加载；配置在 `~/.config/dsh-gate/<key>/` |
| `doctor` | 7/7 PASS，含 `write-outside-denied` |
| 构建 | 冷构建 67s，增量 2s |
| 单元测试 | 528 个（1 skipped），0 failures |
| 集成测试 | 198 个，0 failures |
| `test` 步骤总计 | 78s |
| worktree 与主 checkout 调用 | 解析到同一项目 key |
| 拒绝路径 | `BUSY`、`SCOPE_INVALID`、`ONLY_INVALID`、非 git 目录 已验证 |
| 备注 | LaunchAgent plist 里的 `ProcessType=Background` 会把冷构建从 67s 拉长到 519s；默认 Standard 才是正确配置 |
