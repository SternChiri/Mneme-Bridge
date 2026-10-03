// lib/importer.js —— 旧会话批量导入（v0.4，改进 3 的 bridge 侧 + task-9 字符闸）
// 数据流：扩展借页面 cookie 拉历史 → POST /memory/import（批量对话）→
// 走与实时对话同一套缓冲（pending-distill 状态）→ DSH 启动时自动蒸馏入库。
// 与实时链路的唯一区别：批量、带导入标记、去重键独立（防导入与实时重复）。
// v0.4（task-9）：①maxImportChars 闸（超限 400 too-large，预估确认的第二道锁）；
// ②sessionId 进 tags（imp-sess:<sid>）——断点续跑按会话跳过的依据；
// ③kind:"summary-card" 进 tags——蒸馏器识别摘要卡形态换提示词；④content 合成
// 改用 estimate.importContentOf（与 /memory/import/estimate 口径字节一致）。
import { createHash } from "node:crypto";
import { loggerFor } from "./log.js";
import { importContentOf, sessionKeyOf } from "./estimate.js";

const log = loggerFor("importer");

/** 定长 LRU（与 conversation.js 同构，独立实例——导入域去重互不影响实时域）。 */
class LruSet {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  has(key) {
    if (!this.map.has(key)) return false;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return true;
  }
  add(key) {
    if (this.map.has(key)) {
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      return;
    }
    this.map.set(key, null);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * 创建导入处理器。
 * saveFn 与 conversation 共用 backend.save；
 * seen 由调用方提供（复用去重 LRU）；
 * maxImportChars 来自 config.import.maxImportChars（默认 50000，任务硬性值）。
 */
export function createImportHandler(opts, saveFn) {
  const lru = opts.lru || new LruSet(opts.lruCapacity || 1000);
  const MAX_BATCH = (opts.maxBatch) || 200; // 单次导入上限（防误传全库打爆缓冲）
  const maxChars = Number.isInteger(opts.maxImportChars) && opts.maxImportChars > 0
    ? opts.maxImportChars
    : 50000;

  return async function handleImport(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      const err = new Error("invalid-body"); err.status = 400; throw err;
    }
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) { const err = new Error("items array required"); err.status = 400; throw err; }
    if (items.length > MAX_BATCH) {
      const err = new Error("batch too large: " + items.length + " > " + MAX_BATCH); err.status = 400; throw err;
    }

    // ---- maxImportChars 闸（先于任何写入）------------------------------------
    // 与 estimate 同口径（importContentOf）：估算字符量落库前最后确认一次。
    // 为什么闸而不静默截断：预算是用户在 L3 点过确认的，超限意味着用户看到的
    // 数字与实际不符——宁可让用户回 L1 减勾选，不能偷偷花他的 API 余额。
    const totalChars = items.reduce((acc, it) => acc + importContentOf(it).length, 0);
    if (totalChars > maxChars) {
      log.warn("import-too-large", { chars: totalChars, max: maxChars, items: items.length });
      return {
        status: 400,
        json: { error: "too-large", estimateChars: totalChars, maxImportChars: maxChars }
      };
    }

    let accepted = 0, deduped = 0, rejected = 0;
    for (const it of items) {
      const user = typeof it.user === "string" ? it.user.trim() : "";
      const assistant = typeof it.assistant === "string" ? it.assistant.trim() : "";
      // v0.5.22：摘要卡（kind=summary-card）正文全在 user 里、assistant 恒空——
      // 此前与全文同样要求 assistant 非空，导致卡模式导入的所有条目被静默拒收。
      const isCardItem = it.kind === "summary-card";
      if (!user || (!assistant && !isCardItem)) { rejected++; continue; }
      // 导入去重键：sha256(user+assistant) 前缀加导入域，与实时对话互不干扰
      const hash = "imp-" + createHash("sha256").update(user + "\n" + assistant).digest("hex");
      if (lru && lru.has(hash)) { deduped++; continue; }
      // v0.3.38：occurred_at 归一——ISO 串直传；数字（秒/毫秒）转 ISO（对齐 mneme normalizeOccurredAt 语义）
      const occurred = (() => {
        const v = it.occurred_at;
        if (typeof v === "string" && v.trim()) {
          const d = new Date(v.trim());
          return isNaN(d.getTime()) ? null : d.toISOString();
        }
        if (typeof v === "number" && isFinite(v) && v > 0) {
          const ms = v >= 1e12 ? v : v > 1e9 ? v * 1000 : 0;
          return ms ? new Date(ms).toISOString() : null;
        }
        return null;
      })();
      // v0.4 断点续跑：会话标记进 tags（蒸馏器按它跳过已蒸馏会话）；扩展没带
      // sessionId 时从 url 指纹推导，都取不到就 null（无标记 = 每条独立会话，
      // 蒸馏器退回条目级处理，行为与 v0.3 一致）。
      const sid = sessionKeyOf(it);
      // 摘要卡形态（task-9 第 4 点）：L2 产物带 kind 标记，蒸馏器据此换提示词
      const isCard = it.kind === "summary-card";
      const title = "旧会话:" + user.slice(0, 40);
      const content = importContentOf(it);
      const memory = {
        type: "history",
        title,
        content,
        // import 标记区分来源；pending-distill 进缓冲状态机；imp-sess 是断点
        // 续跑的会话粒度键（蒸馏器读 pending 时解析，markSessionDone 回写）
        tags: ["web", "edge", "import", "pending-distill",
          ...(isCard ? ["summary-card"] : []),
          ...(sid ? ["imp-sess:" + sid] : [])],
        source: "edge-import",
        importance: 3,
        occurred_at: occurred || new Date().toISOString()
      };
      const r = await saveFn(memory);
      if (r.status === 201 || r.status === 200) {
        accepted++;
        if (lru) lru.add(hash);
      } else rejected++;
    }
    log.info("import-batch", { total: items.length, accepted, deduped, rejected, chars: totalChars });
    return { status: 200, json: { accepted, deduped, rejected, note: "buffered for distillation" } };
  };
}
