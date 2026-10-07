// lib/dsh-probe.js —— 自动蒸馏触发器
// DSH headless 是独立 CLI（与 DSH 桌面应用/Web 3080 无关），蒸馏不需要"等 DSH 启动"。
// 新语义：bridge 周期检查缓冲队列——有 pending 就直接尝试蒸馏（立即入库）；
// headless 调用失败（网络/API 异常）时下轮再试，原料永不丢失。
import net from "node:net";
import { loggerFor } from "./log.js";

const log = loggerFor("dsh-probe");

/** TCP 探测（保留：仅用于日志里附带记录 DSH Web 状态，不再是蒸馏前置条件）。 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { try { socket.destroy(); } catch (e) { /* noop */ } resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 启动探测循环。opts: {config, hasPending, runDistill}。返回 {stop}。 */
export function startDshProbe(opts) {
  const config = opts.config;
  const hasPending = opts.hasPending;
  const runDistill = opts.runDistill;
  const d = (config && config.distill) || {};
  if (d.enabled === false) { log.info("probe-disabled"); return { stop() {} }; }
  const host = d.dshHost || "127.0.0.1";
  const port = d.dshWebPort || 3080;
  const intervalMs = d.probeIntervalMs || 60000;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      if (hasPending()) {
        const webUp = await tcpProbe(host, port, 800).catch(() => false);
        log.info("auto-distill-attempt", { dshWebUp: webUp });
        try { await runDistill(); } catch (e) { log.warn("auto-distill-fail", { msg: String(e).slice(0, 200) }); }
      }
    } catch (e) { /* 静默 */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  let timer = setTimeout(tick, 5000);   // 启动 5s 后首轮检查（bridge 起来时若有积压立即蒸）
  log.info("probe-armed", { mode: "pending-poll", intervalMs });

  return {
    stop() { stopped = true; clearTimeout(timer); }
  };
}
