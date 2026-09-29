# codex-wb-dispatch

让 **Codex 指挥 WorkBuddy（WB）干活**的最小可用方案：Codex 当大脑（拆任务、路由、验收），WB 当手（跑调研、批量处理、写文件）。

装好之后，你在 Codex 里说一句话，它会自动把能外派的活丢给 WB 执行，再把结果带回来。

---

## 一、这套东西是什么

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
      在你的项目目录里真干活，结果原样返回
```

桥解决三件事：
1. **注册一次永久可用**——不用每次手拼命令行；
2. **模型和权限旗标封在服务端**——不被过期的写法干扰；
3. **串行队列**——两个任务落到同一目录会抢同一个本地端口而互相打死，桥统一排队，从根上避免。

---

## 二、前置条件

| 需要 | 怎么确认 |
|---|---|
| macOS + Node.js（建议 20+） | `node -v` |
| WorkBuddy 桌面端，已登录 | 打开能正常跑一个任务 |
| Codex（桌面端或 CLI） | `codex --version` |
| 一把可用的 WB 命令行 | 见下面第 3 步 |

**关键前置**：WB 命令行必须**独立登录过一次**。桌面端登录不代表命令行已登录。

```bash
# 找到你的 WB 命令行入口，二选一：
# 1) 桌面端自带（多数人）
ls /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy

# 2) 独立安装版（推荐，桌面内嵌版常常无法独立登录）
ls ~/.local/bin/wb-codebuddy
```

然后在**终端**里跑一次它（不带参数），按提示扫码登录。这步跳过的话，后面调 WB 会表现成"零输出、一直不返回"。

---

## 三、安装（三步）

### 第 1 步：放好桥脚本

把本仓库的 `bridge/server.mjs` 复制到一个固定位置，例如：

```bash
mkdir -p ~/mcp-servers/workbuddy-bridge
cp bridge/server.mjs ~/mcp-servers/workbuddy-bridge/server.mjs
chmod +x ~/mcp-servers/workbuddy-bridge/server.mjs
```

零依赖，不需要 npm install。

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
WORKBUDDY_CLI = "/Users/你的用户名/.local/bin/wb-codebuddy"   # 第 2 节里确认过的那把
WORKBUDDY_MODEL = "hy3"                                      # 默认模型，见第五节
WORKBUDDY_TIMEOUT_MS = "1800000"
```

写完**完全重启 Codex**（不是新开一个窗口），MCP 才会加载。

### 第 3 步：验通

```bash
bash scripts/health-check.sh
```

它会逐项检查：node / 桥文件 / config 注册 / WB 命令行是否可调。全绿之后再让 Codex 跑一个小任务（"读某个文件并报告第一行"），**对照源文件确认结果真实**——这才算装好。

---

## 四、怎么用它派活

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

真实例子：

```
背景：我们在评估三家竞品的定价页，需要事实层面的对比。
目标：产出一张对比表：产品名 / 免费额度 / 付费档位价格 / 是否有年付折扣。
允许的输入：官网公开页面。
禁止范围：不要注册账号、不要提交任何表单。
输出路径：写到 ./output/pricing-compare.md
验收标准：三家的四个字段都有值，每个值后面标出处链接；查不到的写"未公开"。
证据要求：每个数字附官网链接。
卡住怎么办：页面打不开就在报告里标明，不要用第三方二手数据顶替。
```

**第一次使用建议先跑 `workbuddy_health`**（显式传项目目录和模型），确认链路通再派真活。

---

## 五、选模型

WB 侧通过 `--model` 指定，写在桥的 `WORKBUDDY_MODEL` 或每次调用时传 `model`。

| 模型 | 合适场景 | 备注 |
|---|---|---|
| `hy3` | 全天免费，机械结构化任务（归类、抽取、格式整理） | 默认就用它 |
| `hy4-preview` | 需要在夜间（23:00–08:00 免费时段）跑稍微吃能力的活 | 免费时段按你账号实际为准 |
| `glm-5.3-flash` | 需要质量稳定又要便宜 | |
| `deepseek-v4.1-flash` | | ⚠️ 历史记录里出现过**静默挂死**（超 150s 零输出、不报错），**不要设成默认**；要用先拿健康检查试 |

价格和免费时段会变，换之前自己核一次。

**铁律**：只从你账号里确认可用的模型里挑；免费/低价模型如果反复漏项或返工，总成本反而更高，该升级就升级。

---

## 六、出问题怎么查

| 症状 | 大概率原因 | 处理 |
|---|---|---|
| Codex 工具列表里看不到 `run_workbuddy` | 没完全重启 Codex / config.toml 写错位置 / `enabled = false` | 完全退出重开；`grep -A5 mcp_servers.workbuddy ~/.codex/config.toml` 对一遍 |
| 调用后**零输出、永不返回** | WB 命令行没独立登录；或端口被桌面端占住（启动阶段报错被吞） | 终端跑一次 WB CLI 看提示；桥已默认带 `--debug`，用它看真实报错 |
| 报 `Not inside a trusted directory` | 任务目录不是受信目录 | 在 config.toml 里给该目录加 `[projects."/你的/路径"]` + `trust_level = "trusted"`，或显式传 `cwd` |
| 两个任务互相打死 / 结果错乱 | 绕过桥自己并发调 CLI | 走桥（桥自带串行队列）；同一目录、同一账号、同一浏览器会话的任务必须串行 |
| 换机器后路径全失效 | 把 `/Users/xxx` 写死在多处 | 只改 config.toml 的 `env` 三行；别把路径散落到别处 |
| WB CLI 启动时打印 `fetch config failed TypeError...` | 已知噪音，不影响使用 | 忽略；只要后面能正常出结果就不用管 |

---

## 七、别做什么

1. **别用桌面 UI 自动化派活**（点界面、模拟键盘输入）。不稳、会和多任务打架，而且这套桥就是为了避免它才存在的。
2. **别把密钥写进 config.toml 然后提交到 git**。本仓库不含任何凭据。
3. **别让两个执行者同时写同一个文件**，也别在同一目录并发跑 WB。
4. **别把没验证的输出当成结果**。固定短语只作初筛，必须用一个"读真实文件并落盘"的小任务验证过才算通。
5. **别让外派替代决策**。产品方向、口径、取舍这些还在你自己手上——外派只负责执行。

---

## 八、文件说明

| 路径 | 作用 |
|---|---|
| `bridge/server.mjs` | MCP 桥（零依赖，stdio）。提供 `run_workbuddy` 和 `workbuddy_health` |
| `scripts/health-check.sh` | 逐项体检安装状态 |
| `SKILL.md` | 给 AI agent 看的技能说明：怎么判断该不该外派、任务书怎么写、结果怎么验收 |
| `config-snippet.toml` | 可直接抄进 `~/.codex/config.toml` 的模板 |
