# mneme-memory

给 DeepSeek 网页版装上"跨会话记忆"：一个 Edge 浏览器扩展 + 一个本地桥接服务，把你在网页上聊过的对话自动蒸馏成结构化长期记忆，下次开新会话时按话题自动注入。

> 项目名取自 mneme（希腊神话记忆女神）。**本项目基于 [DSH mneme 插件](https://github.com/slow-stack/mneme)（MIT）构建**，以它的记忆库为唯一记忆源；使用前请先安装 DSH（mneme 随其安装）。
>
> **注意：本项目不是 DSH 插件**，也不安装在 DSH 里——它是一个独立的浏览器扩展 + 本地桥接服务，与 mneme 记忆库协同工作（mneme 管 DSH 内的记忆，本项目把网页端的对话接入同一份记忆库）。

**核心特性：一套记忆，双端共享。** DSH（桌面 Agent）与 DeepSeek 网页版各自为政、记忆互不相通——本项目把两边打通：网页对话实时捕获、由 DSH 蒸馏成原子记忆存入本地记忆库；之后无论你在 DSH 里干活、还是在网页上闲聊，同一份记忆都会按话题自动注入。你的 AI 记忆不再有孤岛。感谢上游项目。

## 它解决什么问题

DeepSeek 的记忆是分裂的：DSH 有一套（mneme），网页版什么都没有，两边的对话经历互不相通。本项目把网页端接入同一份记忆库，让记忆在 DSH 与网页之间自由流动。完整闭环：

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

三步：**起服务 → 装扩展 → 把 token 填进扩展**。

### 前置条件

- Windows（启动脚本目前仅 Windows；其他平台可手动 `node server.js`）
- [DSH](https://github.com/deepseek-ai/dsh) 已安装并至少启动过一次（记忆库 mneme 随其安装）
- Node.js ≥ 18

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
查看方式：用记事本打开 `mneme-bridge/config.json`，复制 `bridgeToken` 的值（或托盘图标右键 →「打开状态页」）。

> 记忆库位置（可选）：`mneme.libPath` / `mneme.dataDir` 留空会自动探测 DSH 安装目录；探测失败时日志会给出明确提示，按提示手工填写即可。

---

### 第 2 步：安装浏览器扩展

1. Edge 打开 `edge://extensions`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择 `mneme-edge-extension` 文件夹
4. 扩展出现在列表中即安装成功

---

### 第 3 步：把 bridgeToken 填进扩展（关键）

1. 在扩展列表里点 **Mneme Bridge for DeepSeek → 扩展选项**（或点扩展图标 → 选项）
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
   - 若显示未连通：检查 ① 服务是否在跑（托盘图标/浏览器打开 `http://127.0.0.1:8760/health` 应返回 JSON）② token 是否复制完整（无多余空格）
2. 随便聊一轮 → 面板「待蒸馏队列」出现条目
3. 点「立即蒸馏」→ 完成后在「记忆库」标签看到蒸出的结构化记忆
4. **新开一个会话**，你会看到 DS 已经认识你（注入的记忆块）。

---

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 面板显示未连通 | token 未填 / 填错 / 服务未启动（见第 4 步排查） |
| 改了设置没反应 | 扩展需重新加载（↻）+ 页面刷新 |
| 队列一直不出现条目 | 选项页「自动收集对话」未勾选 |
| 蒸馏报错 | DSH headless CLI 凭证需单独配置，按 `mneme-bridge/logs/` 内日志提示处理 |

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
