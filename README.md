# mneme-memory

给 DeepSeek 网页版装上"跨会话记忆"：一个 Edge 浏览器扩展 + 一个本地桥接服务，把你在网页上聊过的对话自动蒸馏成结构化长期记忆，下次开新会话时按话题自动注入。

> 项目名取自 mneme（希腊神话记忆女神）。
>
> **本项目基于 [DSH mneme 插件](https://github.com/slow-stack/mneme)（MIT）构建**：mneme 是运行在 DSH 内的记忆库（存储、蒸馏提示词管线、检索服务），本仓库的桥接层与浏览器扩展以它为记忆底座，把它的能力延伸到 DeepSeek 网页端。使用本项目必须先安装 DSH（mneme 随其安装）。感谢上游项目。

## 它解决什么问题

DeepSeek 网页版没有跨会话记忆——每个新会话都从零开始。本项目的完整闭环：

```
你在网页聊天 → 扩展自动捕获对话 → 本地缓冲队列（可人工把关剔除）
   → 到点自动"蒸馏"成原子记忆（用你自己的 DSH 额度，成本可见）
   → 入本机记忆库 → 下次聊天按话题自动注入相关记忆
```

## 仓库结构

```
mneme-memory-project/
├── mneme-edge-extension/   Edge/Chrome 扩展（MV3，零构建链）
│   ├── manifest.json
│   ├── content/content.js      页面脚本：输入框注入（显式模式）、侧栏面板
│   ├── injected/inject.js      主世界脚本：请求体改写（隐式模式）、对话捕获
│   ├── background.js           后台：bridge 转发、重试队列
│   └── options/                设置页
└── mneme-bridge/           本地桥接服务（Node ≥18，零 npm 依赖）
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

### 前置条件

- Windows（当前启动脚本仅 Windows；其他平台可手动 node 启动）
- [DSH](https://github.com/deepseek-ai/dsh) 已安装并至少启动过一次（记忆库由其 mneme 插件管理）
- Node.js ≥ 18

### 1. 启动桥接服务

双击项目根目录的 **启动mneme-bridge.cmd**：

- **首次运行**会询问"是否注册开机自启"——按 Y 则登录后托盘自动出现，按 N 或直接回车跳过（之后可随时运行 `bridge-launcher.cmd install` 补注册）
- 之后每次运行直接启动托盘常驻（系统托盘区 mneme 图标，右键可打开状态页/重启/退出）

其它启动方式：

```bat
cd mneme-bridge
启动bridge.bat              rem 前台运行（看日志）
start-bridge.vbs            rem 后台隐藏窗口
bridge-launcher.cmd install 注册开机自启
```

首次启动自动生成 config.json 与随机 bridgeToken。

### 2. 安装扩展

Edge 打开 edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 mneme-edge-extension 目录。

### 3. 配置记忆库位置

embedded 模式（推荐）：config.json 的 mneme.libPath / dataDir 留空会自动探测 DSH 默认安装位置；探测失败时按日志提示手工填写。

### 4. 验证

- 浏览器打开 chat.deepseek.com，侧栏出现 mneme 面板且显示"bridge：连通 ✓"
- 随便聊一轮，1-2 分钟后面板「待蒸馏队列」出现条目
- 点「立即蒸馏」，完成后在「记忆库」标签看到蒸出的结构化记忆
- 新开一个会话，DS 已经认识你

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
