# mneme 独立运行方式查证结论（2026-09-28，本机实测）

插件：@modusensus/dsh-mneme **0.8.9**，安装于
`F:\DeepSeek\.dsh\profiles\web\node_modules\@modusensus\dsh-mneme`（DSH_HOME=F:\DeepSeek\.dsh，profile=web）。

## 1. 独立运行方式：没有 daemon 二进制，有两条路

**不存在** `mneme daemon` 命令。官方对外形态：

| 形态 | 实质 | 说明 |
|---|---|---|
| standalone HTTP API (v0.7.12+) | `node:http` 服务，**在 DSH 插件宿主进程内启动** | 开关=`user_settings` kv 表 `external_api`，默认关 |
| bin/cli.mjs (`dsh-mneme`) | 8790 的 HTTP **客户端** | 零依赖，配置 DSH_MNEME_URL/DSH_MNEME_TOKEN > ~/.dsh-mneme/cli.json > 默认 http://127.0.0.1:8790 |
| bin/dsh-mneme-mcp.mjs | stdio MCP server，**数据面仍走 8790** | DSH 不在时调用会失败（源码注释明确） |

**当前 kv 值**（只读自 memory.db）：`{"enabled":false,"port":8790,"host":"127.0.0.1","token":"<mneme-token>"}`
本机探测 8790 → ECONNREFUSED（外部 API 未开启）。**开启方式：DSH 面板「设置 → 外部访问」打开开关，重启 DSH 最稳**（standalone server 在插件 apply 时创建）。

**关键缺口**：DSH 没运行时 8790 不存在 → 网页端断供。→ 引出 bridge 的 **embedded 模式**（见下）。

## 2. 内嵌模式可行性（bridge 真独立的路径）——已验证导出存在

`lib/` 下可直接 import（ESM，零依赖，node:sqlite）：

```js
import { createStore } from ".../lib/store.js";        // createStore(path)
import { createService } from ".../lib/service.js";    // createService({store, mirror, config, logger, documentIndex, writeAdmission})
import { createMirror } from ".../lib/mirror.js";
import { createSettings } from ".../lib/settings.js";  // createSettings(store.db)
import { createStandaloneApi } from ".../lib/api-standalone.js"; // ({service,store,config,logger,settings,maintenance})
```

index.js 的组装顺序（L191-286）：mkdir memoryDir → createStore(memory.db) → createSettings(store.db) → createMirror → createService → recoverMirror。embedded 模式照抄这条链即可得到一个与 DSH 内**同语义**的读写服务（含 saveWithDedupe 去重、mirror 同步、scope 归一）。

限制：autoDream/summarize 需要 LLM 句柄，embedded 下不运行；DSH 在线时照常补跑（写入事件触发），可接受。版本耦合：bridge 启动时打印 mneme 版本，升级后需回归。

## 3. 数据目录：无分裂风险

- 配置 `memoryDir` 默认 `~/.dsh/memory`。
- 本机 `C:\Users\Fan\.dsh\memory` 是 **junction → F:\DeepSeek\.dsh\memory**（已验证 readlink）。
- 活跃库 `F:\DeepSeek\.dsh\memory\memory.db`（~10MB，WAL 模式，busy_timeout 先于 journal 切换设计支持多进程并发）。
- bridge embedded 必须显式指向 `F:\DeepSeek\.dsh\memory`。

## 4. 外部 API 路由全表（README.md L444-533 + 源码路由分支核对）

`Authorization: Bearer <token>`；除 GET /health 外全要 token；401 → {"error":"unauthorized"}。

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | /health | 免鉴权 {ok:true} |
| GET | /status | 版本/统计/实体数/运行时长 |
| GET | /profile、/rules | 用户画像、行为规则 |
| GET | /memories?limit&offset&type&minImportance&source&order=chrono&include_archived&occurred_from&occurred_to | 分页列出 |
| GET/PUT/DELETE | /memories/:id | 读/局部更新(content 改写入档 human_override)/删 |
| POST | /memories | {type,title,content,importance?,tags?,source?,sensitivity?,occurred_at?,agent_scope?,workspace_scope?} → 201 created / 200 merged（同 (type,title,scope) 去重） |
| GET | /search?q&mode=keyword\|vector\|hybrid\|auto&topK&occurred_* | 搜索 |
| POST | /maintenance/reclaim | 无损回收（dry-run 默认） |
| POST | /bootstrap | {dir} 冷启动（零 LLM，幂等） |

type 枚举（save）：preference/project/decision/history/rejected_solution/pitfall/constraint（list 另含 document；summary 仅机器维护）。

## 5. 对结论的影响

- bridge 不必自己实现 MCP：直接对 8790 代理（remote 模式）即可，语义与 DSH 工具一致。
- bridge 的核心增量价值 = **embedded 兜底**（DSH 不在时同库读写）+ 对端（扩展/手机）的简化 REST + token/CORS/LAN。
