# dsh-gate 用户手册

中文 | [English](MANUAL.md)

> **非官方工具，与 DeepSeek 无关。** 它解决的是 DeepSeek Harness（dsh）沙箱与 macOS 构建工具链之间的冲突。
> 设计细节见 [DESIGN.zh.md](DESIGN.zh.md)。

## 1. 它是什么

每个项目一个用户级后台进程（LaunchAgent），加上 `dsh-gate` 命令：

```
dsh-gate build                     在 daemon 沙箱里运行项目配置的构建步骤
dsh-gate test [--scope S] [--only F] 运行项目配置的测试步骤
dsh-gate status                    查看本项目的 daemon 状态和配置
dsh-gate doctor                    自检：配置、命令、写边界、模拟器
dsh-gate audit [--lines N]         查看审计
```

被沙箱约束的 agent 不再直接调用 `xcodebuild` / `gradlew`，而是调用 `dsh-gate`；真实命令由 daemon 在 agent 沙箱外用受限 Seatbelt profile 执行。**daemon 只运行配置文件里的固定命令；agent 既不能让它执行任意命令，也不能修改这份配置。**

## 2. 前置条件

- macOS + Xcode（含命令行工具）
- Node.js 18+（`brew install node`）
- 工具 checkout（推荐独立仓库；项目内 `.dsh/gate/` 的验证副本也可用）
- git 2.31+（客户端使用 `git rev-parse --path-format=absolute --git-common-dir`）

## 3. 安装（每个项目一次，由人执行）

> 警告：必须在普通 Terminal 里运行，不要从 agent 沙箱里安装。daemon 需要能围绕项目命令套自己的 Seatbelt profile。

工具在独立仓库时，用 `--root` 指向被门禁的项目（推荐）：

```sh
cd <dsh-gate-checkout>
./install.sh --root /path/to/project-checkout            # iOS（自动探测项目和模拟器）
./install.sh --root /path/to/project --dry-run           # 只打印 root/key/渲染后的配置和 plist
./install.sh --root /path/to/project --template macos    # macOS App（自动探测 *.xcodeproj）
./install.sh --root /path/to/project --template android  # Android（Gradle 模板；按项目调整 steps）
```

也可以先 `cd` 到项目目录，不带 `--root` 调用（会自动推断当前项目）：

```sh
cd /path/to/project-checkout
<dsh-gate-checkout>/install.sh
```

安装会：

1. 确定被门禁项目的主 checkout（`--root` 或当前目录），推导项目 key（例如 `finecoach-2a67619b`）；
2. 渲染 `~/.config/dsh-gate/<key>/config.json`（已存在则保留；`--force` 覆盖）；
3. 写入并加载 LaunchAgent `~/Library/LaunchAgents/com.dsh-gate.<key>.plist`；
4. 若存在 `~/bin`，创建 `~/bin/dsh-gate` 链接；
5. 打印状态和下一步。

`--no-launchctl` 只写配置和 plist、不加载 LaunchAgent（用于验证或测试）。

### 3.1 为什么配置不在仓库里

命令模板、审计和日志都在 `~/.config/dsh-gate/<key>/`。agent 能写仓库（workspace-write）但不能写家目录。命令模板若留在仓库，agent 就能改写它，让 daemon 执行任意命令。仓库里的 `templates/` 只在安装时读取。

### 3.2 配置文件（用户所有，可直接编辑）

| 字段 | 含义 |
|---|---|
| `root` | 主 checkout 绝对路径；必须与 daemon root 一致 |
| `project` | Xcode 项目相对路径（`{project}`） |
| `schemes` | 命名 scheme（`{scheme:name}`） |
| `destination` | xcodebuild destination（`{destination}`）；Android 可省略 |
| `derivedDataRoot` | 每个 worktree 的哈希子目录；默认 `/tmp/dsh-gate` |
| `allowedCwdRoots` | 允许发起请求的 checkout（相对 `root` 或绝对路径） |
| `writeRoots` | 子进程额外可写路径（工具链缓存、模拟器等） |
| `steps.build` | 构建步骤数组 |
| `steps.test.<scope>` | 测试步骤；每个键是一个 `--scope` 取值 |
| `timeoutsMs` | 构建/测试超时 |
| `testStopOnFirstFailure` | 第一个失败的 scope 后是否停止 |

占位符：`{workspace}`、`{root}`、`{project}`、`{derivedData}`、`{destination}`、`{scheme:name}`、`{only}`。含 `{only}` 的 argv 元素在没有过滤串时会被整项丢弃。

## 4. 首次检查

```sh
dsh-gate doctor        # 配置、root、命令可执行性、写边界、模拟器
dsh-gate build
dsh-gate test --scope unit
```

iOS 的 `dsh-gate test` 会启动模拟器；macOS 模板不需要。

## 5. 日常使用（agent 侧）

```sh
cd <仓库或任意 worktree>
dsh-gate build
dsh-gate test --scope unit
dsh-gate test --scope integration
dsh-gate test --scope unit --only FineCoachTests/NumberFormatScanTests
```

