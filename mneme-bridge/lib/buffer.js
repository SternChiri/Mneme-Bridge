// lib/buffer.js —— bridge 自有的待蒸馏缓冲
// 缓冲原料绝不进 mneme——mneme 只收「蒸馏完成的合格记忆」：
// 若把待蒸馏行写进 mneme memories 表（tags 做状态），mneme UI/检索/注入
// 都会被管线原料污染。本模块用**独立 SQLite**（buffer.db）承载：
//   扩展上报 → buffer.db（status=pending）→ distiller 按会话分组读走
//   → DSH headless 蒸馏 → 合格记忆经 backend.save 入 mneme → 原料标 done。
// 独立文件的好处：mneme 的 UI/搜索/注入/dream 整理彻底看不见原料；
// bridge 卸载时删掉 buffer.db 即彻底清理，无残留。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loggerFor } from "./log.js";

const log = loggerFor("buffer");

export function createBufferStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "buffer.db"));
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS buffer (
      id          TEXT PRIMARY KEY,
      session_id  TEXT,
      kind        TEXT NOT NULL DEFAULT 'conversation',
      user        TEXT NOT NULL,
      assistant   TEXT NOT NULL DEFAULT '',
      url         TEXT,
      occurred_at TEXT,
      dedup_key   TEXT UNIQUE,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_buffer_status ON buffer(status);
    CREATE INDEX IF NOT EXISTS idx_buffer_session ON buffer(session_id);
  `);
  // src 列区分来源（import=旧会话导入 / live=实时对话）——
  // 蒸馏器的"会话级跳过"只应作用于 import 行（迟到批次）；live 会话恢复聊天后新轮次要正常蒸。
  try { db.exec("ALTER TABLE buffer ADD COLUMN src TEXT"); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  try { db.exec("UPDATE buffer SET src='import' WHERE src IS NULL AND id LIKE 'mig-%'"); } catch (e) { /* 幂等 */ }

  const SHA_RE = /^[a-f0-9]{64}$/;

  /** 行后处理——合成 tags（imp-sess:<sid> / summary-card / import / edge），
   *  对齐 pendingStore 的行形状（distiller 的 sessTags 提取依赖 e.tags）。 */
  const withTags = (rows) => rows.map((r) => ({
    ...r,
    // distiller 用 e.distill_kind 判摘要卡（不是看 tags）——这里补齐字段
    ...(r.kind === "summary-card" ? { distill_kind: "summary-card" } : {}),
    tags: [
      "web", "edge",
      ...(r.kind === "summary-card" ? ["summary-card"] : []),
      ...(r.session_id ? ["imp-sess:" + r.session_id] : []),
    ],
  }));

  return {
    /** 入队（importer/conversation 调用）。dedupKey 冲突返回 false。 */
    add({ sessionId = null, kind = "conversation", src = null, user, assistant = "", url = null, occurredAt = null, dedupKey = null }) {
      if (dedupKey && SHA_RE.test(dedupKey)) {
        try {
          db.prepare("INSERT INTO buffer (id, session_id, kind, src, user, assistant, url, occurred_at, dedup_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
            .run(randomUUID(), sessionId, kind, src, user, assistant, url, occurredAt, dedupKey, new Date().toISOString());
          return true;
        } catch (e) {
          if (/UNIQUE/.test(String(e))) return false;   // 去重命中
          throw e;
        }
      }
      db.prepare("INSERT INTO buffer (id, session_id, kind, src, user, assistant, url, occurred_at, dedup_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)")
        .run(randomUUID(), sessionId, kind, src, user, assistant, url, occurredAt, new Date().toISOString());
      return true;
    },

    /** 蒸馏器取料：status=pending 的条目（按会话分组由 distiller 完成）。 */
    loadPending(limit = 60) {
      return withTags(db.prepare(
        "SELECT id, session_id, kind, user, assistant, url, occurred_at, created_at FROM buffer WHERE status = 'pending' ORDER BY created_at LIMIT ?"
      ).all(limit));
    },

    /** 蒸馏完成：条目标 done。 */
    markDone(ids) {
      const stmt = db.prepare("UPDATE buffer SET status = 'done' WHERE id = ?");
      for (const id of ids) { try { stmt.run(id); } catch (e) { /* 单条失败下轮重试 */ } }
    },

    /** 会话级断点续跑：该会话是否有任一条目已 done。 */
    isSessionDone(sessionId) {
      if (!sessionId) return false;
      // 「有 done 行」不等于会话蒸完（批量上限截断时会误判，未蒸馏的剩余
      // 条目会被永久跳过）：要求有 done 行且没有任何 pending 行。
      const pend = db.prepare("SELECT 1 FROM buffer WHERE session_id = ? AND status = 'pending' LIMIT 1").get(sessionId);
      if (pend) return false;
      const r = db.prepare("SELECT 1 FROM buffer WHERE session_id = ? AND status = 'done' LIMIT 1").get(sessionId);
      return !!r;
    },

    /** 会话级排空：同会话迟到条目一并标 done（状态机排空，不留永久 pending）。 */
    markSessionDone(sessionId) {
      db.prepare("UPDATE buffer SET status = 'done' WHERE session_id = ? AND status = 'pending'").run(sessionId);
    },

    /** 静默会话的 pending 条目——活跃会话整组排除（避免逐轮蒸馏碎片化+烧 token）。 */
    listIdlePending(idleMs, limit = 60) {
      const cutoff = new Date(Date.now() - (Number(idleMs) > 0 ? idleMs : 600000)).toISOString();
      return withTags(db.prepare(
        `SELECT * FROM buffer WHERE status='pending'
         AND (session_id IS NULL AND created_at <= ?1
              OR session_id IS NOT NULL AND session_id NOT IN (
                SELECT DISTINCT session_id FROM buffer
                WHERE status='pending' AND session_id IS NOT NULL AND created_at > ?1))
         ORDER BY created_at LIMIT ?2`
      ).all(cutoff, limit));
    },

    /** 队列查看（面板缓冲队列弹层）。 */
    listPending(limit = 200) {
      return withTags(db.prepare(
        "SELECT id, session_id, kind, user, assistant, url, occurred_at, created_at FROM buffer WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?"
      ).all(limit));
    },

    /** 删除待蒸馏条目（面板队列里的人工把关）。 */
    remove(id) {
      const r = db.prepare("DELETE FROM buffer WHERE id = ? AND status = 'pending'").run(id);
      return r.changes > 0;
    },

    /** 已入库会话 id 集——该会话存在 done 行且无 pending 行（全蒸完）。
     *  返回 Set；面板导入列表用它隐藏已入库会话。 */
    importedSessionIds() {
      const rows = db.prepare(
        `SELECT session_id,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pend,
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS dn
         FROM buffer WHERE session_id IS NOT NULL GROUP BY session_id`
      ).all();
      return new Set(rows.filter(r => r.pend === 0 && r.dn > 0).map(r => r.session_id));
    },

    /** 队列统计。 */
    stats() {
      const r = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM buffer WHERE status = 'pending'").get();
      return { total: r.n, sessions: r.s };
    },

    close() { db.close(); }
  };
}
