#!/usr/bin/env node
import fs from "node:fs";
// server.js —— mneme-bridge 入口
// 启动序列（设计文档 §1）：
//   1. 读/生成 config.json（首次生成随机 bridgeToken）
//   2. 模式决策：mode=auto 时探测上游 8790 /health（1s 超时）
//      活着 → remote；不在 → embedded；mode 显式指定则直接走对应模式
//   3. 起 HTTP 服务（0.0.0.0:8760）
// 模式进程内粘滞（设计文档 §1）：不做热切换。为什么安全：两种模式打开的是
// 同一个 SQLite 库（WAL 多进程并发），读写语义一致，切换只影响路径不影响数据；
// 为什么不热切：运行中 embedded→remote 需要关库重连，瞬间的写失败比路径偏旧
// 更伤——重启 bridge 才切换，代价一秒钟，收益零风险。DSH 重启期间 remote 请求
// 会 502，此时重启 bridge 即落回 embedded 继续服务（embedded 连接不依赖 DSH 进程）。
import { createServer } from "node:http";
import { loadOrCreateConfig, CONFIG_PATH } from "./lib/config.js";
import { createRemoteBackend, UpstreamError } from "./lib/remote.js";
import { createEmbeddedBackend } from "./lib/embedded.js";
import { createRequestHandler } from "./lib/router.js";
import { createConversationHandler } from "./lib/conversation.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const B_ROOT = dirname(fileURLToPath(import.meta.url));   // bridge 根目录
import { loggerFor } from "./lib/log.js";
// v0.3：全自动对话蒸馏器（B 路线）——DSH headless 批量总结缓冲的网页对话
import { createDistiller } from "./lib/distiller.js";
import { createImportHandler } from "./lib/importer.js";
// v0.4：导入预估器（三层漏斗 L3 的预估确认，纯计算不落库）
import { createEstimateHandler } from "./lib/estimate.js";
import { createPendingStore } from "./lib/pending.js";   // v0.5 保留（legacy 迁移读取旧 mneme 缓冲用）
import { createBufferStore } from "./lib/buffer.js";
import { startDshProbe } from "./lib/dsh-probe.js";

// server 自身的生命周期日志（loggerFor 返回 debug/info/warn/error 四级对象）
const slog = loggerFor("server");

