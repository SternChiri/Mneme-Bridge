# mneme-bridge

mneme 跨端记忆桥：把 DSH 的 mneme 记忆池通过一个带鉴权的 REST 服务暴露给
Edge 扩展、手机等外部消费方。零 npm 依赖，Node >= 22.5（用到 `node:sqlite`
与 `AbortSignal.timeout`）。

## 启动

```bat
node server.js
```

- 首次启动自动生成 `config.json`，并在控制台打印一次 **bridgeToken**（同时写入
  config.json，之后只在配置文件里）。
- 默认监听 `0.0.0.0:8760`。
- 日志：单行 JSON 到 stdout，同时落 `logs/bridge.log`（轮转 5MB × 3）。

### 可选：开机自启 / 双击启动

```bat
:: start-bridge.cmd（放本目录，双击即起）
@echo off
cd /d %~dp0
node server.js
```

任务计划程序挂该 cmd 即可实现开机自启（不依赖用户登录窗口）。

## 双模式（启动时决定，进程内粘滞）

| 模式 | 触发条件 | 行为 |
|---|---|---|
| remote | `mneme.mode` = `"remote"`，或 `"auto"` 且探测到上游 8790 `/health` 活着 | 纯代理：请求转发 DSH standalone API（Bearer mneme token） |
| embedded | `mneme.mode` = `"embedded"`，或 `"auto"` 且 8790 不在 | in-process import mneme lib（版本门控 `allowedLibRange`，建议 ≥0.8.14），直接开 `memory.db`（同库同语义） |

- 探测只在启动时做一次；运行中不热切换（安全理由见 server.js 头注）。
- **remote 的前提**：DSH 面板「设置 → 外部访问」打开（kv `external_api.enabled=true`），
  重启 DSH 最稳。上游重启期间 bridge 会 502，重启 bridge 即落回 embedded。
- embedded 与 DSH 同时开库是设计内场景（WAL + busy_timeout）。embedded 不跑
  autoDream/summarize（需要 LLM），DSH 在线时照常补跑，无数据损失。

## 配置（config.json）

```json
{
  "port": 8760,
  "host": "0.0.0.0",
  "bridgeToken": "<首次自动生成，43 字符 base64url>",
  "mneme": {
    "url": "http://127.0.0.1:8790",
    "token": "<DSH 面板外部访问里的 token>",
    "mode": "auto",
    "libPath": "<DSH_HOME>/profiles/web/node_modules/@modusensus/dsh-mneme/lib  （通常留空即可，自动探测）",
    "dataDir": "<DSH_HOME>/memory  （通常留空即可，自动探测）",
    "probeTimeoutMs": 1000,
    "requestTimeoutMs": 10000,
    "contextPinsLimit": 5,
    "contextExcludeSensitive": true,
    "allowedLibRange": "^0.8",
    "contextRelatedTopK": 6
  },
  "conversation": { "capacity": 500 },
  "import": { "maxImportChars": 50000 },
  "distill": { "enabled": true, "dshHost": "127.0.0.1", "dshWebPort": 3080, "probeIntervalMs": 60000, "dshCommand": "dsh", "headlessTimeoutMs": 240000, "batchLimit": 60 }
}
```

- 环境变量 `MNEME_BRIDGE_CONFIG` 可把配置重定向到任意路径（多实例隔离）；
  `MNEME_BRIDGE_LOG_DIR` 同理重定向日志。
- 换过 mneme token（面板重置）就同步改 `mneme.token`。
- `mneme.contextSource`（v0.6.2）：`/memory/context` 的 pins/related 数据源——`"auto"`（默认，优先上游注入管线端点，失败降级自建启发式）| `"endpoint"`（仅端点，失败即错）| `"heuristic"`（仅自建启发式，等价 0.6.1 行为）。端点路径需 mneme ≥0.8.14（remote 为 `GET /context`，embedded 为 `service.injectCandidates`）。v0.6.2 起自建 pins 两级正则启发式（INTERACT/SCENE）退役移除，降级路径为朴素身份直查（preference/constraint 且 importance≥4）。
- **建议 mneme ≥0.8.14**：`GET /context` 注入管线全语义 + strictScope 图召回绕过修复（#371）。`allowedLibRange` 默认 `^0.8.14`（低于该版本 embedded 拒绝启动，可显式放宽但自担风险）。
- **注入候选的 scope 语义**：bridge 调上游注入管线（`GET /context` / `service.injectCandidates`）不传 scope——bridge 无会话身份，scope 两参全缺在上游语义里是「不解析」而非「匹配任意」。若 mneme 开了 `strictScope`，此时 scope 墙不会立起来，bridge 拿到的是**未经硬过滤的候选集**，不等于任何身份的可见集；bridge 侧只做 sensitivity 排除（`contextExcludeSensitive`）与元记忆过滤（见下），最终出境内容以 bridge 过滤结果为准。
- **元记忆过滤（isMeta）是本地策略**：/memory/context 会把标题形似版本号/组件名、或 tags 含 `meta`/`self_referential` 的条目从注入块剔除。上游 mneme 无此概念，属 bridge 本机启发式，上游文档不描述此行为。

