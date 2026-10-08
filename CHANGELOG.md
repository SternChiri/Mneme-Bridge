# Changelog

本项目由两个组件构成，**自 v0.6.0 起统一版本号**（同版本号即代表一组兼容快照）：

| 组件 | 形态 | 版本 |
|---|---|---|
| **mneme-bridge** | 本地 Node 服务（托盘常驻） | 0.6.3 |
| **mneme-bridge-ext** | Edge / Chrome 扩展（MV3） | 0.6.1 |

版本号规则：小修 → `0.6.x`；新功能 → `0.7.0`；破坏性变更 → `1.0.0`（留给三端全通之日）。

---

## v0.6.3 — 按上游 #363 维护者核对意见修正

### 🛠 桥接

- **remote /context 端点候选数对齐**：端点请求 `topK` 改为 `topK + pinsLimit`，与 embedded `injectCandidates` 同口径（此前 remote 只传 topK，切到端点路径时 related 最多少出 pinsLimit 条）
- **版本门控下界钉 0.8.14**：`mneme.allowedLibRange` 默认 `^0.8` → `^0.8.14`（吃上游 strictScope 图召回绕过修复 #371）；区间语法扩展支持三段式 `^MAJOR.MINOR.PATCH`（minor 大于放行，minor 等则比 patch）

### 📖 文档

- README 明确三项注入语义（上游 #363 维护者指出需文档化）：① scope 墙语义——bridge 调注入管线不传 scope，`strictScope` 下 bridge 拿到的是未硬过滤候选集，不等于任何身份的可见集；② 元记忆过滤（isMeta）是 bridge 本地策略，上游无此概念；③ 网页注入候选无跨轮轮换（/context 无会话状态，daemon 刻意无状态），属已知行为
## v0.6.2 — /memory/context 接入上游注入管线端点

### 🆕 桥接

- **注入候选上游化（mneme ≥0.8.14）**：`/memory/context` 的 pins/related 数据源升级——remote 模式优先调 mneme `GET /context`（#370，宿主注入管线全语义：优先级分层 / pin 前置 / 质量加权 / coding 门控），embedded 模式直调 `service.injectCandidates`；v0.5.24 起自建的两级 pins 启发式（INTERACT/SCENE 正则）整体降级为 fallback，`mneme ≥0.8.14` 时默认不再走。bridge 侧职责保留：sensitivity 过滤（v0.6.1 约定）+ 元记忆过滤 + 4 字段瘦身 + `{profile, rules, pins, related}` 兼容形状（items 前 pinsLimit 条 → pins，其余 → related，上游已按注入优先级排序）
- **新配置 `mneme.contextSource`**：`"auto"`（默认，端点优先失败降级）| `"endpoint"`（仅端点，失败即错）| `"heuristic"`（仅自建启发式，等价 0.6.1 行为）
- **`/memory/search` scope 透传（embedded / remote 全线）**：路由层解析可选 `agentScope`/`workspaceScope` 字符串参数——remote 上 query（`agent_scope`/`workspace_scope`），embedded 传 `searchMemories` 的 scope 选项（0.8.0 A2 起 lib 收参）；只在显式传入时生效（软加权 / strictScope 硬过滤由 mneme 内部处理），不传行为逐字节不变
- **`via` 标记**：`/memory/context` 响应附 `via: "endpoint" | "heuristic"` 数据源标记，便于调试与观测
- **自建 pins 启发式退役（v0.5.24~v0.5.28 那套）**：embedded 的 INTERACT/SCENE 两级正则白名单 + 场景门控整体移除，不再维护；remote 降级 pins 从 `minImportance=5 + chrono` 改为 **preference/constraint 且 importance≥4 按重要度**（与 embedded 降级直查同口径）。上游注入管线已按宿主全语义选 pins，正则白名单完成历史使命
- mneme 建议 ≥0.8.14（strictScope 图召回绕过修复 #371；`allowedLibRange` ^0.8 不变）

---

## v0.6.1 — 安全加固与 headless 会话不残留

### 🔐 安全（上游 Discussion #363 维护者建议）