// 探测上游 /health：1s 超时（设计文档 §1）。任何网络错误都算「不在」。
async function probeMneme(url, timeoutMs) {
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/health", {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {  const startedAt = Date.now();
  const { config, created } = loadOrCreateConfig();
  if (created) {
    slog.info("config-generated", { path: CONFIG_PATH });
    // 首次生成的 bridgeToken 必须让用户看到：它同时会写进 config.json
    console.log("[mneme-bridge] generated bridgeToken: " + config.bridgeToken);
  }

  // ---- 模式决策 -------------------------------------------------------------
  let backend;
  const m = config.mneme;
  if (m.mode === "remote" || m.mode === "embedded") {
    // 显式指定：跳过探测。remote 指定但上游不在时，请求会得到 502——
    // 这是运维显式选择，不是探测失误，所以不做兜底切换。
    slog.info("mode-forced", { mode: m.mode });
  }

  let mode = m.mode;
  if (mode === "auto") {
    const alive = await probeMneme(m.url, m.probeTimeoutMs);
    mode = alive ? "remote" : "embedded";
    slog.info("mode-probed", { upstream: m.url, alive, mode });
  }

  if (mode === "remote") {
    backend = createRemoteBackend(m);
  } else {
    // embedded 组装失败（libPath 错、node:sqlite 不可用等）直接退出：
    // 半可用的记忆服务比不可用更危险（比如库锁在坏状态里）。
    try {
      backend = await createEmbeddedBackend(m);
    } catch (err) {
      slog.error("embedded-init-failed", { msg: String(err?.stack ?? err) });
      console.error("[mneme-bridge] embedded init failed:", err?.message ?? err);
      process.exit(1);
    }
  }

  // ---- HTTP 服务 --------------------------------------------------------------
  // v0.5：实时对话原料写 bridge 自有缓冲（不再进 mneme）
  // v0.5：bridge 自有缓冲（架构裁决——待蒸馏原料绝不进 mneme）
  const bufferStore = createBufferStore(process.env.MNEME_BRIDGE_DATA_DIR || join(B_ROOT, "data"));   // v0.5.1：支持 env 覆盖（smoke 隔离用），生产固定 bridge/data
  let pendingStore = null;   // legacy：迁移期读取旧 mneme 缓冲（迁移脚本跑完后可删）
  const conversation = createConversationHandler(
    { capacity: config.conversation?.capacity ?? 500 },
    (memory) => {
      // v0.5.22：导入链路的会话 id / 摘要卡形态此前从未被读取——
      // importer 把 sid 放进 memory.tags（imp-sess:<sid>）、kind 放进 tags（summary-card），
      // 而这里只找 content 里的 "session: " 行（importer 不写该行）→ 导入原料永远 sessionId=null、
      // 摘要卡被当普通对话。现在 tags 优先、content 行兜底。
      const tags = Array.isArray(memory.tags) ? memory.tags.filter((t) => typeof t === "string") : [];
      const tagSess = tags.find((t) => t.startsWith("imp-sess:"));
      const content = String(memory.content || "");
      const um = content.match(/用户: ([\s\S]*?)(?:\n助手: |$)/);
      const am = content.match(/助手: ([\s\S]*?)(?:\nurl: |\nsession: |$)/);
      const sessM = content.match(/session: (\S+)/);
      const urlM = content.match(/url: (\S+)/);
      const sid = (tagSess ? tagSess.slice("imp-sess:".length) : "") || (sessM ? sessM[1] : "") || null;
      const kind = tags.includes("summary-card") ? "summary-card" : "conversation";
      return bufferStore.add({
        sessionId: sid,
        kind,
        user: um ? um[1] : memory.title.replace(/^网页对话:/, ""),
        assistant: am ? am[1] : "",
        url: urlM ? urlM[1] : null,
        occurredAt: memory.occurred_at
      }) ? { status: 201, json: { action: "buffered" } } : { status: 200, json: { deduped: true } };
    }
  );
  // ---- v0.3 蒸馏器接线 --------------------------------------------------------
  // pending 存取器只在 embedded 模式可用（remote 时 8790 无按 tags 查询能力，
  // 蒸馏是「bridge 本地缓冲」语义，embedded 才是它的主场；remote 下禁用并日志说明）。
  let distiller = null;
  let probe = null;
  if (backend.backend === "embedded" && backend.store) {
    pendingStore = createPendingStore(backend.store);
    distiller = createDistiller({
      config,
      backend,
      // v0.5.11：蒸馏取静默会话的料（活跃会话等它冷却，保证整会话一次调用全局视角）
      loadPending: () => bufferStore.listIdlePending((config.distill && config.distill.idleMs) || 600000, (config.distill && config.distill.batchLimit) || 60),
      loadAllPending: () => bufferStore.listPending((config.distill && config.distill.batchLimit) || 60),   // v0.5.11：手动「立即蒸馏」用全量
      markDistilled: (ids) => bufferStore.markDone(ids),
      // v0.4 断点续跑：会话级跳过/登记（tags 的 imp-sess:<sid> 状态机）
      isSessionDone: (sid) => bufferStore.isSessionDone(sid),
      markSessionDone: (sid) => bufferStore.markSessionDone(sid)
    });
    // v0.5.11：自动蒸馏只看"静默会话"（默认 10 分钟无新轮次）——避免逐轮蒸馏碎片化+烧 token
    const idleMs = (config.distill && config.distill.idleMs) || 600000;
    probe = startDshProbe({
      config,
      hasPending: () => bufferStore.listIdlePending(idleMs, 1).length > 0,
      runDistill: () => distiller.runIfPending()
    });
    slog.info("distiller-armed", { probe: "dsh-web-port", auto: true });
  } else {
    slog.info("distiller-unavailable-remote-mode");
  }

  // v0.4：旧会话批量导入处理器（复用 backend.save 与蒸馏缓冲状态机）；
  // maxImportChars 字符闸从 config.import 读（默认 50000）
  const importMaxChars = config.import?.maxImportChars ?? 50000;
  // v0.5：导入原料写 bridge 自有缓冲（不再进 mneme）
  const importer = createImportHandler(
    { maxBatch: 200, maxImportChars: importMaxChars },
    (memory) => {
      // importer 合成的 memory.content = "用户: ...\n助手: ...\nurl: ..." 格式
      const um = memory.content.match(/用户: ([\s\S]*?)(?:\n助手: |\nurl: |$)/);
      const am = memory.content.match(/助手: ([\s\S]*?)(?:\nurl: |$)/);
      const urlM = memory.content.match(/url: (\S+)/);
      const sessTag = (memory.tags || []).find(t => t.startsWith("imp-sess:"));
      return bufferStore.add({
        sessionId: sessTag ? sessTag.slice(9) : null,
        kind: (memory.tags || []).includes("summary-card") ? "summary-card" : "conversation",
        user: um ? um[1] : memory.title.replace(/^旧会话:/, ""),
        assistant: am ? am[1] : "",
        url: urlM ? urlM[1] : (memory.content.match(/url: (.+)/) || [])[1] || null,
        occurredAt: memory.occurred_at,
        dedupKey: (memory.content_hash && /^[a-f0-9]{64}$/.test(memory.content_hash)) ? memory.content_hash : null
      }) ? { status: 201, json: { action: "buffered" } } : { status: 200, json: { deduped: true } };
    }
  );
  // v0.4：预估器（POST /memory/import/estimate）——与 import 同口径，纯计算
  const estimator = createEstimateHandler({ maxImportChars: importMaxChars });

  const handler = createRequestHandler({
    bridgeToken: config.bridgeToken,
    backend,
    conversation,
    startedAt,
    // v0.2：/memory/context 的默认条数来自 config.mneme（老配置缺省时
    // loadOrCreateConfig 已补默认值，这里再兜一层防御）
    bufferStore,   // v0.4.4：缓冲队列查看（/memory/pending）
    contextCfg: {
      pinsLimit: m.contextPinsLimit,
      relatedTopK: m.contextRelatedTopK
    },
    // v0.3.1：蒸馏器引用（面板 POST /memory/distill 触发手动蒸馏）
    distiller,
    importer,
    // v0.4：导入预估器（POST /memory/import/estimate）
    estimator
  });

  const server = createServer(handler);
  server.listen(config.port, config.host, () => {
    slog.info("bridge-listening", {
      host: config.host,
      port: config.port,
      backend: backend.backend
    });
    console.log(
      `[mneme-bridge] listening on http://${config.host}:${config.port} (backend=${backend.backend})`
    );
  });

  // 端口被占（比如已经起了一份 bridge）：报清错退出，不做端口跳跃——
  // 扩展/手机侧的 URL 是写死的，静默换端口等于坏。
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      slog.error("port-in-use", { port: config.port });
      console.error(`[mneme-bridge] port ${config.port} in use; is another bridge running?`);
      process.exit(1);
    }
    throw err;
  });

  // ---- 收尾：SIGINT/SIGTERM 关库退出 -----------------------------------------
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    slog.info("bridge-shutdown", { signal });
    server.close();
    try { if (probe) probe.stop(); } catch { /* noop */ }
    try {
      await backend.close();
    } catch { /* close 已各自吞错 */ }
    process.exit(0);
  }  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  slog.error("boot-failed", { msg: String(err?.stack ?? err) });
  console.error("[mneme-bridge] boot failed:", err);
  process.exit(1);
});

// UpstreamError 在本文件不直接抛（它在 remote.js → router 链路里流转），
// 这里 import 并 void 一下：保证打包/静态检查工具能顺着入口看到这条类型链。
void UpstreamError;