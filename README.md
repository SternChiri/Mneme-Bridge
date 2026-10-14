<div align="center">
  <img src="assets/mneme-bridge-logo.svg" width="96" alt="Mneme Bridge logo"/>

  # Mneme Bridge

**打通 DSH 与 DeepSeek 网页版的记忆 —— 一套记忆，双端共享**

[![Built on mneme](https://img.shields.io/badge/built%20on-dsh--mneme-8B5CF6?style=flat-square)](https://github.com/slow-stack/mneme)
[![License](https://img.shields.io/badge/license-MIT-3E63DD?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-3E63DD?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Extension](https://img.shields.io/badge/extension-MV3-3E63DD?style=flat-square&logo=microsoftedge&logoColor=white)](https://github.com/SternChiri/Mneme-Bridge)
[![English](https://img.shields.io/badge/English-version-8B5CF6?style=flat-square)](#english-version)

</div>

---

## 🌟 这是什么

**你的 AI 记忆不该有两套。**

用 DSH 干活时，它记得你的项目、偏好、决定；切到 DeepSeek 网页版闲聊，它却像第一次见你。**Mneme Bridge 把网页端 DeepSeek 接进 DSH 的记忆库**——同一个大脑，两个入口。

本项目由两个组件组成，不含任何云端服务：

| 组件 | 形态 | 职责 |
|:--|:--|:--|
| **mneme-bridge** | 本地 Node 服务 | 捕获对话 → 调用 DSH 蒸馏 → 读写记忆库 → 给扩展提供检索接口 |
| **Mneme Bridge for DeepSeek** | Edge / Chrome 扩展 | 注入记忆到网页对话、把对话回传、提供侧栏管理面板 |

> **记忆基座**：本项目的记忆池是上游 **[mneme](https://github.com/slow-stack/mneme)**（DSH 的记忆插件，MIT）——存储、巩固、去重合并、冲突裁决、语义检索全部由它负责，本项目**不复制、不改造、不另建存储**，只通过它的 API 读写。
>
> **本项目不是 DSH 插件**，也不安装在 DSH 内部。它是独立的浏览器扩展 + 本地服务，在 mneme 之外补上"网页端接入"这一层能力。

### 解决什么问题

DeepSeek 的记忆是分裂的：DSH 侧**可以**通过插件获得长期记忆，网页版却每个新会话都从零开始。

| 场景 | 现在 | 装上本项目后 |
|:--|:--|:--|
| 昨天在网页上聊完论文选题，今天新开一个会话 | "请先介绍一下你的研究方向" | "上次你说要做无人机路径规划算法，要继续吗？" |
| 在 DSH 里交代过"我偏好文段式表达、不要 AI 腔" | 网页端依然满口 AI 腔 | 网页端首轮就带上你的画像与偏好 |
| 网页里聊到的项目细节 | DSH 完全不知道 | 蒸馏入库，DSH 下次也能检索到 |

> 与「浏览器里存一份聊天记录」的区别在于：记忆是**蒸馏后的原子事实**（可检索、可去重、可裁决冲突），并且与 DSH 共用同一个库——不是数据孤岛。

### 一图看懂怎么工作

```
   你在 chat.deepseek.com 聊天
   │
     扩展捕获对话（可人工把关剔除）
   │
   ▼
   ┌──────────────────────────────┐
   │  本地缓冲队列（两条来源）    │
   │  ① 新会话：每轮自动入队      │
   │  ② 旧会话：面板手动导入      │
   └──────────────────────────────┘
   │
     会话静默后自动触发
   ▼
   DSH headless 蒸馏
   │
   ▼
   mneme 记忆库
     存储 / 去重合并 / 检索 / 冲突裁决
     （均由上游 mneme 提供）
   │
   ▼
   下次聊天按话题注入相关记忆
```

> 记忆的**存储、去重、合并、冲突裁决、检索**均由上游 mneme 提供，本项目不实现这些能力

## 🚀 快速开始

### 前置条件

| 依赖 | 要求 | 说明 |
|:--|:--|:--|
| 系统 | Windows 10/11 | 启动脚本目前仅 Windows；其他平台可手动 `node server.js` |
| **Node.js** | **≥ 22.5** | 桥接使用内置 `node:sqlite`，低版本会直接启动失败 |
| **DSH** | 已安装并至少启动一次 | DSH 本身**不自带**记忆功能，需由插件提供 |
| **mneme 插件** | 已在本机 DSH 中安装 | 本项目依赖该记忆插件 |

**三者关系**：

```
      DSH（桌面端）                          DeepSeek 网页版
           │                                      │
           │ 需自行安装                           │ 本项目提供
           ▼                                      ▼
      mneme 插件                              浏览器扩展
     （记忆的主人）                         + 本地桥接服务
           │                                      │
           └────────────同一份记忆库──────────────┘
                     <DSH_HOME>/memory/
```

### 方式 A · 让本机 Agent 替你装

不想手动装？把下面这段原样复制粘贴给本机的 AI Agent（如DSH），它会替你装好：

```text
请帮我安装 Mneme Bridge（仓库：https://github.com/SternChiri/Mneme-Bridge）。请先阅读该仓库 README 的「快速开始」，然后按其中步骤在本机完成安装、启动桥接服务并配置浏览器扩展；需要我手动做的事（如在 Edge 里加载扩展、填写 token）请列出来告诉我。
```

### 方式 B · 手动安装

按下面五步走：

#### 第 1 步 · 下载项目

```bash
git clone https://github.com/SternChiri/Mneme-Bridge.git
cd Mneme-Bridge
```

或仓库页面 → **Code** → **Download ZIP** 解压（路径别含空格或中文）。解压后你会看到两个目录：`mneme-bridge/`（本地服务）与 `mneme-edge-extension/`（浏览器扩展）。

#### 第 2 步 · 启动桥接服务

双击项目根目录的 **启动mneme-bridge.cmd**（托盘常驻）：

- **首次运行**会问你"是否注册开机自启"——按 Y 常驻，按 N 或回车跳过（之后可跑 `bridge-launcher.cmd install` 补注册）
- 之后运行直接启动托盘常驻（右键托盘图标可打开状态页 / 重启 / 退出）

服务首次启动会在 `mneme-bridge/config.json` 自动生成配置，其中有一个随机 `bridgeToken`：

```json
{
  "port": 8760,
  "bridgeToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "mneme": { "mode": "auto", "libPath": "", "dataDir": "" }
}
```

**这个 token 是扩展连接本服务的凭证，第 4 步要用。** 打开 config.json 复制它即可。

> 记忆库位置默认留空自动探测（`$DSH_HOME` 或 `~/.dsh` 下的 mneme 目录）。DSH 装在非常规位置时，服务会报错提示你手工填 `mneme.libPath` 与 `mneme.dataDir`。

#### 第 3 步 · 安装浏览器扩展

1. Edge 打开 `edge://extensions`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展** → 选 `mneme-edge-extension` 目录

#### 第 4 步 · 把 token 填进扩展

`edge://extensions` → **Mneme Bridge for DeepSeek** → **详细信息** → **扩展选项**，然后：

| 字段 | 填什么 |
|:--|:--|
| **Bridge 地址** | `http://127.0.0.1:8760`（默认，一般不用改） |
| **访问 Token** | 粘贴第 2 步复制的 `bridgeToken`（必填，否则连接被拒） |
| 启用记忆注入 | ☑ |
| 自动收集对话 | ☑（不勾则不会捕获对话、无法蒸馏） |

保存后**重新加载扩展（↻）并刷新 DeepSeek 页面**——此步不能省，扩展脚本不会热更新。

#### 第 5 步 · 验证

打开 https://chat.deepseek.com ，侧栏底部出现 **「记忆设置」**：

1. 点开 → 顶部状态显示 **「bridge：连通 ✓」**（绿点）= token 正确、服务可达
2. 随便聊一轮 → 「待蒸馏队列」出现条目
3. 点「立即蒸馏」→ 「记忆库」标签能看到蒸出的结构化记忆
4. **新开一个会话** → 它已经认识你了

## 📖 功能详解

### 两种注入方式

| | 隐式注入（默认） | 可见注入 |
|:--|:--|:--|
| 输入框 | 不碰，全程无感 | 发送前写入记忆块，可见 |
| 请求体 | 记忆拼进请求 | 不碰 |
| 适用 | 日常使用 | 想看这轮带了什么记忆 |

两种方式都遵循同一条规则：**首轮带画像与通用偏好，之后每轮只注入当轮话题相关的记忆**——不重复占用上下文。

### 两条入库路径

| | 新会话自动捕获 | 旧会话手动导入 |
|:--|:--|:--|
| 触发 | 每轮对话结束后自动入队 | 面板「导入旧会话」手动发起 |
| 范围 | 正在进行的网页对话 | 已有的历史会话（从 DS 接口/导出文件读取） |
| 粒度 | 逐轮原样入队 | 用户按会话勾选，可选两种模式 |
| 模式 | 仅**全量导入** | **摘要**（本地取首尾消息，零成本）／**全量导入**（携带完整对话） |
| 保护 | 队列可先人工剔除 | 会话数上限 + 字符预算闸 + 预估确认，超限报错 |

两者最终都进入同一个缓冲队列，等待 DSH headless 蒸馏；产出的记忆带溯源标签 `web/<会话id>`，可回溯来自哪次网页对话。



### 记忆是怎么被注入的

1. **取上下文**：扩展按你当前输入的话题，向本地桥接请求相关记忆
2. **拼装**：桥接返回画像与通用偏好（会话首轮）+ 当轮话题相关的记忆
3. **注入**：隐式模式拼进请求体；可见模式先写进输入框供你过目
4. **检索质量**：由 mneme 的混合检索提供（建议 mneme ≥ 0.8.14，注入走上游 `GET /context` 管线）；`mneme.contextSource="heuristic"` 的降级拼装路径额外做关键词补路、寒暄跳过与元记忆过滤

## 🧩 桥接服务的 REST 接口

> 桥接服务对外是纯 HTTP，可被任意脚本或其他客户端调用，鉴权头 `Authorization: Bearer <bridgeToken>`。
> 其中 `/memory/context`、`/memory/distill`、`/memory/import*` 是本项目专有的组合能力；`save/search/recent/list` 是对 mneme 记忆 API 的转发。

| 接口 | 用途 |
|:--|:--|
| `GET /health` | 健康检查（免鉴权） |
| `GET /memory/context?q=&topK=` | 按话题取注入上下文（画像 + 偏好 + 相关记忆） |
| `POST /memory/search` · `GET /memory/recent` · `/list` | 检索 / 最近 / 全部列表 |
| `POST /memory/save` | 写入一条记忆 |
| `GET /memory/pending` · `DELETE /memory/pending?id=` | 待蒸馏队列的读取与删除 |
| `GET /memory/conversation` | 对话去重写入（扩展上报对话用） |
| `GET /memory/imported-ids` | 已导入会话 id 列表（扩展用来隐藏已导入项） |
| `POST /memory/distill` | 立即蒸馏 |
| `POST /memory/import` · `/memory/import/estimate` | 批量导入与预估 |
| `GET /memory/status` | 运行状态 |

## 🔧 配置（config.json）



| 键 | 默认 | 说明 |
|:--|:--|:--|
| `port` | 8760 | 监听端口 |
| `bridgeToken` | 首次启动随机生成 | 扩展鉴权凭证 |
| `mneme.mode` | `auto` | auto（启动时探测一次）/ embedded / remote；remote 为 8790 REST（DSH 外部访问或独立 daemon） |
| `mneme.libPath` / `dataDir` | 空（自动探测） | embedded 模式的记忆库位置 |
| `mneme.contextExcludeSensitive` | `true` | 注入（/memory/context）是否排除带 sensitivity 标注的记忆——敏感条目不随每轮请求发往网页端 |
| `mneme.allowedLibRange` | `^0.8.14` | embedded 模式 mneme lib 版本门控；超出区间拒绝启动。空串关闭校验 |
| `distill.enabled` | `true` | 关掉即完全停止蒸馏 |
| `distill.idleMs` | 10 分钟（未写进生成的 config 时按此兜底） | 会话静默多久后触发蒸馏 |
| `distill.dshCommand` | `dsh` | 蒸馏用的 LLM 命令 |
| `import.maxImportChars` | 150 万 | 单批导入字符闸 |

## 🛠️ 本地开发

**运行环境**：Node ≥ 22.5。桥接服务零 npm 依赖，**无需 `npm install`**。

```bash
# 前台运行桥接（能直接看到日志输出，调试用）
cd mneme-bridge
node server.js

# 用隔离配置启动第二个实例（不干扰正在使用的生产实例）
# MNEME_BRIDGE_CONFIG / _LOG_DIR / _DATA_DIR 三个环境变量可整体重定向
set MNEME_BRIDGE_CONFIG=F:\temp\dev-config.json
node server.js
```

**扩展侧调试**：扩展是原生 MV3、无构建步骤——改完源码后在 `edge://extensions` 点 **重新加载（↻）**，
并**刷新 DeepSeek 页面**（content script 不会热更新，这一步最容易被忘）。

**日志**：`mneme-bridge/logs/`（结构化 JSON，含检索命中、蒸馏批次、错误栈）。
扩展的调试输出在 DeepSeek 页面的 DevTools Console，过滤 `[mneme` 即可；`[mneme/cs] content script 版本 0.6.2 mode=implicit`
这行是验证"新代码是否真的生效"的最快手段。

**跑测试前请注意**：smoke 会校验生产记忆库的 mtime/size 未变（零写红线），因此**别在测试期间改动生产库**。

## 💰 成本

- **注入与检索**：本地 SQLite，**零成本**
- **蒸馏**：走你自己的 DSH 模型额度，约 5.5 万字符对话 ≈ **¥0.04**

## 🔐 隐私与安全

- 数据全部在本机（SQLite + 本地文件），**不上传任何第三方**
- 服务默认只监听本地/局域网，Bearer token 鉴权；**仅限局域网使用，切勿暴露公网**
- 唯一的外发请求是蒸馏（调用你配置的模型 API，内容为对话原文）——介意可关闭 `distill.enabled`，只用手动导入与检索
- **注入出境**：每次对话会把注入块（用户画像 / 行为规则 / 交互偏好 / 话题相关记忆）拼进请求发往 DeepSeek 服务器——这是「网页端带上记忆」的本来含义。带 `sensitivity` 标注的记忆默认**不**进入注入块（`mneme.contextExcludeSensitive`），介意数据出境可关闭注入
- **页面脚本风险**：扩展的注入层运行在页面主世界，与面板层经页面事件通信。恶意网页脚本理论上可伪造该事件读出记忆库（无需 bridgeToken）。已加一次性握手 nonce 提高门槛，但这是缓解而非强隔离——**只在你信任的站点开启采集**

## 🗺️ 已知边界

- 网页端 DOM / 接口改版可能需要更新扩展选择器（扩展内置探针日志辅助定位）
- DSH headless CLI 的凭证需单独配置（首次蒸馏时按日志提示）
- 记忆的**巩固（dream）由 DSH 侧负责**——桥接服务只做沉淀与检索，不运行巩固循环
- 网页端对话**不进实体表**（实体抽取器由 DSH 宿主接线，桥接侧拿不到），实体检索通道看不见网页记忆
- 桥接蒸馏的条目**绕过 DSH 宿主的质量闸**（归档/降权与写入准入），纯度依赖蒸馏 prompt 对齐
- 共享是**不对称**的：网页端写入全局记忆（所有 DSH 会话可见）；DSH 侧标注了 agent 作用域的记忆对网页端不可见——「网页进全局、只读全局」，不是双向全量同步
- `saveWithDedupe` 去重是先查后写（库层无唯一约束），两个进程并发写同一标题存在极小的重复概率
- 网页注入的候选**没有跨轮轮换**：上游 `GET /context` 无会话状态（daemon 刻意无状态），同一轮压力下同一批记忆会反复入选；自建 pins 启发式退役后，bridge 不再自备轮换，若在意需要 bridge 自管（当前未做，属已知行为）
- 会话清理器按内部格式识别本桥接产生的残留会话，属**实验性**能力（四重闸防误删）
- **移动端尚未实现**——路线图上，欢迎 PR

## 🙏 致谢

- **[dsh-mneme](https://github.com/slow-stack/mneme)**（MIT）——本项目的记忆底座。记忆的存储、检索、蒸馏提示词管线全部由它提供，本项目只做"把网页端接进来"。感谢上游作者。
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**——蒸馏与记忆库的宿主。

## 📄 License

MIT —— 详见 [LICENSE](LICENSE)。本项目包含/依赖 [dsh-mneme](https://github.com/slow-stack/mneme)（MIT）。

---

<a id="english-version"></a>

[![简体中文](https://img.shields.io/badge/中文-版本-8B5CF6?style=flat-square)](#mneme-bridge)

# Mneme Bridge

**One memory for DSH and the DeepSeek web app — one brain, two entry points**

## 🌟 What is this

**Your AI memory should not live in two separate worlds.**

When you work in DSH, it remembers your projects, preferences, and decisions. Switch to the DeepSeek web app for a casual chat, and it acts like it is meeting you for the first time. **Mneme Bridge connects the DeepSeek web app to DSH's memory store** — the same brain, two entrances.

The project consists of two components and includes no cloud service:

| Component | Form | Responsibility |
|:--|:--|:--|
| **mneme-bridge** | Local Node service | Captures conversations → invokes DSH distillation → reads/writes the memory store → serves retrieval APIs to the extension |
| **Mneme Bridge for DeepSeek** | Edge / Chrome extension | Injects memory into web conversations, sends conversations back, provides a sidebar management panel |

> **Memory foundation**: the memory pool behind this project is the upstream **[mneme](https://github.com/slow-stack/mneme)** (the memory plugin for DSH, MIT) — storage, consolidation, dedup/merge, conflict adjudication, and semantic retrieval are all its responsibility. This project **does not copy, modify, or build another store**; it reads and writes only through mneme's APIs.
>
> **This project is not a DSH plugin** and is not installed inside DSH. It is a standalone browser extension + local service that adds the "web access" layer on top of mneme.

### What problem it solves

DeepSeek's memory is split: the DSH side **can** gain long-term memory through plugins, while the web app starts every new session from zero.

| Scenario | Today | With this project |
|:--|:--|:--|
| You discussed your thesis topic on the web yesterday; today you open a new session | "Please first introduce your research direction" | "Last time you said you wanted to work on UAV path-planning algorithms — shall we continue?" |
| You told DSH "I prefer prose-style replies, no AI tone" | The web app still talks like an AI | The web app carries your profile and preferences from the very first turn |
| Project details discussed on the web | DSH knows nothing about them | Distilled into the store; DSH can retrieve them next time |

> The difference from "saving a chat log in the browser": memories are **distilled atomic facts** (retrievable, deduplicable, conflict-adjudicable) and share the same store with DSH — not a data silo.

### How it works at a glance

```
   You chat on chat.deepseek.com
   │
     Extension captures the conversation (manual review possible)
   │
   ▼
   ┌──────────────────────────────┐
   │  Local buffer queue (two sources)      │
   │  ① New sessions: auto-enqueued per turn │
   │  ② Old sessions: manual import from the panel │
   └──────────────────────────────┘
   │
     Triggered automatically once a session goes idle
   ▼
   DSH headless distillation
   │
   ▼
   mneme memory store
     storage / dedup & merge / retrieval / conflict adjudication
     (all provided by upstream mneme)
   │
   ▼
   Next chat injects memories relevant to the topic
```

> Memory **storage, dedup, merge, conflict adjudication, and retrieval** are all provided by upstream mneme; this project does not implement them.

## 🚀 Quick start

### Prerequisites

| Dependency | Requirement | Notes |
|:--|:--|:--|
| System | Windows 10/11 | The launcher scripts are Windows-only for now; on other platforms run `node server.js` manually |
| **Node.js** | **≥ 22.5** | The bridge uses the built-in `node:sqlite`; older versions fail to start |
| **DSH** | Installed and launched at least once | DSH does **not** ship memory features by itself; a plugin provides them |
| **mneme plugin** | Installed in your local DSH | This project depends on that memory plugin |

**How the three relate:**

```
      DSH (desktop)                          DeepSeek web app
           │                                      │
           │ install yourself                     │ provided by this project
           ▼                                      ▼
      mneme plugin                             browser extension
      (owner of memory)                        + local bridge service
           │                                      │
           └───────────the same memory store──────┘
                     <DSH_HOME>/memory/
```

### Option A · Let your local Agent install it

Prefer not to install it yourself? Paste the paragraph below verbatim to your local AI agent (e.g. DSH) — it will install everything for you:

```text
Please install Mneme Bridge for me (repo: https://github.com/SternChiri/Mneme-Bridge). Read the "Quick start" section of the repo's README first, then follow its steps to install and start the bridge service and set up the browser extension on this machine. List anything that must be done manually by me (e.g. loading the extension in Edge, filling in the token) and tell me when you are done.
```

### Option B · Manual installation

Follow the five steps below:

#### Step 1 · Download the project

```bash
git clone https://github.com/SternChiri/Mneme-Bridge.git
cd Mneme-Bridge
```

Or on the repo page → **Code** → **Download ZIP** and extract (avoid spaces or non-ASCII characters in the path). After extraction you will see two directories: `mneme-bridge/` (the local service) and `mneme-edge-extension/` (the browser extension).

#### Step 2 · Start the bridge service

Double-click **启动mneme-bridge.cmd** in the project root (runs resident in the tray):

- On **first run** it asks whether to register autostart — press Y to keep it resident, press N or Enter to skip (you can register later with `bridge-launcher.cmd install`)
- On later runs it starts directly in the tray (right-click the tray icon for the status page / restart / exit)

On first startup the service generates `mneme-bridge/config.json`, which contains a random `bridgeToken`:

```json
{
  "port": 8760,
  "bridgeToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "mneme": { "mode": "auto", "libPath": "", "dataDir": "" }
}
```

**This token is the credential the extension uses to connect to the service; you will need it in step 4.** Open config.json and copy it.

> The memory-store location is left empty by default and auto-detected (the mneme directory under `$DSH_HOME` or `~/.dsh`). If DSH is installed in a non-standard location, the service will error out and ask you to fill in `mneme.libPath` and `mneme.dataDir` manually.

#### Step 3 · Install the browser extension

1. In Edge, open `edge://extensions`
2. Turn on **Developer mode** (bottom left)
3. Click **Load unpacked** → select the `mneme-edge-extension` directory

#### Step 4 · Fill the token into the extension

`edge://extensions` → **Mneme Bridge for DeepSeek** → **Details** → **Extension options**, then:

| Field | What to enter |
|:--|:--|
| **Bridge address** | `http://127.0.0.1:8760` (default; usually no change needed) |
| **Access token** | Paste the `bridgeToken` copied in step 2 (required, otherwise the connection is rejected) |
| Enable memory injection | ☑ |
| Auto-collect conversations | ☑ (unchecked = no capture, no distillation) |

After saving, **reload the extension (↻) and refresh the DeepSeek page** — this step cannot be skipped; extension scripts do not hot-reload.

#### Step 5 · Verify

Open https://chat.deepseek.com — a **"记忆设置" (Memory Settings)** panel appears at the bottom of the sidebar:

1. Open it → the status at the top shows **bridge: connected ✓** (green dot) = token correct, service reachable
2. Chat one turn → the "pending distillation queue" shows an entry
3. Click "Distill now" → the "memory store" tab shows the distilled structured memories
4. **Open a new session** → it already knows you

## 📖 Features in detail

### Two injection modes

| | Implicit injection (default) | Visible injection |
|:--|:--|:--|
| Input box | Untouched, fully invisible | Memory block written before sending, visible |
| Request body | Memory appended into the request | Untouched |
| Best for | Everyday use | Seeing what memory this turn carries |

Both modes follow the same rule: **the first turn of a session carries your profile and general preferences; every later turn only injects memories relevant to the current topic** — no repeated context bloat.

### Two ingestion paths

| | Auto-capture (new sessions) | Manual import (old sessions) |
|:--|:--|:--|
| Trigger | Auto-enqueued after each turn | Initiated manually from the panel via "Import old sessions" |
| Scope | Ongoing web conversations | Existing historical sessions (read from DS APIs / export files) |
| Granularity | Enqueued turn-by-turn, verbatim | You pick the sessions; two modes available |
| Modes | Full import only | **Summary** (local first/last messages, zero cost) / **Full import** (complete conversation) |
| Safeguards | Queue items can be pruned manually first | Session-count cap + character budget gate + estimate confirmation; over-limit requests error out |

Both paths end up in the same buffer queue awaiting DSH headless distillation; the produced memories carry the provenance tag `web/<sessionId>`, traceable back to the web conversation they came from.

### How memory gets injected

1. **Fetch context**: the extension asks the local bridge for relevant memories based on your current input topic
2. **Assemble**: the bridge returns profile & general preferences (first turn of a session) + memories relevant to the current topic
3. **Inject**: implicit mode appends into the request body; visible mode writes into the input box for your review
4. **Retrieval quality**: provided by mneme's hybrid retrieval (mneme ≥ 0.8.14 recommended; injection goes through the upstream `GET /context` pipeline); the `mneme.contextSource="heuristic"` fallback path additionally performs keyword bridging, greeting skip, and meta-memory filtering

## 🧩 Bridge REST API

> The bridge exposes plain HTTP and can be called by any script or client; auth header `Authorization: Bearer <bridgeToken>`.
> `/memory/context`, `/memory/distill`, and `/memory/import*` are project-specific composite capabilities; `save/search/recent/list` forward to mneme's memory APIs.

| Endpoint | Purpose |
|:--|:--|
| `GET /health` | Health check (no auth) |
| `GET /memory/context?q=&topK=` | Fetch injection context by topic (profile + preferences + relevant memories) |
| `POST /memory/search` · `GET /memory/recent` · `/list` | Search / recent / full list |
| `POST /memory/save` | Write one memory |
| `GET /memory/pending` · `DELETE /memory/pending?id=` | Read and remove the pending distillation queue |
| `GET /memory/conversation` | Conversation write with dedup (used by the extension to report conversations) |
| `GET /memory/imported-ids` | Imported session id list (the extension hides already-imported items) |
| `POST /memory/distill` | Distill now |
| `POST /memory/import` · `/memory/import/estimate` | Batch import and estimate |
| `GET /memory/status` | Runtime status |

## 🔧 Configuration (config.json)

| Key | Default | Description |
|:--|:--|:--|
| `port` | 8760 | Listening port |
| `bridgeToken` | Randomly generated on first start | Extension auth credential |
| `mneme.mode` | `auto` | auto (probed once at startup) / embedded / remote; remote is the 8790 REST API (DSH external access or a standalone daemon) |
| `mneme.libPath` / `dataDir` | empty (auto-detect) | Memory-store location for embedded mode |
| `mneme.contextExcludeSensitive` | `true` | Whether injection (/memory/context) excludes memories carrying a sensitivity label — sensitive entries are not sent to the web app with every request |
| `mneme.allowedLibRange` | `^0.8.14` | Version gate for the mneme lib in embedded mode; startup is refused outside the range. Empty string disables the check |
| `distill.enabled` | `true` | Turn off to stop distillation entirely |
| `distill.idleMs` | 10 minutes (fallback when absent from the generated config) | How long a session stays idle before distillation triggers |
| `distill.dshCommand` | `dsh` | The LLM command used for distillation |
| `import.maxImportChars` | 1.5 million | Per-batch import character gate |

## 🛠️ Local development

**Runtime**: Node ≥ 22.5. The bridge has zero npm dependencies — **no `npm install` needed**.

```bash
# Run the bridge in the foreground (logs straight to the console; for debugging)
cd mneme-bridge
node server.js

# Start a second instance with an isolated config (does not disturb the production instance)
# The three env vars MNEME_BRIDGE_CONFIG / _LOG_DIR / _DATA_DIR redirect everything
set MNEME_BRIDGE_CONFIG=F:\temp\dev-config.json
node server.js
```

**Extension-side debugging**: the extension is native MV3 with no build step — after editing the source, click **Reload (↻)** in `edge://extensions`,
and **refresh the DeepSeek page** (content scripts do not hot-reload; this is the step most often forgotten).

**Logs**: `mneme-bridge/logs/` (structured JSON: retrieval hits, distillation batches, error stacks).
The extension's debug output lives in the DeepSeek page's DevTools Console; filter by `[mneme`. The line
`[mneme/cs] content script 版本 0.6.2 mode=implicit` is the fastest way to verify "did my new code actually take effect".

**Before running tests**: the smoke test verifies that the production memory store's mtime/size stay unchanged (zero-write red line), so **do not touch the production store while tests run**.

## 💰 Cost

- **Injection & retrieval**: local SQLite, **zero cost**
- **Distillation**: uses your own DSH model quota; ~55,000 characters of conversation ≈ **¥0.04**

## 🔐 Privacy & security

- All data stays on your machine (SQLite + local files) — **nothing is uploaded to any third party**
- The service listens on localhost/LAN only by default, with Bearer token auth; **LAN use only, never expose it to the public internet**
- The only outbound request is distillation (it calls the model API you configured, with the raw conversation) — if you mind, disable `distill.enabled` and use only manual import and retrieval
- **Injection egress**: every conversation appends the injection block (user profile / behavior rules / interaction preferences / topic-relevant memories) to the request sent to DeepSeek's servers — this is the very point of "bringing memory to the web side". Memories carrying a `sensitivity` label are **not** included in injection blocks by default (`mneme.contextExcludeSensitive`); disable injection if you mind data leaving your machine
- **Page-script risk**: the extension's injection layer runs in the page's main world and communicates with the panel layer via page events. A malicious page script could in theory forge that event and read out the memory store (no bridgeToken needed). A one-time handshake nonce has been added to raise the bar, but this is mitigation, not strong isolation — **enable collection only on sites you trust**

## 🗺️ Known limitations

- Web-side DOM / API changes may require updating extension selectors (the built-in probe logs help locate issues)
- DSH headless CLI credentials must be configured separately (follow the log hints on first distillation)
- Memory **consolidation (dream) is handled on the DSH side** — the bridge only does sedimentation and retrieval; it does not run consolidation loops
- Web conversations **do not enter the entity table** (the entity extractor is wired by the DSH host; the bridge cannot reach it), so the entity-retrieval channel cannot see web memories
- Entries distilled by the bridge **bypass the DSH host's quality gates** (archiving/downweighting and write admission); purity relies on aligning the distillation prompt with upstream
- Sharing is **asymmetric**: the web side writes global memories (visible to all DSH sessions); memories scoped to an agent on the DSH side are invisible to the web side — "web writes global, reads global only", not a bidirectional full sync
- `saveWithDedupe` dedup is check-then-write (no unique constraint at the DB layer); two processes concurrently writing the same title carry a tiny duplicate probability
- Web injection candidates have **no cross-turn rotation**: the upstream `GET /context` is stateless by session (the daemon is deliberately stateless), so under identical pressure the same batch of memories gets picked repeatedly; after retiring the homegrown pins heuristic, the bridge no longer provides rotation of its own — if you mind, the bridge would need to manage it (not implemented; known behavior)
- The session cleaner identifies leftover sessions produced by this bridge by their internal format — an **experimental** capability (four gates against false deletes)
- **Mobile is not implemented yet** — on the roadmap; PRs welcome

## 🙏 Acknowledgments

- **[dsh-mneme](https://github.com/slow-stack/mneme)** (MIT) — the memory foundation of this project. Memory storage, retrieval, and the distillation prompt pipeline are all provided by it; this project only "brings the web side in". Thanks to the upstream author.
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — the host of distillation and the memory store.

## 📄 License

MIT — see [LICENSE](LICENSE). This project contains/depends on [dsh-mneme](https://github.com/slow-stack/mneme) (MIT).