- **页面脚本伪造防护（扩展）**：注入层与面板层之间的 `bg` 命令转发加一次性握手 nonce——chat.deepseek.com 上任何页面脚本此前可伪造事件经面板层代发 bridge 命令读出记忆库（无需 bridgeToken）。现为缓解措施而非强隔离，README「隐私与安全」已明示
- **敏感记忆不出境（桥接）**：`/memory/context` 组装端默认排除带 `sensitivity` 标注的记忆，敏感条目不再随每轮请求发往 DeepSeek 服务器。新配置 `mneme.contextExcludeSensitive`（默认 `true`），embedded / remote 两模式同口径
- **数据流向与已知限制文档化**：README 补记注入出境说明、巩固（dream）归属 DSH 侧、网页记忆不进实体表、绕过宿主质量闸、「网页进全局、只读全局」的 scope 不对称、saveWithDedupe 并发重复概率、会话清理实验性标注

### 🛡️ mneme lib 版本门控（桥接）

- embedded 模式装载 mneme lib 前校验版本（读安装包 package.json，`mneme.allowedLibRange` 默认 `^0.8`）——lib 内部签名无稳定性契约，上游发版不再可能静默炸断桥接；超出区间明确报错并提示放宽方式

### 🧹 DSH headless 会话不残留（mneme-bridge）

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

---

## v0.5.x — 注入策略打磨与蒸馏工程化（统一版本号前，扩展 0.5.x / 桥接 0.5.x 独立演进）

### ✨ 注入策略（扩展）

- **注入方式成熟**：隐式（记忆拼进请求体，输入框无感）与可见（记忆块写入输入框，可查看编辑）双路径并存；visible 模式最终采用 `innerText` 直赋（`execCommand('insertText')` 在该输入框不可靠）
- **首轮全量、后续按需**：会话首轮注入画像/偏好，后续轮只注入与当轮话题相关的记忆（skipGlobal）；每一轮都注入 related，移除「同会话后续轮次跳过」
- **不重复注入**：识别请求体历史里已带回传的注入块（含 share 页等 sid 不可得导致新会话误判的场景）；识别首页 → 会话页 URL 迁移，避免把同一场对话误判成新会话
- **注入时机**：发送前即时预取——按 Enter 或点发送按钮的瞬间用输入框最终全文；sessionId 改用请求体 `chat_session_id`（URL 匹配在该站点路由下不可靠）

### 🧵 蒸馏与队列（桥接）

- **会话静默触发蒸馏**：原料进 bridge 缓冲（不落 mneme），sessionId/kind 进缓冲行；LLM tags ≤4，occurred_at 沿用源条目会话时间，source 带会话短 id（mneme UI 来源列可读）
- **一次会话一次蒸馏**：同会话全部待蒸条目进池、按会话分组一次调用（修复过「只蒸首条、其余被静默标 done」的内容丢失事故）；批量上限截断时不整会话排空，迟到条目也标记 done 不留永久 pending
- **提示词与解析对齐上游**：正文逐字对齐 mneme `PROMPTS.codingSummary.zh`；解析对齐上游 `parseSummaryJsonResult`（七型白名单）；坏 JSON 抢救扫描器（对齐上游 salvageArrayItems）——中段语法错误不致整窗记忆丢失
- **手动「立即蒸馏」**：强制全量（含活跃会话）；蒸馏请求串行排队，撞锁不再静默丢弃

### 🗂️ 面板与队列管理（扩展 + 桥接）

- 待蒸馏队列嵌入「记忆维护」面板：查看、刷新、逐条删除（事件委托）、立即蒸馏
- 记忆库分组浏览：recent + 按 mneme 类型并发拉取；多方式排序（修改时间/轮次/标题，键归一防退化）
- 新增 `/memory/list`（按类型/分组）、`/memory/pending`（查看 + DELETE）、`/memory/imported-ids`（已入库集合，导入列表据此隐藏）
- 配置增量同步：单键 patch 不全量刷 UI

### 🗿 pins 启发式（桥接，0.5.24~0.5.28，v0.6.2 退役）

- INTERACT/PROJECTISH/SCENE 两级正则白名单 + 场景门控，是上游注入管线开放前的注入选材方案；完成历史使命后整体退役为朴素直查 fallback

