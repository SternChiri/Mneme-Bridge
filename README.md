<div align="center">

# Mneme Bridge

**打通 DSH 与 DeepSeek 网页版的记忆 —— 一套记忆，双端共享**

[![Built on mneme](https://img.shields.io/badge/built%20on-dsh--mneme-8B5CF6?style=flat-square)](https://github.com/slow-stack/mneme)
[![License](https://img.shields.io/badge/license-MIT-3E63DD?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-3E63DD?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Extension](https://img.shields.io/badge/extension-MV3-3E63DD?style=flat-square&logo=microsoftedge&logoColor=white)](https://github.com/SternChiri/Mneme-Bridge)

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

### 第 1 步 · 下载项目

```bash
git clone https://github.com/SternChiri/Mneme-Bridge.git
cd Mneme-Bridge
```

或仓库页面 → **Code** → **Download ZIP** 解压（路径别含空格或中文）。解压后你会看到两个目录：`mneme-bridge/`（本地服务）与 `mneme-edge-extension/`（浏览器扩展）。

### 第 2 步 · 启动桥接服务

双击项目根目录的 **启动mneme-bridge.cmd**：

- **首次运行**会问你"是否注册开机自启"——按 Y 常驻，按 N 或回车跳过（之后可跑 `bridge-launcher.cmd install` 补注册）
- 之后运行即启动托盘常驻（右键托盘图标可打开状态页 / 重启 / 退出）

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

### 第 3 步 · 安装浏览器扩展

1. Edge 打开 `edge://extensions`
2. 打开 **开发人员模式**
3. 点 **加载解压缩的扩展** → 选 `mneme-edge-extension` 目录

### 第 4 步 · 把 token 填进扩展

`edge://extensions` → **Mneme Bridge for DeepSeek** → **详细信息** → **扩展选项**，然后：

| 字段 | 填什么 |
|:--|:--|
| **Bridge 地址** | `http://127.0.0.1:8760`（默认，一般不用改） |
| **访问 Token** | 粘贴第 2 步复制的 `bridgeToken`（必填，否则连接被拒） |
| 启用记忆注入 | ☑ |
| 自动收集对话 | ☑（不勾则不会捕获对话、无法蒸馏） |

保存后**重新加载扩展（↻）并刷新 DeepSeek 页面**——此步不能省，扩展脚本不会热更新。

### 第 5 步 · 验证

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
4. **检索质量**：由 mneme 的混合检索提供，桥接层额外做关键词补路、寒暄跳过与元记忆过滤

## 🧩 桥接服务的 REST 接口

> 桥接服务对外是纯 HTTP，可被任意脚本或其他客户端调用，鉴权头 `Authorization: Bearer <bridgeToken>`。
> 其中 `/memory/context`、`/memory/distill`、`/memory/import*` 是本项目专有的组合能力；`save/search/recent/list` 是对 mneme 记忆 API 的转发。

| 接口 | 用途 |
|:--|:--|
| `GET /health` | 健康检查（免鉴权） |
| `GET /memory/context?q=&topK=` | 按话题取注入上下文（画像 + 偏好 + 相关记忆） |
| `GET /memory/search?q=` · `/recent` · `/list` | 检索 / 最近 / 全部列表 |
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
| `mneme.mode` | `auto` | auto（探测 DSH API）/ embedded / remote |
| `mneme.libPath` / `dataDir` | 空（自动探测） | embedded 模式的记忆库位置 |
| `mneme.contextExcludeSensitive` | `true` | 注入（/memory/context）是否排除带 sensitivity 标注的记忆——敏感条目不随每轮请求发往网页端 |
| `mneme.allowedLibRange` | `^0.8` | embedded 模式 mneme lib 版本门控；超出区间拒绝启动。空串关闭校验 |
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
扩展的调试输出在 DeepSeek 页面的 DevTools Console，过滤 `[mneme` 即可；`[mneme/cs] content script 版本 x.x.x`
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
- 会话清理器按内部格式识别本桥接产生的残留会话，属**实验性**能力（四重闸防误删）
- **移动端尚未实现**——路线图上，欢迎 PR

## 🙏 致谢

- **[dsh-mneme](https://github.com/slow-stack/mneme)**（MIT）——本项目的记忆底座。记忆的存储、检索、蒸馏提示词管线全部由它提供，本项目只做"把网页端接进来"。感谢上游作者。
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**——蒸馏与记忆库的宿主。

## 📄 License

MIT —— 详见 [LICENSE](LICENSE)。本项目包含/依赖 [dsh-mneme](https://github.com/slow-stack/mneme)（MIT）。
