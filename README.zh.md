# dsh-gate

中文 | [English](README.md)

> **非官方工具，与 DeepSeek 无关。** 本项目解决 DeepSeek Harness（dsh）的 macOS 沙箱与本地构建工具链之间的冲突，不属于 DeepSeek 产品线。

给被自身沙箱约束的编码 agent 提供的本地构建/测试门禁。agent 不直接调用 `xcodebuild` / `gradlew`，而是调用 `dsh-gate`；真实命令由沙箱外的 daemon 在写权限受限的 Seatbelt profile 下执行，并留下审计记录。

## 为什么需要它

dsh 在 macOS 上给每条 bash 命令套 Seatbelt：

```
(allow default) (deny file-write*)
可写：workspace 根、/tmp、os.tmpdir()、/dev/null
```

该 profile 与 Xcode 工具链有两处结构性冲突（均已在本机复现）：

| 冲突 | 现象 | 原因 |
|---|---|---|
| Swift 宏插件 | `build-for-testing` 必然失败：`sandbox-exec: sandbox_apply: Operation not permitted`，随后 `SwiftUIMacros.StateMacro ... malformed response` | Xcode 会给宏插件进程再套一层 Seatbelt。外层只要有 `deny file-write*`，内层 `sandbox_apply` 就会失败；补可写路径无效（实测 9 种 profile 变体）。 |
| 测试执行 | `Pseudo Terminal Setup Error / Operation not permitted` | 测试需要 PTY（`/dev/ptmx`）和模拟器写入（`~/Library/Developer/CoreSimulator`），都在 dsh 可写集合之外。 |

dsh 的配置只有三个旋钮（沙箱模式、工作区根、审批策略），可写集合写死在代码里；headless profile 没有审批应答器，按设计 fail-closed。无人值守时 agent 无法独立完成构建+测试。

## 它做什么

- agent 继续在自己的沙箱里编辑代码；
- 构建/测试通过 `dsh-gate build|test` 交给「每个主 checkout 一个」的 daemon；
- daemon 只运行 `~/.config/dsh-gate/<project-key>/config.json` 里的固定命令模板，并给每一步套一份只允许写 worktree、DerivedData、工具链缓存和 `/dev` 的 profile；
- 配置与审计放在你的家目录，agent 没有写权限，因此改不了命令模板；
- 自检 ≠ 验收：正式门禁仍由人或编排者在宿主用标准命令执行。

## 安装

前置：macOS + Xcode + Node.js 18+（git 2.31+）；被门禁的项目是 git 仓库。

```sh
git clone <this-repo> dsh-gate
cd dsh-gate
./install.sh --root /path/to/project-checkout             # iOS（默认模板）
./install.sh --root /path/to/project --template macos     # macOS App
./install.sh --root /path/to/project --template android   # Android（Gradle）
./install.sh --root /path/to/project --dry-run            # 只打印，不写文件
```

安装会把运行文件复制到 `~/.local/share/dsh-gate`，并创建 `~/.local/bin/dsh-gate` 链接（`--prefix <dir>` 可同时改这两处）。`~/.local/bin` 在 `PATH` 里时，任何目录都能直接用 `dsh-gate`；源码 checkout 移动或删除也不影响已安装的工具。然后在项目目录里：

```sh
cd /path/to/project-checkout
dsh-gate doctor
dsh-gate build
dsh-gate test --scope unit
```

## 状态

- 版本：**0.1.0**（首个版本）。
- 平台：macOS；Node 18+；git 2.31+。
- 模板：**iOS 已实测**（FineCoach，Xcode 27.1）——LaunchAgent 安装、`doctor` 7/7、冷构建 67s、增量 2s、528 个单元测试 + 198 个集成测试全绿。macOS 与 Android 模板已提供但未在真实项目上验证；按需调整 `schemes` / `steps` / `writeRoots`。
- 规模：约 1.2k 行代码，只用 Node.js 标准库。

## 文档

- [DESIGN.md](DESIGN.md) / [DESIGN.zh.md](DESIGN.zh.md)：问题证据、架构、配置模型、权限模型、平台支持、取舍。
- [MANUAL.md](MANUAL.md) / [MANUAL.zh.md](MANUAL.zh.md)：安装、使用、多项目、排障、安全边界、卸载。

## 安全边界

内核强制的写边界 + 每次运行留审计。读与网络不受限制。构建脚本和测试代码本身可执行任意命令，所以边界落在 Seatbelt profile 上，而不是命令白名单。单机单用户。详见 [MANUAL.zh.md](MANUAL.zh.md) 第 8 节。
