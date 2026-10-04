## 一套记忆，双端共享

网页端对话自动捕获 → 本地缓冲 → DSH 蒸馏 → 写入 mneme 记忆库 → 按话题注入下一次网页对话。
至此 **DSH 与 DeepSeek 网页版共用同一个记忆大脑**。

> 本项目基于 [dsh-mneme](https://github.com/slow-stack/mneme)（MIT）构建，以它的记忆库为唯一记忆源。
> **不是 DSH 插件**——独立的浏览器扩展 + 本地服务。

### 📦 下载

下载后解压，双击 **`启动mneme-bridge.cmd`**，再按 [README 快速开始](https://github.com/SternChiri/Mneme-Bridge#-快速开始) 装扩展即可。

### ✨ 记忆注入

- **双路径注入**：隐式（拼进请求体，输入框无感）／可见（写进输入框，可查看编辑删除）
- **首轮全量、后续按需**：首轮带画像与通用偏好，之后每轮只注入当轮话题相关的记忆
- **检索质量增强**：语义检索 + 关键词补路 + 寒暄跳过 + 元记忆过滤
- **同场对话不重复注入**：识别首页 → 会话页的 URL 迁移

### 💾 记忆沉淀

- **新会话自动捕获**：每轮入队，同会话去重，队列条目可人工剔除
- **静默后自动蒸馏**：默认 10 分钟无新轮次触发，整会话一次调用
- **旧会话手动导入**：摘要卡（零 API 成本）／全量导入（完整对话）两条路径
- **导入保护**：会话数上限 + 字符闸（150 万字符）+ 预估确认，超限明确报错
- **可溯源**：记忆带 `web/<会话id>` 标签；**断点续跑**不重复烧 API

### 🛠️ 部署

- **零依赖**：桥接仅用 Node 标准库；扩展原生 MV3 无构建链
- **一键启动**：托盘常驻 + 可选登录自启
- **96 项端到端自检**：`node scripts/smoke.mjs`（环境隔离 + 生产库零写红线）

### 🔧 环境要求

| 依赖 | 要求 |
|---|---|
| 系统 | Windows 10/11 |
| Node.js | **≥ 22.5**（依赖内置 `node:sqlite`） |
| DSH | 已安装并至少启动一次 |
| mneme 插件 | 已在 DSH 中自行安装 |

### 📋 已知限制

- 启动脚本目前仅 Windows
- 移动端（PWA）尚未实现
- 网页端改版时可能需要更新扩展选择器

### 🙏 致谢

- [dsh-mneme](https://github.com/slow-stack/mneme) — 记忆基座（存储 / 去重合并 / 冲突裁决 / 语义检索）
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 蒸馏与记忆库的宿主

**完整变更记录**：见 [CHANGELOG.md](https://github.com/SternChiri/Mneme-Bridge/blob/main/CHANGELOG.md)