规则：

- cwd 必须是主 checkout 或允许的 worktree，否则 `CWD_NOT_ALLOWED`（exit 2）。客户端通过 git 找主 checkout，所以在任何 worktree 里都能用。
- 退出码与构建命令一致；daemon 不可达为 69；请求被拒为 2；daemon 忙为 75。
- 完整输出在 `~/.config/dsh-gate/<key>/logs/`；审计在 `.../audit.jsonl`。
- 一个 daemon 同一时间只跑一个请求（`BUSY` 是有意设计）。

### 5.1 给 agent 的提示词片段

```markdown
## 验证方式
- lint 本地自己跑（不受沙箱影响）。
- 构建/测试用 dsh-gate，不要直接跑 xcodebuild/gradlew：
  - `dsh-gate build`
  - `dsh-gate test --scope unit` / `--scope integration`
  - 迭代时可加 `--only <scheme>/<Class>` 只跑一个类
- 退出码与构建命令一致；完整日志路径会在命令末尾打印。
- dsh-gate 是自检，不是验收门禁；验收由宿主用标准命令执行。
- 不要把 `-disable-sandbox` 写进任何正式门禁命令。
```

## 6. 多项目

每个项目一个实例：独立的 `~/.config/dsh-gate/<key>/`、独立的 LaunchAgent（`com.dsh-gate.<key>`）、独立的 socket 和审计。项目之间互不可见、互不可操作。

`~/bin/dsh-gate` 只有一个软链接（指向最后安装的 checkout）。多项目时，要么保证各 checkout 的工具版本一致，要么在任务说明里用绝对路径调用各自 checkout 的 `.dsh/gate/bin/dsh-gate`。

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| `cannot reach the daemon ... ENOENT` | 未安装或未运行：`./install.sh` 或 `launchctl kickstart -k gui/$(id -u)/com.dsh-gate.<key>` |
| exit 69 | 同上：客户端找不到 socket |
| exit 68 `not inside a git checkout` | 当前目录不在任何 git 仓库里；`cd` 回项目或其 worktree |
| `CWD_NOT_ALLOWED` | 目录属于该仓库，但不在 `allowedCwdRoots` 允许的根下 |
| `CONFIG_MISSING` | 还未安装，或 `~/.config/dsh-gate/<key>/config.json` 被删除 |
| `CONFIG_ROOT_MISMATCH` | 配置的 root 与 daemon 的 root 不一致（重装或修配置） |
| `SCOPE_INVALID` | `--scope` 不是 `steps.test` 的键（或 `all`） |
| `ONLY_INVALID` / `ONLY_UNSUPPORTED` | 过滤串非法，或模板没有 `{only}` 占位符 |
| `BUSY` | 等当前请求结束（单并发） |
| `sandbox-exec: ... Operation not permitted` 指向新路径 | 工具链升级后路径变化；加入 `writeRoots` 并重启 daemon |
| `sandbox-exec: sandbox_apply: Operation not permitted` | Xcode 模板丢了 `OTHER_SWIFT_FLAGS=-disable-sandbox` |
| 测试卡住或超时 | 用 `--only` 缩小范围，或调大 `timeoutsMs` |
| 构建异常慢（数分钟） | LaunchAgent plist 设了 `ProcessType=Background` 被系统节流；改回默认 Standard 后重启 |
| Android 找不到 SDK | 把 SDK 路径加入 `writeRoots`；instrumentation 需要模拟器或真机 |

## 8. 安全说明

**内核强制：**子进程只能写 worktree、DerivedData、`/tmp`、系统临时目录、`~/Library/{Developer,Logs,Caches}`、`/dev` 以及 `writeRoots` 列出的路径。写 `~/.ssh`、`~/.dsh`、其他仓库和系统目录会被拒绝。每次运行和每次拒绝都写审计。

**边界之外：**读与网络不受限制；构建脚本和测试代码本身可执行任意命令，所以边界在 profile 上，不在命令白名单上；单机单用户；`~/.config/dsh-gate/` 对沙箱内的 agent 不可写，但对以你的用户身份运行的未沙箱进程可写。

## 9. 卸载

```sh
cd /path/to/project-checkout
<dsh-gate-checkout>/uninstall.sh                 # 移除 LaunchAgent 和 socket，保留 config/logs/audit
<dsh-gate-checkout>/uninstall.sh --purge         # 连 ~/.config/dsh-gate/<key>/ 一起删
<dsh-gate-checkout>/uninstall.sh --dry-run       # 只打印将删除的 label/plist/目录
```

在工具 checkout 里执行时，用 `--root <项目 checkout>` 指定目标。

## 10. 维护

- Xcode / 模拟器 / Gradle 升级后：`dsh-gate doctor`；必要时补 `writeRoots`。
- 升级工具：更新工具 checkout 后 `./install.sh --root <project> --force`（或 `--no-launchctl` 后自行重启 daemon）。
- 审计不自动轮转，按需归档。
