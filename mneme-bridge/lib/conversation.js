// lib/conversation.js —— 对话链路：合成 history 记忆 + bridge 侧 sha256 LRU 去重
// 设计文档 §2 POST /memory/conversation：
//   title = 「网页对话：」+ user 前 40 字；content = user/assistant 拼接；
//   tags=["web","edge"]；source="edge-extension"；
//   bridge 侧去重键 = sha256(user + "\n" + assistant)，LRU 500 条，
//   命中直接 200 { deduped: true }，不再打扰 mneme。
import { createHash } from "node:crypto";
import { loggerFor } from "./log.js";

const log = loggerFor("conversation");

/** 定长 LRU：Map 保插入序，命中后 delete+set 挪到队尾，超容删队首（最久未用）。 */
class LruSet {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  has(key) {
    if (!this.map.has(key)) return false;
    // 命中即刷新热度：挪队尾
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return true;
  }
  add(key) {
    if (this.map.has(key)) {
      // 已存在（并发窗口内的重复 add）：同样刷新热度
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      return;
    }
    this.map.set(key, null);
    if (this.map.size > this.capacity) {
      // Map 迭代序 = 插入序，第一个 key 就是 LRU 队首
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get size() {
    return this.map.size;
  }
}

/**
 * 创建对话处理器。
 * @param {{ capacity?: number }} opts
 * @param {(memory) => Promise<{status, json}>} saveFn 后端 save（remote/embedded 皆可）
 */
export function createConversationHandler(opts, saveFn) {
  const lru = new LruSet(opts?.capacity ?? 500);

  /**
   * 处理一次对话入库请求。返回 { status, json }，形状：
   *   去重命中  → 200 { deduped: true, hash }
   *   正常写入 → 透传后端（201 created / 200 merged + 记忆字段）
   *   参数非法  → 抛 McBadRequest（router 统一转 400）
   */
  return async function handleConversation(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      const err = new Error("invalid-body"); err.status = 400; throw err;
    }
    const user = typeof body.user === "string" ? body.user.trim() : "";
    const assistant = typeof body.assistant === "string" ? body.assistant.trim() : "";
    // 双侧都要求非空：只有 half 的对话（比如请求刚发出页面就崩）不该进记忆池
    if (!user || !assistant) {
      const err = new Error("user and assistant must be non-empty strings"); err.status = 400; throw err;
    }

    // ---- bridge 侧去重（第一道，先于 mneme 的 (type,title) 去重）------------
    // 为什么不直接靠 mneme 的去重：mneme 按 (type,title,scope) 匹配，而标题截断
    // 自 user 前 40 字——两条 user 前 40 字相同、后续不同的对话会被误合并；
    // sha256(全文) 精确覆盖「扩展重发同一条」的真实场景。
    const hash = createHash("sha256").update(user + "\n" + assistant).digest("hex");
    if (lru.has(hash)) {
      log.info("conversation-deduped", { hash: hash.slice(0, 12) });
      return { status: 200, json: { deduped: true, hash } };
    }

    // ---- 合成 history 记忆 -------------------------------------------------
    // occurred_at 显式给当前时刻：对话是「刚刚发生的事件」，不设的话 mneme 落
    // created_at，语义等价，但显式字段让 occurred_* 过滤器立即可用。
    const title = "网页对话:" + user.slice(0, 40);
    const content = "用户: " + user + "\n助手: " + assistant;
    const memory = {
      type: "history",
      title,
      content,
      tags: ["web", "edge", "pending-distill"], // v0.3：待蒸馏状态标签，蒸馏完成后由 pending.mark 追加 distilled
      source: "edge-extension",
      importance: 3,
      occurred_at: new Date().toISOString()
    };
    // 扩展侧可选带 url/sessionId：进 content 尾部做溯源线索（不占 schema 字段，
    // 也不参与去重键——同 URL 的两次不同对话必须都入库）。
    const provenance = [];
    if (typeof body.url === "string" && body.url.trim()) provenance.push("url: " + body.url.trim());
    if (typeof body.sessionId === "string" && body.sessionId.trim()) provenance.push("session: " + body.sessionId.trim());
    if (provenance.length) memory.content += "\n" + provenance.join("\n");

    const result = await saveFn(memory);
    // 只有真正落库成功才登记去重键：写入失败时下次重试应放行
    if (result.status === 201 || result.status === 200) {
      lru.add(hash);
      log.info("conversation-saved", { hash: hash.slice(0, 12), action: result.json?.action });
      return result;
    }
    // 上游 4xx/5xx：原样透传，不登记
    return result;
  };
}
