# mneme-bridge 设计（v1）

零依赖 Node.js（>=20，global fetch / node:http / node:sqlite 间接）HTTP 服务。**目标文件：本仓库 mneme-bridge/ 目录**。

## 1. 运行形态：双模式 + 启动探测

```
启动 → 探测 http://127.0.0.1:8790/health（1s 超时）
  ├─ 活着  → remote 模式：纯代理（转发到 8790，带 Bearer mneme-token）
  └─ 不在  → embedded 模式：import mneme lib 起 in-process service（同数据目录）
```

- 模式在启动时确定，进程内粘滞（不做热切换；README 说明）。
- `GET /memory/status` 必须回报 `backend: "remote" | "embedded"` 与 mneme 版本。

## 2. 对外 REST（bridge 自有面，面向扩展/手机）

监听 0.0.0.0:8760（config 可改）。鉴权：除 `GET /health` 外 `Authorization: Bearer <bridgeToken>`（timingSafeEqual 常量时间比较，抄 mneme 的实现）。CORS：`Access-Control-Allow-Origin: *` + `Allow-Headers: Authorization, Content-Type` + OPTIONS 预检 204（有 token 兜底，简化放行）。

| 方法 | 路由 | 入参 | 行为 |
|---|---|---|---|
| GET | /health | — | {ok, backend, uptimeMs, mneme:{url或dataDir}} |
| POST | /memory/save | {type,title,content,importance?,tags?,source?,sensitivity?,occurred_at?} | 转发 mneme POST /memories；embedded 走 service.saveWithDedupe |
| POST | /memory/search | {q, mode?=auto, topK?=5} | 转发 mneme GET /search（embedded 走 service.search） |
| GET | /memory/recent | ?limit=10 | mneme GET /memories?order=chrono&limit=N（embedded 走 service.list） |
| POST | /memory/conversation | {user, assistant, url?, sessionId?} | 合成一条 history 记忆：title=「网页对话:」+user 前 40 字；content 为 user/assistant 拼接；tags=["web","edge"]；source="edge-extension"。**bridge 侧再哈希去重**（sha256(user+\\n+assistant) LRU 500 条，重复直接 200 {deduped:true}） |
| GET | /memory/status | — | mneme /status 透传 + backend |

响应统一 JSON；上游 4xx 透传状态码与 error 字段；上游不可达 → 502 {error:"mneme-unavailable"}。

## 3. embedded 模式对接草案

```js
// embedded.js —— 全部从 DSH 实际安装路径 import（config 可覆盖）
const MNEME = "F:/DeepSeek/.dsh/profiles/web/node_modules/@modusensus/dsh-mneme/lib";
const { createStore } = await import(MNEME + "/store.js");
const { createService } = await import(MNEME + "/service.js");
const { createMirror } = await import(MNEME + "/mirror.js");      // 签名以 lib/mirror.js 为准，参照 index.js L191-286 组装
const { createSettings } = await import(MNEME + "/settings.js");
const DATA_DIR = "F:/DeepSeek/.dsh/memory";                        // 活跃库（junction 目标）
const store = createStore(DATA_DIR + "/memory.db");
const settings = createSettings(store.db);
const mirror = createMirror(/* 参照 index.js 组装参数 */);
const service = createService({ store, mirror, config: { language: "zh" }, logger: console });
service.recoverMirror?.();
```

写操作直接 `service.saveWithDedupe(...)`；搜索 `service.search(q, {limit: topK})`；
列表 `service.list({limit, order:"chrono"})`（方法名以 lib/service.js 实际导出为准，实现前先 grep 核对）。
**注意**：embedded 与 DSH 同时开库是设计内场景（WAL + busy_timeout），但 embedded 不跑 autoDream（无 LLM），DSH 在线时补跑——文档明示。

## 4. remote 模式对接草案

```js
async function mneme(pathname, { method = "GET", body, query } = {}) {
  const url = new URL(cfg.mneme.url + pathname);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: "Bearer " + cfg.mneme.token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
```

## 5. 配置与运维

`mneme-bridge/config.json`（首次启动自动生成，gitignore）：
```json
{ "port": 8760, "host": "0.0.0.0",
  "bridgeToken": "<随机 32 字节 base64url，首次生成>",
  "mneme": { "url": "http://127.0.0.1:8790",
             "token": "<mneme-token>",
             "mode": "auto",
             "libPath": "F:/DeepSeek/.dsh/profiles/web/node_modules/@modusensus/dsh-mneme/lib",
             "dataDir": "F:/DeepSeek/.dsh/memory" } }
```
启动：`node server.js`（可后续包 .cmd/VBS 快捷方式）。日志：单行 JSON 到 stdout + logs/bridge.log（轮转 5MB×3）。
安全提示写进 README：0.0.0.0 + 明文 HTTP = token 明文过网，仅限家庭局域网；公网勿开。

## 6. 测试计划（交付前跑完并在 README 勾选）

1. remote 模式（先在 DSH 面板开外部 API）：save → search → recent → conversation 四链路 curl 通过；重复 conversation 命中去重。
2. embedded 模式（关 8790 模拟）：同四链路；写一条后用 DSH `memory_search` 能读到（同库验证）。
3. 双写并发：embedded 写入同时 DSH 会话 memory_search 可见。
4. 鉴权：无 token 401；错 token 401；/health 免鉴权。
5. CORS：带 Origin 的预检 OPTIONS 返回 204 与允许头。
