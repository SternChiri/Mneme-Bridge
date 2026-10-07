// lib/router.js —— 路由与中间件：鉴权 → CORS/预检 → 分发 → 错误归一
// 职责边界：router 只管 HTTP 形状（状态码/头部/错误翻译），业务语义全在
// backend（remote/embedded）与 conversation 处理器里。
import {
  sendJson, sendNoContent, isAuthorized, readJsonBody, intParam
} from "./http-util.js";
import { UpstreamError } from "./remote.js";
import { McBadRequest } from "./embedded.js";
import { loggerFor } from "./log.js";

const log = loggerFor("router");

/**
 * 创建请求处理器。
 * @param {object} opts
 * @param {string}   opts.bridgeToken   bridge 鉴权 token
 * @param {object}   opts.backend       remote/embedded 后端（六方法接口面，含 context）
 * @param {Function} opts.conversation  对话入库处理器
 * @param {() => number} opts.startedAt 进程启动时刻（Date.now()）
 * @param {{pinsLimit: number, relatedTopK: number}} [opts.contextCfg]
 *                                      /memory/context 的默认条数（config.mneme）
 */
export function createRequestHandler({ bridgeToken, backend, conversation, bufferStore, startedAt, contextCfg, distiller, importer, estimator, sessionCleaner }) {
  const ctxPinsDefault = Number.isInteger(contextCfg?.pinsLimit) && contextCfg.pinsLimit > 0 ? contextCfg.pinsLimit : 5;
  const ctxTopKDefault = Number.isInteger(contextCfg?.relatedTopK) && contextCfg.relatedTopK > 0 ? contextCfg.relatedTopK : 6;

  return function handle(req, res) {
    // URL 解析放最前：后面所有分支都要用 pathname 与查询参数。
    // try/catch 包住：畸形请求行（非 ASCII 路径等）抛 URIError 时按 400 拒绝。
    let url;
    try {
      url = new URL(req.url, "http://bridge.local");
    } catch {
      sendJson(res, 400, { error: "invalid-url" });
      return;
    }
    const pathname = url.pathname;

    // ---- CORS 预检：任何路径的 OPTIONS 都 204 + 放行头（设计文档 §2）--------
    // 预检不带自定义头是浏览器行为，不能要求它带 Authorization——「有 token
    // 兜底」指的是真正的业务请求，预检本身无敏感操作，简化放行。
    if (req.method === "OPTIONS") {
      sendNoContent(res);
      return;
    }

    // ---- 鉴权：除 GET /health 外全部要求 Bearer bridgeToken ----------------
    if (!(req.method === "GET" && pathname === "/health")) {
      if (!isAuthorized(req, bridgeToken)) {
        // 401 不区分「没带」与「带错」：不给人脸识别式的探测提示
        log.warn("unauthorized", { path: pathname, method: req.method });
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // ---- 分发 --------------------------------------------------------------
    dispatch(req, res, url, pathname).catch((err) => {
      // 分发链最外层兜底：任何漏网异常都不得挂死连接
      log.error("dispatch-crash", { path: pathname, msg: String(err?.stack ?? err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  };

  /** 实际分发（async：body 读取与后端调用都是异步）。 */
  async function dispatch(req, res, url, pathname) {

    // ---- GET /health：免鉴权连通性探测 ------------------------------------
    if (req.method === "GET" && pathname === "/health") {
      // backend.health() 网络失败时返回 {ok:false} 而不抛（remote 实现里已吞），
      // 所以这里永远 200——bridge 进程活着就该应答，mneme 不可达是 status 的事。
      const h = await backend.health();
      sendJson(res, 200, {
        ok: true,
        backend: backend.backend,
        uptimeMs: Date.now() - startedAt,
        mneme: backend.backend === "remote"
          ? { url: h.ok ? "reachable" : "unreachable" }
          : { dataDir: backend.dataDir }
      });
      return;
    }

    // ---- POST /memory/save ------------------------------------------------
    if (req.method === "POST" && pathname === "/memory/save") {
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return; // 读体失败已应答
      try {
        const r = await backend.save(body);
        // 上游 4xx/5xx 透传状态码与 error 字段（设计文档 §2）
        if (r.status >= 400) {
          sendJson(res, r.status, r.json ?? { error: "upstream-rejected" });
          return;
        }
        sendJson(res, r.status, r.json);
      } catch (err) {
        // embedded.save 的参数级错误（type 白名单/必填缺失）→ 400
        if (err?.name === "McBadRequest") {
          sendJson(res, 400, { error: err.message });
          return;
        }
        // 上游网络层失败（ECONNREFUSED/超时）→ 502，与 search/recent 同口径
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- POST /memory/search ----------------------------------------------
    if (req.method === "POST" && pathname === "/memory/search") {
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return;
      const q = typeof body?.q === "string" ? body.q : "";
      if (!q.trim()) {
        sendJson(res, 400, { error: "q is required" });
        return;
      }
      const mode = typeof body?.mode === "string" && body.mode ? body.mode : "auto";
      const topK = Number.isInteger(body?.topK) && body.topK > 0 && body.topK <= 50 ? body.topK : 5;
      // scope 可选透传——字符串一维即生效，全缺 = 不解析
      //（与上游 /search 的 agent_scope/workspace_scope 语义一致，fail-closed 由 lib 处理）
      const agentScope = typeof body?.agentScope === "string" && body.agentScope ? body.agentScope : undefined;
      const workspaceScope = typeof body?.workspaceScope === "string" && body.workspaceScope ? body.workspaceScope : undefined;
      try {
        const r = await backend.search(q, { mode, topK, agentScope, workspaceScope });
        sendJson(res, r.status, r.json);
      } catch (err) {
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- GET /memory/recent ------------------------------------------------
    if (req.method === "GET" && pathname === "/memory/recent") {
      const limit = intParam(url, "limit", 10, { min: 1, max: 100 });
      try {
        const r = await backend.recent(limit);
        sendJson(res, r.status, r.json);
      } catch (err) {
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- GET /memory/list（按类型/分组列出记忆）-----------
    if (req.method === "GET" && pathname === "/memory/list") {
      const limit = intParam(url, "limit", 50, { min: 1, max: 200 });
      const type = url.searchParams.get("type") || null;
      const types = url.searchParams.get("types") || null;
      const order = url.searchParams.get("order") || "chrono";
      try {
        const r = typeof backend.listByType === "function"
          ? await backend.listByType({ type, types, limit, order })
          : await backend.recent(limit);
        sendJson(res, r.status, r.json);
      } catch (err) {
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- GET /memory/pending（缓冲队列查看——待蒸馏条目，面板「记忆维护」用）
    if (req.method === "GET" && pathname === "/memory/pending") {
      if (!bufferStore) { sendJson(res, 200, { items: [], total: 0 }); return; }
      const limit = intParam(url, "limit", 100, { min: 1, max: 500 });
      try {
        const items = bufferStore.listPending(limit);
        sendJson(res, 200, {
          items: items.map((it) => ({
            id: it.id,
            session_id: it.session_id,
            user: it.user,
            assistant: it.assistant,
            occurred_at: it.occurred_at,
            distill_kind: it.distill_kind || null
          })),
          total: items.length
        });
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
      return;
    }

    // ---- DELETE /memory/pending?id=（面板队列条目删除——蒸馏前人工把关）
    if (req.method === "DELETE" && pathname === "/memory/pending") {
      const id = url.searchParams.get("id") || "";
      if (!bufferStore || !id) { sendJson(res, 400, { error: "id required" }); return; }
      const ok = bufferStore.remove(id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not-found" });
      return;
    }

    // ---- GET /memory/imported-ids（已入库会话集合——导入列表隐藏已入库会话）
    if (req.method === "GET" && pathname === "/memory/imported-ids") {
      if (!bufferStore) { sendJson(res, 200, { ids: [] }); return; }
      const ids = [...bufferStore.importedSessionIds()];
      sendJson(res, 200, { ids });
      return;
    }

    // ---- POST /memory/conversation ----------------------------------------
    if (req.method === "POST" && pathname === "/memory/conversation") {
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return;
      try {
        const r = await conversation(body);
        sendJson(res, r.status, r.json);
      } catch (err) {
        // conversation 处理器用 err.status 表达 4xx（参数非法）
        if (err?.status === 400) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        // embedded.save 的参数级错误也归一为 400（McBadRequest 语义）
        if (err?.name === "McBadRequest") {
          sendJson(res, 400, { error: err.message });
          return;
        }
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- GET /memory/status -------------------------------------------------
    if (req.method === "GET" && pathname === "/memory/status") {
      try {
        const r = await backend.status();
        // mneme 版本/统计之上盖一层 backend 标记（设计文档 §1 的硬要求）
        sendJson(res, r.status, { ...r.json, backend: backend.backend });
      } catch (err) {
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- GET /memory/context（组合路由）--------------------------------
    if (req.method === "GET" && pathname === "/memory/context") {
      // q 可空：空 = 只要 profile+rules+pins（首开页面场景），related 给 []
      const q = url.searchParams.get("q") ?? "";
      // topK：显式传参 > config.mneme.contextRelatedTopK > 6
      const topK = intParam(url, "topK", ctxTopKDefault, { min: 1, max: 50 });
      try {
        const r = await backend.context(q, topK);
        // 透传数据源标记（via: "endpoint" | "heuristic"），便于调试与 smoke 断言
        sendJson(res, r.status, r.via !== undefined ? { ...r.json, via: r.via } : r.json);
      } catch (err) {
        // context 的子项失败在 backend 内部已降级；这里只剩网络层失败 → 502
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- POST /memory/distill：手动触发一轮蒸馏（面板「立即蒸馏」）----
    if (req.method === "POST" && pathname === "/memory/distill") {
      if (!distiller) {
        // remote 模式下蒸馏器不可用（8790 无按 tags 查询能力）
        sendJson(res, 503, { error: "distiller-unavailable", hint: "distill requires embedded mode" });
        return;
      }
      // 异步执行不占连接：蒸馏可能耗时数分钟（headless LLM），立即 202 回执
      void distiller.runIfPending(true).then((result) => {   // 手动触发=强制全量（含活跃会话）
        log.info("distill-manual-done", { saved: result.saved ?? 0, skipped: result.skipped ?? "" });
      }).catch((err) => {
        log.warn("distill-manual-fail", { msg: String(err?.message ?? err).slice(0, 200) });
      });
      sendJson(res, 202, { ok: true, hint: "distillation started; poll /memory/status or bridge logs" });
      return;
    }

    // ---- POST /memory/import：旧会话批量导入----
    if (req.method === "POST" && pathname === "/memory/import") {
      if (!importer) {
        sendJson(res, 503, { error: "importer-unavailable" });
        return;
      }
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return;
      try {
        const r = await importer(body);
        sendJson(res, r.status, r.json);
      } catch (err) {
        if (err?.status === 400) { sendJson(res, 400, { error: err.message }); return; }
        if (handleUpstream(err, res)) return;
        throw err;
      }
      return;
    }

    // ---- POST /memory/import/estimate：导入预估器（纯计算不落库）----
    if (req.method === "POST" && pathname === "/memory/import/estimate") {
      if (!estimator) {
        // 恒在（server.js 无条件创建）；防御式 503 保持与其他可选路由同款形状
        sendJson(res, 503, { error: "estimator-unavailable" });
        return;
      }
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return;
      try {
        // 纯计算：永远 200（超限 wouldExceed:true），UI 据此渲染「预计消耗」
        const r = await estimator(body);
        sendJson(res, r.status, r.json);
      } catch (err) {
        if (err?.status === 400) { sendJson(res, 400, { error: err.message }); return; }
        throw err;
      }
      return;
    }

    // ---- POST /maintenance/purge-headless-sessions--------
    // 列出/清除 DSH 里本桥接器 headless 蒸馏留下的单轮残留会话。
    // body: {dryRun?:boolean}；dryRun=true 只列不删（dryRun 列表带目录路径）。
    // 鉴权同全局：Bearer bridgeToken。清理器内部四重闸（cwd 精确匹配 + 目录名/头帧
    // id 一致 + 排除 subagent/fork/preset + 单 zstd 日志形态），绝不碰用户真实会话。
    if (req.method === "POST" && pathname === "/maintenance/purge-headless-sessions") {
      if (!sessionCleaner) {
        sendJson(res, 503, { error: "session-cleaner-unavailable" });
        return;
      }
      const body = await readBodyGuarded(req, res);
      if (body === undefined) return;
      const dryRun = body?.dryRun === true;
      try {
        const r = await sessionCleaner.purge({ dryRun });
        sendJson(res, 200, {
          ok: true,
          dryRun,
          purged: r.purged,
          failed: r.failed,
          dryRunCount: r.skippedDryRun,
          list: r.list
        });
      } catch (err) {
        // fail-safe：清理器自身不抛；这里兜一层防御（绝不拖垮 bridge）
        log.warn("purge-endpoint-fail", { msg: String((err && err.message) || err).slice(0, 200) });
        sendJson(res, 500, { error: "purge-failed" });
      }
      return;
    }

    // ---- 兜底 ---------------------------------------------------------------
    sendJson(res, 404, { error: "not-found" });
  }

  /**
   * 上游网络层异常归一：UpstreamError → 502 { error:"mneme-unavailable" }。
   * 返回 true 表示已应答，调用方直接 return。
   */
  function handleUpstream(err, res) {
    if (!(err instanceof UpstreamError)) return false;
    log.warn("mneme-unavailable", { msg: err.message });
    sendJson(res, 502, { error: "mneme-unavailable" });
    return true;
  }

  /** 读 body：客户端断连/超限/坏 JSON 都在这里应答完，返回 undefined 让调用方收手。 */
  async function readBodyGuarded(req, res) {
    try {
      return await readJsonBody(req);
    } catch (err) {
      const code = err?.code ?? "";
      if (code === "PAYLOAD_TOO_LARGE") sendJson(res, 413, { error: "payload-too-large" });
      else if (code === "INVALID_JSON") sendJson(res, 400, { error: "invalid-json" });
      else {
        // 客户端中途断连（ECONNRESET）：连接已死，只 log 不硬写
        log.warn("body-read-failed", { msg: String(err) });
        try { res.destroy(); } catch { /* 已死连接 */ }
      }
      return undefined;
    }
  }
}

// McBadRequest 在 conversation 链路抛出时（embedded.save 内部），同样归一为 400：
// 这里 import 仅为 instanceof 判断可用性（dispatch 顶部 catch 之外，conversation
// 的 err.status 路径已覆盖；留着 import 是为了让类型关系显式化）。
void McBadRequest;