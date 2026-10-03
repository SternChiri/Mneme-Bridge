// lib/pending.js —— 待蒸馏对话的缓冲与标记（embedded 模式直查库）
// 状态机：扩展上报的对话 → memories 表（type=history, tags 含 pending-distill）→
// 蒸馏器读走 → 正式条目入库 → 原始行 tags 追加 distilled。
// 用 tags 做状态而非另建表：mneme 的 mirror/查询都以 memories 表为准，单表最少惊喜。
// v0.4（task-9）：①load 同时收实时（edge-extension）与导入（edge-import）两条
// 来源——importer 一直打 edge-import 标记但 v0.3 的 load 只查 edge-extension，
// 导入会话进不了蒸馏管线（现存断层，本版修复）；②会话键解析优先 tags 里的
// imp-sess: 标记（importer v0.4 写入），无标记回落 content 的 session:/url: 行；
// ③会话级断点续跑 API（isSessionDone/markSessionDone，蒸馏器调用）。
import { loggerFor } from "./log.js";

const log = loggerFor("pending");

/** 创建 pending 存取器。store = embedded backend 暴露的 createStore 返回值（含 db）。 */
export function createPendingStore(store) {
  // 两条来源一起收：实时对话与导入会话共用同一套蒸馏缓冲状态机
  // （tags LIKE 的 OR 条件走全表扫描，副本库/生产库都在万行级，可接受；
  //  不加索引的原因：mneme 的表结构归它自己管，bridge 不动 schema）。
  const LOAD_SQL =
    "SELECT id, title, content, tags, created_at FROM memories " +
    "WHERE type='history' AND tags NOT LIKE '%distilled%' " +
    "AND tags NOT LIKE '%pending-skip%' " +
    "AND (source='edge-extension' OR source='edge-import') " +
    "AND tags LIKE '%pending-distill%' " +
    "ORDER BY created_at ASC LIMIT ?";

  return {
    /**
     * 读待蒸馏（按时间升序）。
     * 返回条目附加 distill_kind（"summary-card" | "conversation"）与 session_id
     * ——蒸馏器按 session_id 分组跳过已完成会话，按 distill_kind 选提示词。
     */
    load(limit) {
      const rows = store.db.prepare(LOAD_SQL).all(limit);
      return rows.map((r) => {
        let tags = [];
        try { tags = JSON.parse(r.tags || "[]"); } catch (e) { /* 坏行当空 */ }
        const m = r.content.match(/^用户: ([\s\S]*?)\n助手: ([\s\S]*?)(?:\nurl: .*)?$/);
        // 会话键优先级：tags 的 imp-sess:（importer v0.4 显式写入，权威）>
        // content 的 session: 行（实时对话 provenance）> content 的 url 尾段 >
        // null（无标记，蒸馏器按条目独立处理）
        const tagSess = tags.find((t) => typeof t === "string" && t.startsWith("imp-sess:"));
        const sessionId = tagSess
          ? tagSess.slice("imp-sess:".length)
          : (r.content.match(/session: (\S+)/) || [])[1] ||
            (r.content.match(/url: \S*\/([^/\s]+)\/?$/) || [])[1] ||
            null;
        return {
          id: r.id,
          session_id: sessionId,
          url: (r.content.match(/url: (\S+)/) || [])[1] || null,
          user: m ? m[1].trim() : r.title.replace(/^网页对话:/, "").replace(/^旧会话:/, ""),
          assistant: m ? m[2].trim() : r.content,
          occurred_at: r.created_at,
          tags,
          // 摘要卡形态：importer 给 L2 产物打的标记；蒸馏器据此换提示词
          distill_kind: tags.includes("summary-card") ? "summary-card" : "conversation"
        };
      });
    },
    /** 蒸馏完成：原始行 tags JSON 数组安全追加 distilled。 */
    mark(ids) {
      const upd = store.db.prepare("UPDATE memories SET tags = ? WHERE id = ?");
      for (const id of ids) {
        const row = store.db.prepare("SELECT tags FROM memories WHERE id = ?").get(id);
        if (!row) continue;
        let tags = [];
        try { tags = JSON.parse(row.tags || "[]"); } catch (e) { /* noop */ }
        if (!tags.includes("distilled")) tags.push("distilled");
        upd.run(JSON.stringify(tags), id);
      }
      log.info("pending-marked", { count: ids.length });
    },
    /**
     * 会话级断点续跑（task-9 第 2 点）：该会话是否已有任一条目被蒸馏过。
     * 为什么查任一条目而非全部：导入按会话分批上报，同会话第二批到达时
     * 第一批已标 distilled——「任一完成」即视全会话完成，跳过可避免同会话
     * 重复蒸馏（重复的记忆条目要靠 mneme 去重兜底，不如源头不写）。
     * LIKE 通配转义：sid 来自扩展，%/_ 必须转义否则 'a%' 会误匹配。
     */
    isSessionDone(sid) {
      const safe = sid.replace(/[\\%_]/g, (ch) => "\\" + ch);
      const row = store.db.prepare(
        "SELECT id FROM memories WHERE tags LIKE ? ESCAPE '\\' LIMIT 1"
      ).get("%imp-sess:" + safe + "%distilled%");
      return Boolean(row);
    },
    /** 会话完成登记：把 imp-sess:<sid>distilled 追加进该会话所有原始行（幂等）。 */
    markSessionDone(sid) {
      const safe = sid.replace(/[\\%_]/g, (ch) => "\\" + ch);
      const rows = store.db.prepare(
        "SELECT id, tags FROM memories WHERE tags LIKE ? ESCAPE '\\' AND tags NOT LIKE '%distilled%'"
      ).all("%imp-sess:" + safe + "%");
      const upd = store.db.prepare("UPDATE memories SET tags = ? WHERE id = ?");
      for (const row of rows) {
        let tags = [];
        try { tags = JSON.parse(row.tags || "[]"); } catch (e) { /* noop */ }
        if (!tags.includes("distilled")) tags.push("distilled");
        upd.run(JSON.stringify(tags), row.id);
      }
      if (rows.length) log.info("session-marked", { sid: sid.slice(0, 12), rows: rows.length });
    }
  };
}
