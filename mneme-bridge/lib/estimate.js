// lib/estimate.js —— 导入预估器（v0.4 三层漏斗 L3 的「预估确认」）
// 纯计算不落库：给扩展 L3 确认弹层报「本次导入 ≈ 多少字符 / 多少 token / 多少会话」。
// 口径与落库严格一致：estimateChars = 合成 content 的实际字符量（user/assistant
// 各截 8000 后的落库尺寸）——它同时是蒸馏输入的上界；扩展传摘要卡形态的
// items 时，算出来的自然就是摘要卡的成本。importContentOf 同时被 importer.js
// 用来合成落库 content：单处维护，估算与实际永远不会漂移。
import { loggerFor } from "./log.js";

const log = loggerFor("estimate");

/**
 * 会话键提取：item.sessionId 优先，其次从 url 路径尾段取指纹
 * （chat.deepseek.com/a/<id> 形态）。返回 null = 无有效会话标记。
 * 白名单校验的原因：sid 会进入 SQL LIKE 与 tags，限定字符集既防 LIKE 通配
 * 注入（%/_ 会放宽匹配导致跳错会话），也防畸形标记污染 mneme tags。
 */
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function sessionKeyOf(item) {
  if (item === null || typeof item !== "object") return null;
  let sid = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
  if (!sid && typeof item.url === "string" && item.url.trim()) {
    try {
      const seg = new URL(item.url).pathname.split("/").filter(Boolean).pop() ?? "";
      sid = seg;
    } catch { /* 非法 url 当无标记 */ }
  }
  return SID_RE.test(sid) ? sid : null;
}

/**
 * 合成导入 content：与 importer.js 落库公式完全一致（截断阈值也一致）。
 * importer 从本模块 import，保证 estimate 的字符口径 = 实际落库字符量。
 */
export const IMPORT_USER_CLIP = 8000;
export const IMPORT_ASSISTANT_CLIP = 8000;

export function importContentOf(item) {
  const user = typeof item.user === "string" ? item.user.trim() : "";
  const assistant = typeof item.assistant === "string" ? item.assistant.trim() : "";
  return "用户: " + user.slice(0, IMPORT_USER_CLIP) +
    "\n助手: " + assistant.slice(0, IMPORT_ASSISTANT_CLIP) +
    (typeof item.url === "string" && item.url ? "\nurl: " + item.url : "");
}

/**
 * 创建预估处理器。
 * @param {{ maxImportChars?: number }} opts  config.import.maxImportChars
 */
export function createEstimateHandler(opts) {
  const maxChars = Number.isInteger(opts?.maxImportChars) && opts.maxImportChars > 0
    ? opts.maxImportChars
    : 50000;

  /**
   * POST /memory/import/estimate 的处理器。
   * 永远 200（纯计算）：超限也只是 wouldExceed:true——UI 要先看到「超了多少」
   * 才能引导用户回 L1 减勾选；真正拦写的是 /memory/import 的同口径闸。
   * 返回 { estimateChars, estimateTokens, sessions, maxImportChars, wouldExceed }。
   */
  return async function handleEstimate(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      const err = new Error("invalid-body"); err.status = 400; throw err;
    }
    if (!Array.isArray(body.items)) {
      const err = new Error("items array required"); err.status = 400; throw err;
    }
    const items = body.items;
    // v0.4.1：full 模式采样估算——扩展只送 ≤50 条样本 + 真实总字符（全量 items 太大，
    // sendMessage 传大 JSON 会卡死）。totalChars 直通优先，样本仅用于 sessions 去重。
    const sampled = Number.isFinite(body.totalChars) && body.totalChars > 0;
    let estimateChars = 0;
    const sessionSet = new Set();
    let noSidIndex = 0;
    for (const it of items) {
      // 字符口径 = 落库 content 实际长度（含「用户:/助手:/url:」框架字符）
      estimateChars += importContentOf(it).length;
      // 会话数：有 sid 的按 sid 去重；无标记的每条独立计（旧扩展一轮 ≈ 一会话）
      const sid = sessionKeyOf(it);
      sessionSet.add(sid ?? "no-sid-" + (noSidIndex++));
    }
    if (sampled) {
      estimateChars = Math.round(body.totalChars);   // 采信扩展侧全量字符统计
    }
    // token 粗估：中文场景 ≈ chars/1.6（任务指定口径，只做预算提示不做出账依据）
    const estimateTokens = Math.ceil(estimateChars / 1.6);
    const result = {
      items: Number.isFinite(body.totalItems) ? body.totalItems : items.length,
      estimateChars,
      estimateTokens,
      sessions: sessionSet.size,
      maxImportChars: maxChars,
      wouldExceed: estimateChars > maxChars
    };
    log.info("import-estimate", { items: result.items, chars: estimateChars, sessions: result.sessions });
    return { status: 200, json: result };
  };
}