## REST 接口

除 `GET /health` 外一律要求 `Authorization: Bearer <bridgeToken>`
（timingSafeEqual 常量时间比较；也接受 `x-dsh-mneme-token` 头）。

| 方法 | 路由 | 入参 | 行为 |
|---|---|---|---|
| GET | /health | — | 免鉴权；`{ok, backend, uptimeMs, mneme:{url或dataDir}}` |
| POST | /memory/save | `{type,title,content,importance?,tags?,source?,sensitivity?,occurred_at?}` | 转发 mneme `POST /memories`；embedded 走 `service.saveWithDedupe`。返回 201 created / 200 merged |
| POST | /memory/search | `{q, mode?=auto, topK?=5, agentScope?, workspaceScope?}` | remote 转发 mneme `GET /search`、embedded 传 `service.searchMemories` 的 scope 选项（v0.6.2 起两 mode 同口径：scope 两参显式传入即生效——软加权/strictScope 由 mneme 处理；不传行为不变） |
| GET | /memory/recent | `?limit=10` | mneme `GET /memories?order=chrono&limit=N` |
| POST | /memory/conversation | `{user, assistant, url?, sessionId?}` | 合成 history 记忆（title=「网页对话：」+user 前 40 字，tags=`["web","edge"]`，source=`"edge-extension"`）；bridge 侧 sha256(user+\n+assistant) LRU 500 去重，命中直接 `200 {deduped:true}` |
| GET | /memory/status | — | mneme /status 透传 + `backend` 字段 |
| GET | /memory/context | `?q=&topK=`（均可省） | v0.2 组合聚合：一次返回 `{profile, rules, pins, related}`——用户画像 + 行为规则 + 高价值记忆（importance≥5，`contextPinsLimit` 条）+ 相关记忆（q 非空时搜 `contextRelatedTopK` 条）。pins/related 每条只留 `{title,content,importance,type}` 且 content 截 160 字。q 为空时 related=[]（不打搜索）。网页端首开页面调这一个路由即可拿到完整上下文。v0.6.1 起默认排除带 `sensitivity` 标注的条目（`contextExcludeSensitive` 可关）。v0.6.2 起 pins/related 优先来自上游注入管线（`contextSource`，响应附 `via: "endpoint" | "heuristic"` 标记），sensitivity / 元记忆过滤与 4 字段瘦身仍在 bridge 侧 |
| POST | /memory/distill | — | v0.3：手动触发一轮蒸馏（DSH headless 批量总结缓冲的网页对话）。202 受理异步执行；仅 embedded 模式可用（remote 503） |
| POST | /memory/import | `{items:[{user,assistant,url?,sessionId?,kind?,occurred_at?}]}` | v0.4：旧会话批量导入（≤200/批）。合成 history 记忆入蒸馏缓冲；sessionId 进 tags（`imp-sess:<sid>`）供断点续跑；`kind:"summary-card"` 标记摘要卡形态。超 `maxImportChars` 返回 `400 {error:"too-large", estimateChars}` |
| POST | /memory/import/estimate | `{items:[...]}` | v0.4：导入预估器（纯计算不落库）。返回 `{estimateChars, estimateTokens(≈chars/1.6), sessions, maxImportChars, wouldExceed}`——UI 据此渲染「预计消耗」让用户确认后才调 /memory/import |
| POST | /maintenance/purge-headless-sessions | `{dryRun?:boolean}` | v0.6.1：列出/清除 DSH 里本桥接器 headless 蒸馏留下的单轮残留会话。`dryRun:true` 只列不删（`dryRunCount`+`list` 带目录路径）；省略则执行删除（返回 `purged/failed`）。识别走四重闸（会话 cwd 精确等于 bridge 根、目录名=头帧 id、排除 subagent/fork/preset、单/成对 zstd 日志形态），绝不碰用户真实会话 |