---

## v0.4.x — 旧会话导入与断点续跑（扩展 0.4.x / 桥接 0.4.x）

### 📥 旧会话导入

- **导入三层漏斗**：会话列表 → 摘要卡/全文选择 → 分批写入；双按钮——生成摘要卡（本地取首尾消息，零 API 成本）/ 全量导入（完整对话，适合重要会话）
- **导入保护**：预估器（纯计算不落库）+ 字符预算闸 + 导入前确认；超限明确报错不静默截断；预估费用按 DeepSeek 官方最便宜模型定价
- **会话溯源**：导入条目必须带会话 id（否则原料 session_id=null，蒸出的记忆无法溯源）；已入库会话在列表中隐藏
- **大数据通道**：batches 留在 injected 侧全局持有，不再跨 world 传大数组；估算请求重试 4 次（SW 冷启动竞态）、90s AbortController 超时；进度文案动态切换避免「看似卡死」

### ⏯️ 断点续跑（桥接）

- **会话级断点续跑**：蒸馏前查会话标记（tags 的 `imp-sess:<sid>distilled`），已完成会话整组跳过——中断（进程被杀 / DSH 中途离线）重跑不重复烧 API
- null-sid 历史原料按 24 条分块摊平，避免一次巨型 headless 调用
- 缓冲队列查看器（待蒸馏条目 + 右下角「立即蒸馏」）

---

## v0.3.x — 面板与导入基建（扩展 0.3.x / 桥接 0.3.x）

### 🎛️ 面板

- 唯一入口 = DeepSeek 左侧栏底部「记忆设置」菜单项（与「系统设置/帮助与反馈」并列），删除悬浮球；系统设置式双栏布局，视觉全面对齐 DeepSeek 设计系统（样式从原生行探测复制）
- 记忆库浏览（最近 + 按类型分组）、排序、配置面板（注入方式单选 + 闸值）

### 📦 导入基建

- 旧会话导入（任务驱动）+ DeepSeek 官方导出 JSON 导入（本地解析，覆盖接口拿不到的更早会话；突破接口 100 条限制）
- 按 DS 真实结构解析：sessions/mapping/fragments（REQUEST/THINK/RESPONSE，思维链丢弃）；时间戳三形态归一（DS 是秒级 float）；role 缺失按片段类型推断
- MAIN world 无 `chrome.runtime`：命令统一经 content 转发到 background；导入器自带请求加 `mneme-no-capture` 头绝不拦截

### 🏗️ 蒸馏管线（桥接）

- 会话静默触发蒸馏（task 送达历经三轮：argv 直传大任务 ENAMETOOLONG → stdin 喂法被 0.1.x CLI 拒绝 → win32 临时文件 / 非 Windows stdin）
- tags 继承 `imp-sess:<sid>`（按会话过滤、溯源）；时间戳统一 ISO

---

## v0.2.x — 隐式注入与对话捕获（扩展 0.2.x / 桥接 0.2.x）

### ✨ 隐式注入（扩展）

- fetch 覆写把记忆块拼进 chat/completion 请求体最后一条 user 消息前；支持 fetch(Request 对象) 与 URLSearchParams，XHR 兜底
- 发现 DeepSeek 真实 schema 含顶层 prompt 字段；msgs 循环未命中时兜底尝试

### 🎙️ 对话捕获（扩展）

- SSE 收集器（fetch / XHR 共用）：识别 fragment 切换信号、THINK→正文 切换；thinking 双缓冲（流结束时 assistant 为空则用 thinkBuf）；inThink 门控覆盖所有分片来源
- DOM 终审：thinking 回退内容是散文混合体，等 800ms 取渲染后结果

### 🔎 检索（桥接 + 扩展）

- getContext 组合检索（画像/规则/高价值/相关），六方法接口面加 context；老 bridge 无该端点时扩展自动回退 search/recent 直查

---

## v0.1.x — 原型（初版）

- 检索走 `search`/`recent` 直查；消息协议经 background 中转
- 每轮对话捕获入队，同会话去重——记忆沉淀管线的雏形
