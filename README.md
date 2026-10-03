# Mneme Bridge

**打通 DSH 与 DeepSeek 网页版的记忆：一套记忆，双端共享。**

DSH（桌面 Agent）与 DeepSeek 网页版目前各自为政——DSH 侧可以通过插件获得长期记忆（有多种记忆类插件可选，本项目选用其中的 [mneme](https://github.com/slow-stack/mneme)），而网页版每个新会话都从零开始。本项目把网页端接入 mneme 的记忆库，让记忆在两个端之间自由流动：

- **网页对话 → 记忆**：自动捕获你在 chat.deepseek.com 的对话，交由 DSH 蒸馏成原子记忆，存入本地记忆库
- **记忆 → 网页对话**：之后每个新会话，相关的记忆都会按当轮话题自动注入

本项目由两个组件构成：

| 组件 | 形态 | 职责 |
|---|---|---|
| **mneme-bridge** | 本地 Node 服务（托盘常驻） | 捕获对话、调用 DSH 蒸馏、读写记忆库、为扩展提供检索接口 |
| **Mneme Bridge for DeepSeek** | Edge/Chrome 扩展（MV3） | 注入记忆到网页对话、捕获对话回传、提供侧栏管理面板 |

### 与上游 mneme 的关系

本项目基于 [mneme](https://github.com/slow-stack/mneme)（DSH 的记忆类插件之一，MIT 协议）构建，**以它的记忆库为唯一记忆源**——不复制、不改造、不另建存储，只通过 mneme 的 API 读写。

> **本项目不是 DSH 插件**，也不安装在 DSH 内部。它是一个独立的浏览器扩展 + 本地服务，在 mneme 之外提供"网页端接入"这一层能力。二者是协同关系：mneme 管理 DSH 内的记忆，本项目把网页端接进同一份记忆库。

**使用前提**：

1. 安装 [DSH](https://github.com/deepseek-ai/dsh)——DSH 本身**不自带**记忆功能，需由插件提供
2. 在 DSH 中**自行安装 mneme 插件**（本项目依赖的是这个特定插件，而非"任意记忆插件"），并至少启动一次 DSH 以创建记忆库

本项目自身零 npm 依赖、扩展零构建链。

---

## 工作流闭环

```
你在网页聊天 → 扩展自动捕获对话 → 本地缓冲队列（可人工把关剔除）
   → 到点自动"蒸馏"成原子记忆（用你自己的 DSH 额度，成本可见）
   → 入本机记忆库 → 下次聊天按话题自动注入相关记忆
```

## 功能特性

**记忆注入**
- 双路径注入：**隐式**（记忆拼进请求，输入框无感）／**显式**（记忆块写进输入框，可见可删改）
- 会话首轮注入画像与通用偏好，后续每轮只注入**当轮话题相关**的记忆（不重复占上下文）
- 话题相关检索：语义检索 + 关键词补路 + 寒暄/闲聊自动跳过 + 元记忆过滤

**记忆沉淀**
- 对话自动捕获 → 缓冲队列人工把关（可单条删除）→ 会话静默后自动蒸馏
- 蒸馏产物带溯源标签（`web/<会话id>`），可追溯每条记忆来自哪次对话
- 支持把历史网页会话批量导入（带字符预算闸与预估，绝不静默截断）

**工程**
- 桥接服务**零 npm 依赖**（纯 Node 标准库），扩展**零构建链**（原生 MV3）
- 免费本地运行：检索与存储全在本地 SQLite；仅蒸馏消耗你自己的 DSH 额度
- 自带 96 项回归自检（`node scripts/smoke.mjs`），测试环境完全隔离、不触碰真实数据

## 仓库结构

```
mneme-memory-project/
├── mneme-edge-extension/   Edge/Chrome 扩展（MV3，零构建链）
│   ├── manifest.json
│   ├── content/content.js      页面脚本：输入框注入（显式模式）、侧栏面板
│   ├── injected/inject.js      主世界脚本：请求体改写（隐式模式）、对话捕获
│   ├── background.js           后台：bridge 转发、重试队列
│   └── options/                设置页
└── mneme-bridge/           本地桥接服务（Node ≥ 22.5，零 npm 依赖）
    ├── server.js               HTTP 服务（默认 127.0.0.1:8760）
    ├── lib/
    │   ├── embedded.js         embedded 模式：进程内直连 mneme 记忆库
    │   ├── remote.js           remote 模式：代理 DSH standalone API
    │   ├── distiller.js        对话→原子记忆 蒸馏器（调 dsh headless）
    │   ├── buffer.js           待蒸馏缓冲（SQLite，蒸馏前可人工把关）
    │   ├── importer.js         旧会话批量导入（带字符闸与预估）
    │   └── ...
    ├── config.example.json     配置模板
    ├── scripts/smoke.mjs       96 项自检
    └── 启动bridge.bat
```

## 快速开始

三步：**起服务 → 装扩展 → 把 token 填进扩展**。

### 前置条件

- Windows 10/11（启动脚本目前仅 Windows；其他平台可手动 `node server.js` 运行）
- **Node.js ≥ 22.5**——桥接服务使用 Node 内置 `node:sqlite`，低版本会直接启动失败（终端运行 `node -v` 查看；[下载](https://nodejs.org/)）
- [DSH](https://github.com/deepseek-ai/dsh) 已安装并**至少启动过一次**
- **mneme 插件已在本机 DSH 中安装**（DSH 不自带记忆功能；mneme 是记忆类插件之一，本项目依赖的是它）——且首次启动 DSH 后才会创建记忆库文件

**三者的关系（先看这个，不然容易懵）：**

```
  DSH（桌面端）                          DeepSeek 网页版
      │                                      │
      │ 需自行安装                             │ 本项目提供
      ▼                                      ▼
  mneme 插件（记忆类插件之一）──同一份记忆库── 浏览器扩展
      （记忆的主人）    <DSH_HOME>/memory/memory.db   + 本地桥接服务
```

- **mneme**：DSH 的记忆类插件之一（需自行安装），记忆实际存在它管理的 SQLite 里
- **本项目**：不碰记忆库格式，只通过 mneme 的 API 读写——所以 DSH 与网页版看到的是**同一份记忆**
- **必须先装 DSH + mneme 插件**：DSH 不自带记忆功能，本项目接的是 mneme 的记忆库；二者缺一，扩展装上也无处可连

---

### 第 1 步：启动桥接服务

双击项目根目录的 **启动mneme-bridge.cmd**：

- **首次运行**会询问"是否注册开机自启"——按 Y 则登录后自动常驻，按 N 或回车跳过（之后可随时 `bridge-launcher.cmd install` 补注册）
- 之后运行即启动托盘常驻（系统托盘出现图标，右键可打开状态页/重启/退出）

服务首次启动会在 `mneme-bridge/config.json` **自动生成**一份配置，其中含一个随机 `bridgeToken`：

```json
{
  "port": 8760,
  "bridgeToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "mneme": { "mode": "auto", "libPath": "", "dataDir": "" }
}
```

**这个 bridgeToken 是扩展连接本服务的凭证——下一步要原样填进扩展设置。**
查看方式：用记事本打开 `mneme-bridge/config.json`，复制 `bridgeToken` 的值（或托盘图标右键 →「打开状态页」，会打开 /health 的 JSON，里面不含 token——token 只在 config.json 里）。

> **记忆库位置**：默认留空会自动探测，顺序为 `$DSH_HOME`（或 `~/.dsh`）→ `profiles/web/node_modules/@modusensus/dsh-mneme/lib` 与同级的 `memory` 目录。
> 若 DSH 装在非默认位置，服务启动时会报错并提示填这两项，手工在 config.json 里填即可：
> ```json
> "mneme": { "libPath": "<DSH>/profiles/web/node_modules/@modusensus/dsh-mneme/lib", "dataDir": "<DSH>/memory" }
> ```
> （Windows 下路径用正斜杠 `/` 或双反斜杠 `\\\\`）

---

### 第 2 步：安装浏览器扩展

1. Edge 打开 `edge://extensions`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择 `mneme-edge-extension` 文件夹
4. 扩展出现在列表中即安装成功

---

### 第 3 步：把 bridgeToken 填进扩展（关键）

1. 打开 `edge://extensions` → 找到 **Mneme Bridge for DeepSeek** → 点 **详细信息** → 点 **扩展选项**
   （也可以点浏览器工具栏上的扩展图标 → 右键 → 选项）
2. 按下面填写：

   | 字段 | 填什么 |
   |---|---|
   | **Bridge 地址** | `http://127.0.0.1:8760`（默认值，通常不用改） |
   | **访问 Token** | **粘贴第 1 步复制的 `bridgeToken`**（必填，否则连接会被拒） |
   | 启用记忆注入 | ☑ 勾上 |
   | 自动收集对话 | ☑ 勾上（不勾则不会捕获对话、无法蒸馏） |
   | 注入方式 | 隐式注入（推荐，无感）／可见注入（发送前把记忆写进输入框，可编辑） |

3. 保存后 **重新加载扩展**（`edge://extensions` 里点 ↻）并 **刷新 DeepSeek 页面**（这一步不能省，content script 不会热更新）

---

### 第 4 步：验证连通

打开 https://chat.deepseek.com，侧栏底部会出现 **「记忆设置」** 菜单项（与「系统设置」并列）：

1. 点它 → 弹出面板，顶部状态区显示 **「bridge：连通 ✓」**（绿点）= token 正确、服务可达
   - 若显示未连通：检查 ① 服务是否在跑（浏览器打开 `http://127.0.0.1:8760/health` 应返回一行 JSON）② token 是否复制完整（末尾别带空格/换行）
   - 面板里的开关与选项页**双向同步**，在哪里改都一样
2. 随便聊一轮 → 面板「待蒸馏队列」出现条目
3. 点「立即蒸馏」→ 完成后在「记忆库」标签看到蒸出的结构化记忆
4. **新开一个会话**，你会看到 DS 已经认识你（注入的记忆块）。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 面板显示未连通 | token 未填 / 填错 / 服务未启动（见第 4 步排查） |
| 改了设置没反应 | 扩展需重新加载（↻）+ 页面刷新 |
| 队列一直不出现条目 | 选项页「自动收集对话」未勾选 |
| 蒸馏报错 | DSH headless CLI 凭证需单独配置，按 `mneme-bridge/logs/` 内日志提示处理 |
| 启动报 `node:sqlite` 相关错误 | Node 版本过低，需 ≥ 22.5 |
| 启动报"自动探测失败" | DSH 不在默认位置，按第 1 步的说明手工填写 libPath / dataDir |

## 两种注入方式

| | 显式（visible） | 隐式（implicit，推荐） |
|---|---|---|
| 输入框 | 首轮写入记忆块（可编辑） | 全程无感 |
| 会话第 2+ 轮 | 只注入本轮相关记忆（不重复画像） | 同左 |
| 切换注入方式 | 功能开关面板，即时生效 | |

## 成本

蒸馏用你自己的 DSH 模型额度（默认 DeepSeek V4-Flash）：约 5.5 万字符对话 ≈ ¥0.04。注入与检索走本地 SQLite，零成本。

## 隐私与安全

- 全部数据在本机（SQLite），不经过任何第三方
- bridge 监听 127.0.0.1/局域网，Bearer token 鉴权（首次启动自动生成）；**仅限家庭局域网使用，勿暴露公网**
- 蒸馏调用发往 DeepSeek 官方 API（你的 DSH 额度），内容为对话原文——介意者可关闭蒸馏只用手动导入

## 测试

```bash
cd mneme-bridge
node scripts/smoke.mjs    # 96 项自检（自动使用隔离环境，不碰真实数据）
```

## 配置要点（config.json）

| 键 | 说明 |
|---|---|
| mneme.mode | auto（默认，探测 DSH API）/ embedded / remote |
| mneme.libPath / dataDir | embedded 模式记忆库位置，留空自动探测 |
| distill.dshCommand | 蒸馏 LLM 命令（默认 PATH 里的 dsh） |
| distill.idleMs | 会话静默阈值（默认 10 分钟，聊完才蒸，整会话一次调用） |
| import.maxImportChars | 单批导入字符闸（默认 150 万） |

## 已知边界

- 网页端 DOM/接口改版可能需要更新扩展的选择器（扩展内置探针日志辅助定位）
- DSH headless CLI 的凭证需单独配置（首次蒸馏时按日志提示）
- 手机端（PWA）尚未实现

## License

MIT