- type 枚举（save）：`preference / project / decision / history / rejected_solution / pitfall / constraint`
- CORS 全放开（`*` + `OPTIONS` 预检 204）；真正的门是 token 不是 Origin。
- 上游 4xx 透传状态码与 `error`；上游网络层不可达 → `502 {error:"mneme-unavailable"}`。

## 独立 daemon（v0.6.2 文档，上游 ≥0.8.14）

mneme 0.8.14 起自带独立守护进程 `dsh-mneme-serve`——mneme 第一次能在 DSH 宿主之外常驻，
网页记忆读写不再要求 DSH 开机：

```bash
npx dsh-mneme-serve --memory-dir <DSH_HOME>/memory --port 8790 --host 127.0.0.1
```

- `--embed off|local|ollama|openai` 控制向量检索（默认 `local`，无 DSH 宿主时 remote /search 也有语义路）。
- bridge 在 `mneme.mode="auto"` 下探测 8790 存活即自动落 remote（无需 DSH 面板开「外部访问」）；
  daemon 不在时照常回落 embedded。daemon 与 DSH 宿主是互斥单写者（无 LLM 结构性保证），
  长期方向见上游 #363。
- Phase 2（移动端 PWA）计划基于 daemon 架构，直达 mneme、绕开本 bridge。

## DSH 会话清理（v0.6.1，task-12）

蒸馏走的 `dsh --profile headless` 每次 run 都会在 DSH 的 `~/.dsh/sessions/` 里
落一个单轮持久会话（headless runner 无「不保留会话」参数，DSH 0.2.0-rc.2 实测），
日积月累在 DSH 工作区列表堆出几百个「未分组」残留。bridge 从 v0.6.1 起：

- **自动清理**：每轮蒸馏结束后自动移除本轮及历史蒸馏残留（fail-safe，失败只记日志）。
- **手动清理**：`POST /maintenance/purge-headless-sessions`（`dryRun:true` 预览）。
- **识别安全性**：只动「会话 cwd 精确等于 bridge 根目录」且通过其余三重闸的会话；
  subagent/fork/带预设会话与一切真实用户会话绝不触碰。删除的是会话日志目录，
  DSH 的 sqlite 搜索索引与投影缓存是派生数据，下次启动自动对账收敛（源码核实）。
- **配置**：`sessionCleanup.dshHome`（默认 `~/.dsh`，或 `DSH_HOME` 环境变量）、
  `sessionCleanup.minAgeMs`（候选目录 mtime 距今小于该值的跳过，防并发竞态，默认 5000）。

## 安全（务必读）

- 服务绑 `0.0.0.0` 且为**明文 HTTP**：token 明文过网。**仅限家庭/可信局域网，
  公网勿开**。要出公网请套反代（Caddy/nginx + TLS）或 VPN。
- bridgeToken 与 mneme token 是两套独立凭证：前者保护 bridge 自身，后者只在
  bridge → 8790 的服务端链路上使用，扩展侧永远只需要 bridgeToken。
- token 泄露处置：改 config.json 的 bridgeToken 重启；mneme 侧在 DSH 面板重置。
- 所有写操作都会进 mneme 审计面（source 字段区分来源），可回溯。

## 导入三层漏斗（v0.4）

旧会话批量导入的成本控制（设计：docs/import-cost-design.md）：

- **L1/L2 在扩展侧**（面板勾选 + 本地摘要卡），bridge 只承接 L3。
- **预估确认**：`POST /memory/import/estimate` 纯计算不落库，`estimateChars` 与
  落库口径字节一致（user/assistant 各截 8000 后的 content 长度）；`estimateTokens ≈ chars/1.6`。
- **字符闸**：`config.import.maxImportChars`（默认 50000）。import 落库前最后确认，
  超限 `400 {error:"too-large", estimateChars}`——不静默截断（L3 确认过的预算数字必须真实）。
- **断点续跑**：sessionId 进 tags（`imp-sess:<sid>`），蒸馏按会话粒度跳过已完成会话；
  同会话迟到批次不重复烧 LLM，且被跳过条目也标 `distilled` 排空状态机。
  无 sessionId 的旧扩展条目退回条目级处理（v0.3 行为不变）。
