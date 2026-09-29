# codex-wb-dispatch

**这个仓库只做一件事：让 Codex 能指挥 WorkBuddy（WB）干活。**
和任何具体项目、任何业务无关。装好之后，你在 Codex 里说一句话，它会自动把能外派的活丢给 WB 执行，再把结果带回来。

- 适用对象：**刚下载好 Codex 和 WorkBuddy，想打通这条链路的人**
- 预计耗时：依赖项都齐的话 10 分钟；从零开始 30–40 分钟
- 零依赖：桥脚本是单个 `.mjs` 文件，不需要 `npm install`

---

## 零、先过依赖项清单

**每一项都必须 ✅，才能进第一节。** 有 ❌ 的直接点开对应的"打通方法"。

| # | 依赖项 | 怎么查 | 打通方法 |
|---|---|---|---|
| 1 | Node.js（≥ 20） | `node -v` | [附录 A](#附录-a装-nodejs) |
| 2 | WorkBuddy 桌面端，已登录 | `ls /Applications/WorkBuddy.app` | [附录 B](#附录-b装-workbuddy-并让命令行独立登录) |
| 3 | **WB 命令行能独立登录**（最容易漏，漏了后面必挂） | `ls ~/.local/bin/wb-codebuddy`<br>或 `ls "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"` | [附录 B](#附录-b装-workbuddy-并让命令行独立登录) |
| 4 | Codex 已安装并登录 | `codex --version` | [附录 C](#附录-c装-codex) |

> 为什么第 3 项单列：**桌面端登录 ≠ 命令行已登录**。命令行没独立登录过的话，调用它会表现成"零输出、一直不返回"，很难猜。

一条命令查完 1、4：

```bash
node -v && codex --version
```

---

## 一、这套东西怎么跑的

```
你 ──> Codex（规划 / 路由 / 验收）
         │  通过 MCP 工具调用
         ▼
      workbuddy-bridge（本仓库 bridge/server.mjs，零依赖）
         │  spawn 命令行
         ▼
      WorkBuddy CLI（codebuddy / wb-codebuddy）
         │
         ▼
      在你指定的目录里真干活，结果原样返回
```

桥解决三件事：
1. **注册一次永久可用**——不用每次手拼命令行；
2. **模型和权限旗标封在服务端**——不被过期的写法干扰；
3. **串行队列**——两个任务落到同一目录会抢同一个本地端口而互相打死，桥统一排队，从根上避免。

---

## 二、安装（三步）

### 第 1 步：放好桥脚本

```bash
mkdir -p ~/mcp-servers/workbuddy-bridge
cp bridge/server.mjs ~/mcp-servers/workbuddy-bridge/server.mjs
chmod +x ~/mcp-servers/workbuddy-bridge/server.mjs
```

（位置随意，记住绝对路径，下一步要用。）

### 第 2 步：在 Codex 里注册 MCP

编辑 `~/.codex/config.toml`，加上这段（**把三个路径换成你自己的**）：

```toml
[mcp_servers.workbuddy]
enabled = true
command = "/opt/homebrew/bin/node"          # 你的 node 绝对路径：which node
args = ["/Users/你的用户名/mcp-servers/workbuddy-bridge/server.mjs"]
startup_timeout_sec = 30.0
tool_timeout_sec = 1860.0                    # 31 分钟，长任务要留足

[mcp_servers.workbuddy.env]
WORKBUDDY_CLI = "/Users/你的用户名/.local/bin/wb-codebuddy"   # 依赖项 3 里确认过的那把
WORKBUDDY_MODEL = "hy3"                                      # 默认模型，见第四节
WORKBUDDY_TIMEOUT_MS = "1800000"
```

也可以直接抄 [`config-snippet.toml`](./config-snippet.toml)。

写完**完全重启 Codex**（不是新开一个窗口），MCP 才会加载。

### 第 3 步：验通

```bash
bash scripts/health-check.sh
```

五项逐项体检：node / 桥文件 / config 注册 / WB 命令行 / 真实调用一次。全绿之后再让 Codex 跑一个小任务（例如"读某个文件并报告第一行"），**对照源文件确认结果真实**——这才算真装好。

只想查配置不想真调 WB：`bash scripts/health-check.sh --static`

---

## 三、怎么用它派活

装好后 Codex 会看到两个工具：

| 工具 | 作用 | 什么时候用 |
|---|---|---|
| `workbuddy_health` | 体检：用一个最小任务试通 | 每次会话首次派活前 |
| `run_workbuddy` | 真派活 | 把自足任务书交给 WB |

**任务书必须自足**——WB 看不到你和 Codex 的对话。模板：

```
背景：<为什么做这件事，3–5 句>
目标：<要什么结果>
允许的输入：<文件/链接/数据在哪>
禁止范围：<不许碰什么>
输出路径：<必须落到哪个文件>
验收标准：<怎么算做完，可判定>
证据要求：<要引用来源/命令/截图>
卡住怎么办：<报错就停下并说明，不要自己改目标>
```

真实例子（假设你在整理一份公开资料）：

```
背景：我要把三家同类产品的公开定价信息整理成一张表，人工翻官网太慢。
目标：产出对比表：产品名 / 免费额度 / 付费档位价格 / 是否有年付折扣。
允许的输入：三家官网的公开页面。
禁止范围：不要注册账号、不要提交任何表单。
输出路径：写到 ./output/pricing-compare.md
验收标准：三家的四个字段都有值，每个值后面标出处链接；查不到的写"未公开"。
证据要求：每个数字附官网链接。
卡住怎么办：页面打不开就在报告里标明，不要用第三方二手数据顶替。
```

**第一次使用建议先跑 `workbuddy_health`**（显式传项目目录和模型），确认链路通再派真活。

> ⚠️ 传 `cwd` 别忘了。不传的话 WB 会在桥进程的当前目录里写文件，找都找不着。

---

## 四、选模型

WB 侧通过 `--model` 指定，写在桥的 `WORKBUDDY_MODEL`，或每次调用时传 `model`。

| 模型 | 合适场景 | 备注 |
|---|---|---|
| `hy3` | 机械结构化任务（归类、抽取、格式整理） | **默认选它**，全天免费 |
| `hy4-preview` | 需要稍强能力的活，夜间时段免费 | 免费时段按你账号实际为准 |
| `glm-5.3-flash` | 质量稳定又要便宜 | |
| `deepseek-v4.1-flash` | 需要更强能力时的低价档 | 曾出现静默挂死（超 150s 零输出），该问题已修复；仍遇到就换模型 |

价格和免费时段随时会变，换之前自己核一次。

选模型的判断顺序：**先看免费模型够不够 → 不够再往上加钱**。但别只看单价：便宜模型反复漏项、返工，总成本反而更高。

---

## 五、出问题怎么查

| 症状 | 大概率原因 | 处理 |
|---|---|---|
| Codex 工具列表里看不到 `run_workbuddy` | 没完全重启 Codex / config.toml 写错位置 / `enabled = false` | 完全退出重开；`grep -A5 'mcp_servers.workbuddy' ~/.codex/config.toml` 对一遍 |
| 调用后**零输出、永不返回** | WB 命令行没独立登录；或端口被桌面端占住（启动阶段报错被吞） | 终端手动跑一次 WB CLI 看提示；桥默认带 `--debug`，用它看真实报错 |
| 报 `Not inside a trusted directory` | 任务目录不是受信目录 | config.toml 里给该目录加 `[projects."/路径"]` + `trust_level = "trusted"`，或显式传 `cwd` |
| 两个任务互相打死 / 结果错乱 | 绕过桥自己并发调 CLI | 走桥（自带串行队列）；同一目录、同一账号、同一浏览器会话的任务必须串行 |
| 换机器后路径全失效 | 把 `/Users/xxx` 写死在多处 | 只改 config.toml 的 `env` 三行，别把路径散落别处 |
| 启动时打印 `fetch config failed TypeError...` | 已知噪音，不影响使用 | 忽略；只要后面能正常出结果就不用管 |

---

## 六、别做什么

1. **别用桌面 UI 自动化派活**（点界面、模拟键盘输入）。不稳、会和多任务打架，而且这套桥就是为了避免它才存在的。
2. **别把密钥写进 config.toml 然后提交到 git**。本仓库不含任何凭据。
3. **别让两个执行者同时写同一个文件**，也别在同一目录并发跑 WB。
4. **别把没验证的输出当成结果**。固定短语只作初筛，必须用一个"读真实文件并落盘"的小任务验证过才算通。
5. **别让外派替代决策**。方向和取舍还在你自己手上——外派只负责执行。

---

## 附录 A：装 Node.js

```bash
# 有 Homebrew
brew install node

# 没有 Homebrew：去 https://nodejs.org 下 LTS 版安装包
```

装完 `node -v` 应显示 v20 以上。

## 附录 B：装 WorkBuddy 并让命令行独立登录

1. 到 WorkBuddy 官网下载桌面端，安装并**登录你的账号**，确认能正常跑一个任务。
2. 找到命令行入口（两处必有一处）：

```bash
# a) 独立安装版（推荐——桌面内嵌版常常无法独立登录）
ls ~/.local/bin/wb-codebuddy

# b) 桌面端自带
ls "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

3. **在终端里不带参数跑一次它**，按提示扫码登录：

```bash
~/.local/bin/wb-codebuddy        # 或你查到的那把
```

看到登录成功提示后退出。**这一步不做，后面所有调用都会卡在零输出。**
4. 记下这个绝对路径，填进 config.toml 的 `WORKBUDDY_CLI`。

## 附录 C：装 Codex

1. 装 Codex（桌面端或 CLI 均可），登录你的账号。
2. 确认：`codex --version`。
3. 非 git 目录里跑 Codex 可能报 `Not inside a trusted directory` —— 加 `--skip-git-repo-check`，或在 config.toml 里把目录设为 `trust_level = "trusted"`。

---

## 七、文件说明

| 路径 | 作用 |
|---|---|
| `bridge/server.mjs` | MCP 桥（零依赖，stdio）。提供 `run_workbuddy` 和 `workbuddy_health` |
| `scripts/health-check.sh` | 五项体检，`--static` 只查配置 |
| `SKILL.md` | 给 AI agent 看的技能说明：怎么判断该不该外派、任务书怎么写、结果怎么验收 |
| `config-snippet.toml` | 可直接抄进 `~/.codex/config.toml` 的模板 |
