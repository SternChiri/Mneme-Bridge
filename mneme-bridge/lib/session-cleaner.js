// lib/session-cleaner.js —— DSH headless 蒸馏会话清理器
// 解决的问题：runHeadless() 每次调 dsh --profile headless 蒸馏，DSH 都会把这次
// 单轮任务落成一个持久会话（头帧 cwd = bridge 根目录），在 DSH 工作区列表积成
// 几百个「未分组」残留。
//
// 依据 DSH 源码核对（0.2.0-rc.2）：
//   ① dsh 启动器（@deepseek-ai/dsh lib/bin.js）自有旗标只有 --profile/--patch/
//      --dump-config，无任何会话管理命令；
//   ② headless runner（@deepseek-ai/dsh-headless lib/index.js）Config 仅
//      task/sessionId/json 三项——没有「不保留会话」参数，且每次 run 都
//      sessions.flush() 落盘后才退出（残留的根因）；
//   ③ GUI 之外无会话删除 API；workspace 归档（GUI 内）只是隐藏且不删数据；
//   ④ 会话存储 = $DSH_HOME/sessions/<cwd slug 目录>/session-<uuid>/
//      session.vN.jsonl.zstd，首帧 JSON 头含 id/cwd/createdAt/parentSession/
//      agentPreset；sqlite 搜索索引与 projection cache 都是从该目录派生的
//      投影（dsh-session-query-sqlite._reconcile 对账：日志文件消失 → 索引行
//      自行删除；projection cache 读时校验丢弃）——文件系统才是事实源，
//      移除会话目录后 DSH 侧自收敛，无需（也不应）手改 DSH 的索引。
//
// 因此桥接器侧的清理 = 精确识别「本项目蒸馏产生的会话」后移除其目录。
// 识别硬闸（四重，全部命中才算候选，任何一闸不过即跳过——绝不误删）：
//   A. 头帧 cwd 与 bridge 根目录精确相等（分隔符/大小写归一后比较）
//   B. 目录名 === 头帧 id，且 id 形如 session-<uuid>（形状不符的目录不动）
//   C. 头帧无 parentSession / origin / agentPreset（subagent/fork/带预设的
//      会话绝不碰——它们可能属于正在运行的 agent）
//   D. 目录内容只有一个 session.vN.jsonl.zstd 文件（蒸馏会话的标准形态）
// 运行期保险：候选目录 mtime 距今不足 minAgeMs 的跳过（防并发蒸馏进行中）。
// fail-safe：任何一步失败只 log 跳过，绝不向上抛——清理永远不阻塞蒸馏主流程。
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { loggerFor } from "./log.js";

const log = loggerFor("session-cleaner");

/** bridge 根目录（lib/ 的上一级；本模块被服务端引用时即部署根）。 */
const SELF_BRIDGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Windows 路径比较用归一：反斜杠统一 + 小写。 */
function normPath(p) {
  return String(p || "").replace(/[\\/]+/g, "/").toLowerCase();
}

/** 解析 DSH home：DSH_HOME 环境变量优先（与 dsh-home-paths 同语义），否则 ~/.dsh。 */
export function resolveDshHome(override) {
  if (typeof override === "string" && override.trim()) return override.trim();
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return join(homedir(), ".dsh");
}

/**
 * 读一个会话日志的首帧头（zstd 首帧解压 → 首行 JSON）。
 * Node 的 zstdDecompressSync 在多帧输入上只解首帧（实测 0.2.0-rc.2 日志皆此形态），
 * 正好只拿 header。任何失败返回 null（该目录跳过，不猜测）。
 */