- **摘要卡蒸馏**：导入 item 带 `kind:"summary-card"` 时，蒸馏提示词切换为
  「提炼跨会话的持久偏好/项目脉络/重要决定，单会话细节一律丢弃」。

```bat
:: 扩展侧典型序列
curl -X POST .../memory/import/estimate  # 1. 预算确认（UI 显示 ≈X token）
curl -X POST .../memory/import           # 2. 确认后分批导入（≤200/批，字符闸兜底）
:: 3. DSH 启动时 dsh-probe 自动蒸馏；同会话迟到批次自动跳过
```

## 测试

```bat
node scripts/smoke.mjs
```

覆盖：假 mneme 打桩下的 remote 四链路（save/search/recent/conversation+去重）、
副本库下的 embedded 同四链路、401/502/超时分支、OPTIONS 预检、
生产库零接触校验（前后 stat 对比）。**smoke 不写生产库**——embedded 链路跑在
复制到临时目录的库副本上（含 -wal/-shm）。最近一次结果：**114/114 PASS**（v0.6.2 含 /context 端点优先与降级、scope 透传断言；历史版本含 estimate 预估/字符闸/断点续跑端到端断言）。

设计文档核对项（docs/mneme-bridge-design.md §6）：

- [x] remote 四链路 + conversation 去重（假 mneme 打桩验证）
- [x] embedded 四链路（副本库）+ DSH memory_search 可读（同库同表，写链路同语义）
- [x] 鉴权：无 token 401 / 错 token 401 / /health 免鉴权
- [x] CORS：带 Origin 预检 204 + 放行头
- [ ] 双写并发实测（embedded 写入同时 DSH memory_search 可见）：需要 DSH 在线时
      人工跑一次，见上节「同库同语义」与 smoke 的副本库直查断言（链路已覆盖）
- [x] 超时 → 502（假 mneme 慢路径打桩，1s 触发）

## 故障排查

| 症状 | 排查 |
|---|---|
| 启动即退 `port in use` | 已有 bridge 在跑（或 8760 被占）；改 config.port |
| remote 下全 502 | DSH 是否开着、面板外部访问是否 enabled、token 是否一致 |
| embedded 启动失败 cannot import | libPath 指向的 mneme 版本是否存在；Node 版本 >= 22.5 |
| 扩展 401 | 扩展配置的 token 与 config.json 的 bridgeToken 是否一致 |
| 同标题写入总被 merged | 这是 mneme 的 (type,title,scope) 去重语义，非 bug；要并存就换标题 |

## 对话蒸馏器（v0.3，全自动）

网页端对话不再逐轮堆进记忆库：扩展上报的对话先缓冲（tags 标记 `pending-distill`），
**DSH 一启动，bridge 自动把缓冲的对话批量交给 DSH headless 蒸馏**成精炼的 mneme 记忆条目入库
（source=`dsh-distiller:web/<会话id>`，tags 带 `distilled`），原始对话随后标记完成。DSH 没开时一切静默。

### 数据流

```
网页对话 → bridge 缓冲(pending-distill) → [DSH 启动被探测到] → 按会话分组
  → dsh --profile headless 批量总结(每会话一次调用) → 解析 JSON → 正式记忆入库
  → 原始行标记 distilled
```

### 配置（config.json 的 distill 段，均有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | false 时完全关闭（探测也不跑） |
| dshHost / dshWebPort | 127.0.0.1 / 3080 | DSH Web 探测目标 |
| probeIntervalMs | 60000 | 探测周期 |
| dshCommand / dshArgs | "dsh" / [] | headless 命令（PATH 无 dsh 时改全路径） |
| headlessTimeoutMs | 240000 | 单次 headless 超时 |
| batchLimit | 60 | 单轮最多蒸馏条数 |

### 注意

- 蒸馏仅在 **embedded 模式**可用（remote 下 8790 无按 tags 查询能力，日志会提示 distiller-unavailable）
- 验证：`node scripts/distill-test.mjs`（副本库 + 假 dsh 全链路，生产库零接触）
- 蒸馏提示词按 mneme 七型记忆标准（preference/project/decision/history/pitfall/constraint/rejected_solution）总结，合并重复、丢弃寒暄
