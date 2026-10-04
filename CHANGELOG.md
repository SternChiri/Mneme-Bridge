# Changelog

本项目由两个组件构成，**自 v0.6.0 起统一版本号**（同版本号即代表一组兼容快照）：

| 组件 | 形态 | 版本 |
|---|---|---|
| **mneme-bridge** | 本地 Node 服务（托盘常驻） | 0.6.0 |
| **mneme-bridge-ext** | Edge / Chrome 扩展（MV3） | 0.6.0 |

版本号规则：小修 → `0.6.x`；新功能 → `0.7.0`；破坏性变更 → `1.0.0`（留给三端全通之日）。

---

## v0.6.2 — headless 蒸馏会话不残留（mneme-bridge）

### 🧹 DSH 会话清理（task-12）

- **问题**：`dsh --profile headless` 每次蒸馏都在 DSH `~/.dsh/sessions/` 留一个单轮持久会话（headless runner 无「不保留会话」参数，DSH 0.2.0-rc.2 源码核实），积累约 190 个「未分组」残留污染工作区列表
- **自动清理**：每轮蒸馏结束后自动移除蒸馏残留会话（`lib/session-cleaner.js`；fail-safe——失败只记日志，绝不阻塞蒸馏主流程）
- **手动清理**：新增 `POST /maintenance/purge-headless-sessions`（Bearer bridgeToken 鉴权；`dryRun:true` 只列不删预览）
- **四重识别闸防误删**：会话 cwd 精确等于 bridge 根目录 ＋ 目录名与头帧 id 一致 ＋ 排除 subagent/fork/带预设会话 ＋ 日志文件呈单/成对 zstd 标准形态；另设 mtime 时间闸防并发蒸馏竞态。用户真实会话与 DSH 其他工作区数据零触碰
- **数据完整性**：删除的只是会话日志目录；DSH 的 sqlite 搜索索引与投影缓存均为派生数据，DSH 启动时对账自动收敛（`dsh-session-query-sqlite` 源码核实）
- **配置**：新增 `sessionCleanup: { dshHome, minAgeMs }`（默认 `~/.dsh`／5 秒）
- **测试隔离**：smoke 的 `sessionCleanup.dshHome` 重定向到临时目录，绝不碰真实 `~/.dsh/sessions`（与生产库零写红线同级纪律）

## v0.6.0 — 首个公开版本

**一套记忆，双端共享。** 网页端对话自动捕获 → 本地缓冲 → DSH 蒸馏 → 写入 mneme 记忆库 → 按话题注入下一次网页对话。至此 DSH 与 DeepSeek 网页版共用同一个记忆大脑。

### ✨ 记忆注入

- **双路径注入**：隐式（记忆拼进请求体，输入框无感）／可见（记忆块写入输入框，可查看、编辑、删除）
- **首轮全量、后续按需**：会话首轮注入用户画像与通用偏好，此后每轮只注入与当轮话题相关的记忆，不重复占用上下文
- **检索质量增强**：语义检索 + 关键词补路 + 寒暄自动跳过 + 元记忆过滤
- **同场对话不重复注入**：识别首页 → 会话页的 URL 迁移，避免把同一场对话误判成新会话

### 💾 记忆沉淀

- **新会话自动捕获**：每轮对话入队本地缓冲，同会话自动去重；队列条目可人工剔除后再蒸馏
- **会话静默后自动蒸馏**：默认 10 分钟无新轮次触发，整会话一次调用，避免逐轮碎片化
- **旧会话手动导入**：两条路径可选——
  - 生成摘要卡（本地取会话首尾消息，零 API 成本）
  - 全量导入（携带完整对话，适合重要会话）
- **导入保护**：会话数上限 + 字符预算闸（默认 150 万字符）+ 导入前预估确认；超限明确报错，绝不静默截断
- **可溯源**：产出的记忆带 `web/<会话id>` 标签，可回溯到具体网页对话
- **断点续跑**：中断（进程被杀 / DSH 中途离线）后重跑不会重复烧 API

### 🛠️ 部署与运维

- **零依赖**：桥接服务仅用 Node 标准库（无需 npm install）；扩展为原生 MV3（无构建链）
- **一键启动**：`启动mneme-bridge.cmd` 托盘常驻，首次运行可选用登录自启
- **记忆库自动探测**：留空即按 `$DSH_HOME` / `~/.dsh` 探测；失败时给出可操作的报错指引
- **96 项端到端自检**：`node scripts/smoke.mjs`，测试环境完全隔离，并校验生产库零写入

### 🔧 配置

- `mneme.mode`：auto / embedded / remote 三种后端模式
- `distill.*`：蒸馏开关、静默阈值、批大小
- `import.maxImportChars`：导入字符闸

### 📋 已知限制

- 启动脚本目前仅 Windows（其他平台可 `node server.js` 手动运行）
- 移动端（PWA）尚未实现
- 网页端 DOM / 接口改版时可能需要更新扩展选择器

### 🙏 致谢

- **[dsh-mneme](https://github.com/slow-stack/mneme)**（MIT）——记忆基座。记忆的存储、去重合并、冲突裁决、语义检索均由它提供
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**——蒸馏与记忆库的宿主

详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