async function readSessionHeader(logPath) {
  try {
    const buf = await readFile(logPath);
    const text = zstdDecompressSync(buf).toString("utf8");
    const firstLine = text.split("\n", 1)[0];
    const j = JSON.parse(firstLine);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * 会话日志文件名（v3/v4 目录结构自适配；其余格式 = 非蒸馏会话形态，跳过）。
 * 接受两种形态：单文件（v3 或 v4），或恰好 {v3, v4} 成对（DSH 迁移过格式的
 * 会话两种都留）。带任何其它文件的目录一律不算蒸馏会话。
 */
function logFileName(files) {
  const isLog = (n) => /^session\.v[34]\.jsonl\.zstd$/.test(n);
  if (files.length === 1) return isLog(files[0]) ? files[0] : null;
  if (files.length === 2 && files.every(isLog) && files[0] !== files[1]) return files.find((n) => n.endsWith("v4.jsonl.zstd")) || files[0];
  return null;
}

/** UUID 形状检查（session-<8-4-4-4-12>）。 */
const UUID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 扫描并列出全部候选（通过 A-D 四闸的会话目录）。
 * opts: {dshHome?, bridgeRoot?, minAgeMs?}
 * 返回 [{dir, logFile, id, cwd, createdAt, sizeBytes, mtimeMs}]（已过时间闸）。
 */
export async function listDistillSessions(opts = {}) {
  const dshHome = resolveDshHome(opts.dshHome);
  const bridgeRoot = normPath(opts.bridgeRoot || SELF_BRIDGE_ROOT);
  const minAgeMs = Number.isFinite(opts.minAgeMs) ? Math.max(0, opts.minAgeMs) : 5000;
  const sessionsRoot = join(dshHome, "sessions");
  let workspaces;
  try {
    workspaces = (await readdir(sessionsRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch (err) {
    log.warn("scan-fail", { root: sessionsRoot, msg: String(err?.message ?? err).slice(0, 160) });
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const ws of workspaces) {
    let dirs;
    try {
      dirs = (await readdir(join(sessionsRoot, ws.name), { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch { continue; }
    for (const d of dirs) {
      const dir = join(sessionsRoot, ws.name, d.name);
      try {
        // 闸 B（前半）：目录名必须是 session-<uuid> 形状（裸 uuid/杂名目录直接排除）
        if (!UUID_RE.test(d.name)) continue;
        const files = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
        // 闸 D：目录内容只有一个 session.vN.jsonl.zstd
        const logFile = logFileName(files);
        if (!logFile) continue;
        const header = await readSessionHeader(join(dir, logFile));
        if (!header) continue;
        // 闸 B（后半）：头帧 id 与目录名一致
        if (header.id !== d.name) continue;
        // 闸 C：subagent/fork/带预设会话绝不碰
        if (header.parentSession !== undefined || header.origin !== undefined || header.agentPreset !== undefined) continue;
        if (header.delegationDepth !== undefined && header.delegationDepth !== 0) continue;
        // 闸 A：头帧 cwd 精确等于 bridge 根（归一比较；这是「本项目蒸馏产生」的定义）
        if (normPath(header.cwd) !== bridgeRoot) continue;
        const st = await stat(join(dir, logFile));
        // 运行期保险：太新的不动（可能正被某次蒸馏写入）
        if (now - st.mtimeMs < minAgeMs) continue;
        out.push({
          dir,
          logFile,
          id: header.id,
          cwd: header.cwd,
          createdAt: header.createdAt ?? null,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs
        });
      } catch (err) {
        // 单目录失败只影响该目录：log 后继续扫其余
        log.warn("scan-entry-fail", { dir: d.name.slice(0, 40), msg: String(err?.message ?? err).slice(0, 120) });
      }
    }
  }
  return out;
}

/**
 * 清理全部候选。opts: {dshHome?, bridgeRoot?, minAgeMs?, dryRun?}
 * 返回 {purged, failed, skippedDryRun, list}。
 * 每个目录独立 try/catch：单个失败不拖累其余，也绝不向上抛（调用方零负担）。
 */
export async function purgeDistillSessions(opts = {}) {
  const dryRun = opts.dryRun === true;
  const candidates = await listDistillSessions(opts);
  if (!candidates.length) return { purged: 0, failed: 0, skippedDryRun: 0, list: [] };
  if (dryRun) return { purged: 0, failed: 0, skippedDryRun: candidates.length, list: candidates };
  let purged = 0;
  let failed = 0;
  const removed = [];
  for (const c of candidates) {
    try {
      await rm(c.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      purged++;
      removed.push(c.id);
    } catch (err) {
      failed++;
      log.warn("purge-entry-fail", { id: c.id.slice(0, 24), msg: String(err?.message ?? err).slice(0, 160) });
    }
  }
  log.info("purge-done", { purged, failed, total: candidates.length });
  // list 只回未被移除的（失败项），便于调用方审计残留
  return { purged, failed, skippedDryRun: 0, list: candidates.filter((c) => !removed.includes(c.id)).map((c) => ({ id: c.id, dir: c.dir })) };
}

/** 创建绑定配置的清理器（server.js 用；log 打点带配置上下文）。 */
export function createSessionCleaner(opts = {}) {
  const cfg = opts.sessionCleanup || {};
  const dshHome = resolveDshHome(cfg.dshHome);
  const minAgeMs = Number.isFinite(cfg.minAgeMs) ? cfg.minAgeMs : 5000;
  return {
    /** 面板/蒸馏器共用的清理入口。dryRun 只列不删。 */
    async purge({ dryRun = false } = {}) {
      return purgeDistillSessions({ dshHome, bridgeRoot: SELF_BRIDGE_ROOT, minAgeMs, dryRun });
    },
    async list() {
      return listDistillSessions({ dshHome, bridgeRoot: SELF_BRIDGE_ROOT, minAgeMs: 0 });
    }
  };
}
