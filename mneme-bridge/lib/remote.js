// lib/remote.js —— remote 模式后端：纯代理 DSH standalone API（默认 127.0.0.1:8790）
// 语义对齐 mneme REST 全表（mneme-verification.md §4）：
//   POST /memories → 201 created / 200 merged
//   GET  /search?q&mode&topK
//   GET  /memories?limit&offset&order=chrono&...
//   GET  /status、GET /health
// bridge 只做转发与鉴权剥离：到达这里之前请求已通过 bridgeToken 校验，
// 上游鉴权用 config 里预填的 mneme token（与 bridgeToken 是两套独立凭证）。
import { loggerFor } from "./log.js";

const log = loggerFor("remote");

/**
 * 组装上游 URL。query 里 undefined/null 的键直接跳过——URLSearchParams 会把
 * null 序列化成 "null" 字符串发给上游，属隐性脏数据。
 */
function buildUrl(base, pathname, query) {
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * 创建 remote 后端。
 * @param {{ url: string, token: string, requestTimeoutMs: number,
 *           contextPinsLimit?: number }} mnemeCfg  config.mneme 切片
 */
export function createRemoteBackend(mnemeCfg) {
  // 尾斜杠归一：config 里 url 写成 http://host:8790/ 时避免拼出 //search
  const base = mnemeCfg.url.replace(/\/+$/, "");
  const timeoutMs = mnemeCfg.requestTimeoutMs;
  // /memory/context 的 pins 条数上限（config.mneme.contextPinsLimit，默认 5）
  const pinsLimit = Number.isInteger(mnemeCfg.contextPinsLimit) && mnemeCfg.contextPinsLimit > 0
    ? mnemeCfg.contextPinsLimit
    : 5;

  /**
   * 上游调用统一入口。返回 { status, json }。
   * 网络层失败（连接拒绝/超时/DNS）抛 UpstreamError，由 router 统一翻译成
   * 502 { error: "mneme-unavailable" }（设计文档 §2）；
   * HTTP 4xx/5xx 不抛——那是「mneme 有意见」，状态码与 error 字段透传。
   */
  async function call(pathname, { method = "GET", body, query } = {}) {
    const url = buildUrl(base, pathname, query);
    const headers = { authorization: "Bearer " + mnemeCfg.token };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // AbortSignal.timeout：到点自动中止（Node >= 17.3）。上游是本机 DSH，
        // 10s 覆盖 mneme 向量检索的慢路径；超时同样走 UpstreamError → 502。
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // err.cause.code（ECONNREFUSED 等）优先露出，便于日志定位；否则退化为
      // TimeoutError 的 name（TimeoutError / AbortError）。
      const detail = err?.cause?.code ?? err?.name ?? String(err);
      log.warn("upstream-fetch-failed", { pathname, detail });
      throw new UpstreamError(`upstream fetch failed: ${detail}`);
    }
    // body 尽力解析：上游偶发空响应/非 JSON（如代理截断页）不应炸掉 bridge
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  // ---- 后端统一接口面（embedded.js 提供同款五方法，router 零特判）----------

  return {
    backend: "remote",

    /** 健康探测：mneme /health 免鉴权。网络失败按不可达处理，不抛。 */
    async health() {
      try {
        const r = await call("/health");
        return { ok: r.status === 200 && r.json?.ok === true, status: r.status, json: r.json };
      } catch {
        return { ok: false };
      }
    },

    /** 保存：POST /memories。上游 201=created / 200=merged / 4xx 带错误，透传。 */
    async save(memory) {
      return call("/memories", { method: "POST", body: memory });
    },

    /** 搜索：GET /search?q&mode&topK。 */
    async search(q, { mode = "auto", topK = 5 } = {}) {
      return call("/search", { query: { q, mode, topK } });
    },

    /** 最近列表：GET /memories?order=chrono&limit=N（chrono = updated_at DESC）。 */
    async recent(limit) {
      return call("/memories", { query: { order: "chrono", limit } });
    },

    /** v0.5（面板增强②）：按类型列出——remote 模式代理 mneme GET /memories?type=X。 */
    async listByType({ type = null, types = null, limit = 50, order = "chrono" } = {}) {
      const q = { order, limit };
      if (type) q.type = type;
      const r = await call("/memories", { query: q });
      return r;
    },

    /** 状态透传：GET /status（mneme 版本/统计/运行时长）。 */
    async status() {
      return call("/status");
    },

    /**
     * 组合上下文（v0.2 /memory/context）：remote 模式下代理组装 mneme 的四个
     * 上游端点（/profile、/rules、/memories?minImportance=5、/search），
     * 与 embedded 同口径返回 { profile, rules, pins, related }。
     * 任一子端点失败按空值降级（profile ""/rules []/pins []/related []）——
     * 聚合路由的子项失败不拖垮整体，语义对齐 embedded 的 try/catch 降级。
     */
    async context(q, topK) {
      // v0.6.1（上游 #363 安全建议）：sensitivity 标注条目默认不进注入出境（config.mneme.contextExcludeSensitive 可关）
      const exclSens = mnemeCfg.contextExcludeSensitive !== false;
      const slim = (items) => (Array.isArray(items) ? items : [])
        .filter((m) => !exclSens || m.sensitivity === undefined || m.sensitivity === null || m.sensitivity === "")
        .map((m) => ({
        title: m.title,
        content: m.content != null ? String(m.content).slice(0, 160) : "",
        importance: m.importance,
        type: m.type
      }));

      // 四路并发：独立端点无依赖，串行只会白加延迟
      const [profileRes, rulesRes, pinsRes, relatedRes] = await Promise.allSettled([
        call("/profile"),
        call("/rules"),
        call("/memories", { query: { minImportance: 5, limit: pinsLimit, order: "chrono" } }),
        // q 空串不打上游（embedded 同口径）；非空走 /search
        String(q ?? "").trim()
          ? call("/search", { query: { q: String(q).trim(), mode: "auto", topK } })
          : Promise.resolve({ status: 200, json: { items: [] } })
      ]);

      const pick = (settled, path) => {
        if (settled.status !== "fulfilled") {
          // 网络层失败（UpstreamError）要往上抛：整路由 502 的语义不能被子项吞掉
          if (settled.reason instanceof UpstreamError) throw settled.reason;
          log.warn("context-subcall-failed", { path });
          return null;
        }
        return settled.value;
      };
      const profileR = pick(profileRes, "/profile");
      const rulesR = pick(rulesRes, "/rules");
      const pinsR = pick(pinsRes, "/memories");
      const relatedR = pick(relatedRes, "/search");

      return {
        status: 200,
        json: {
          profile: typeof profileR?.json?.profile === "string" ? profileR.json.profile : "",
          rules: Array.isArray(rulesR?.json?.rules) ? rulesR.json.rules.filter((r) => typeof r === "string") : [],
          pins: slim(pinsR?.json?.items),
          related: slim(relatedR?.json?.items)
        }
      };
    },

    /** 进程收尾钩子（remote 无持久资源，空实现；接口对齐 embedded.close）。 */
    async close() {
      log.debug("remote-close", {});
    }
  };
}

/** 上游网络层失败专用错误：router 靠 instanceof 决定 502 还是透传。 */
export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamError";
  }
}