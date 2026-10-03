// lib/log.js —— 单行 JSON 日志：stdout + logs/bridge.log（轮转 5MB × 3）
// 设计文档 §5。轮转判据是「即将写入前的文件大小」，超过 maxBytes 就整体平移。
import { appendFileSync, renameSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// BRIDGE_ROOT 来自 config.js：日志目录锚定在 mneme-bridge/ 下（与进程 CWD 无关）
import { BRIDGE_ROOT } from "./config.js";

// MNEME_BRIDGE_LOG_DIR 可重定向日志目录（测试/多实例隔离用）
const LOG_DIR = process.env.MNEME_BRIDGE_LOG_DIR
  ? process.env.MNEME_BRIDGE_LOG_DIR
  : join(BRIDGE_ROOT, "logs");

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const KEEP = 3;                    // 保留 bridge.log.1 ~ .3，共 4 份 ≈ 20MB 上限

/** 打开日志文件句柄前的目录保障；失败静默降级为仅 stdout（磁盘满等场景不反噬业务）。 */
function ensureDir() {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮转：bridge.log → bridge.log.1 → bridge.log.2 → bridge.log.3（.3 直接覆盖）。
 * renameSync 同卷原子，Windows 上目标存在也能覆盖（rename 语义与 POSIX 一致）。
 */
function rotateIfNeeded() {
  try {
    const st = statSync(logPath());
    if (st.size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = join(LOG_DIR, `bridge.log.${i}`);
      const to = join(LOG_DIR, `bridge.log.${i + 1}`);
      try { renameSync(from, to); } catch { /* 源不存在就跳过 */ }
    }
    renameSync(logPath(), join(LOG_DIR, "bridge.log.1"));
  } catch {
    // stat 失败 = 文件不存在，无需轮转
  }
}

function logPath() {
  return join(LOG_DIR, "bridge.log");
}

/** 写一条单行 JSON 日志。level ∈ debug|info|warn|error。 */
export function log(level, event, fields = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  console.log(entry);
  if (!ensureDir()) return;
  try {
    rotateIfNeeded();
    appendFileSync(logPath(), entry + "\n", "utf8");
  } catch {
    // 文件写失败不反噬服务（只保证 stdout 有输出）
  }
}

export function loggerFor(module) {
  return {
    debug: (event, fields) => log("debug", event, { module, ...fields }),
    info: (event, fields) => log("info", event, { module, ...fields }),
    warn: (event, fields) => log("warn", event, { module, ...fields }),
    error: (event, fields) => log("error", event, { module, ...fields })
  };
}
