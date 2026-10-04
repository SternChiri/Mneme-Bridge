#!/usr/bin/env node
// scripts/smoke.mjs —— mneme-bridge 一键冒烟（零依赖）
// 覆盖面（任务验收清单）：
//   [remote] 假 mneme 打桩（模拟 8790 路由）→ save/search/recent/conversation+去重
//   [remote] 鉴权转发（假 mneme 校验 mneme token）、上游超时 → 502
//   [502]    上游死端口 → save/recent 502 {error:"mneme-unavailable"}
//   [401]    无 token / 错 token；/health 免鉴权
//   [CORS]   OPTIONS 预检 204 + 放行头
//   [embedded] 生产库先复制（含 -wal/-shm）到临时目录，对副本跑同四链路 + 去重，
//              并用 node:sqlite 直查副本确认落库
//   [安全]   生产库 memory.db 全程只 stat 不打开——前后 stat 一致才算 PASS
//
// 运行：node scripts/smoke.mjs（不在 mneme-bridge 目录里跑也行）
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, copyFile, stat, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BRIDGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const openBufferDb = (path) => { try { if (!existsSync(path)) return null; return new DatabaseSync(path, { readOnly: true }); } catch { return null; } };
const NODE = process.execPath;
const FAKE_MNEME_TOKEN = "fake-mneme-token-abc123";
const TAG = Date.now().toString(36);

// ---- 小工具 -----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 挑一个当前空闲的 TCP 端口（bind 0 后立刻释放；存在理论竞态，冒烟可接受）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** HTTP 客户端：JSON in/out，带总超时。返回 {status, json, headers}。 */
async function http(method, url, { body, token, timeoutMs = 8000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应保底 null */ }
    return { status: res.status, json, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 断言与汇总 --------------------------------------------------------------
const results = [];
let section = "";
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  results.push({ section, name, ok, detail: String(detail).slice(0, 300) });
  console.log(`  ${ok ? "ok  " : "FAIL"} - ${name}${ok ? "" : "  << " + detail}`);
}
function summarize() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log("\n==== SMOKE " + (fail === 0 ? "PASS" : "FAILED") +
    ` (${pass}/${results.length} checks passed) ====`);
  for (const f of results.filter((r) => !r.ok)) {
    console.log(`  [${f.section}] ${f.name}: ${f.detail}`);
  }
  return fail === 0;
}

// ---- 假 mneme（模拟 8790 路由；带鉴权校验与慢路径）-----------------------------
/**
 * 路由与真 mneme 对齐（mneme-verification.md §4）：
 *   GET  /health            免鉴权 {ok:true}
 *   POST /memories          201 {id, action:"created"}（记录 body 与 auth 头）
 *   GET  /search?q&mode     q 以 __slow__ 开头 → 延迟 3s（打桩超时路径）
 *   GET  /memories          按 limit 回列表
 *   GET  /status            {version:"0.8.9", ...}
 * 其余路径 404；除 /health 外 auth 必须是 "Bearer " + FAKE_MNEME_TOKEN，否则 401。
 */
function startFakeMneme(port) {
  const state = { saves: [], lastAuth: "", searches: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fake-mneme");
    const p = url.pathname;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* 容错 */ }
      const auth = req.headers.authorization ?? "";
      state.lastAuth = auth;

      const deny = () => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
      };
      const reply = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET" && p === "/health") return reply(200, { ok: true });
      if (auth !== "Bearer " + FAKE_MNEME_TOKEN) return deny();

      // v0.2 /memory/context 的上游桩：/profile /rules（形状对齐真 mneme，
      // api-standalone.js L262/L268：{profile:""} / {rules:[]}）
      if (req.method === "GET" && p === "/profile") {
        return reply(200, { profile: "fake-user-profile: 偏好中文回复，注重新鲜度" });
      }
      if (req.method === "GET" && p === "/rules") {
        return reply(200, { rules: ["fake-rule-1: 回答要短", "fake-rule-2: 引用给出处"] });
      }

      if (req.method === "POST" && p === "/memories") {
        state.saves.push({ body, auth });
        if (!body || typeof body.type !== "string" || typeof body.title !== "string") {
          return reply(400, { error: "invalid-body" });
        }
        return reply(201, { id: "fake-" + (state.saves.length), action: "created", ...body });
      }
      if (req.method === "GET" && p === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const mode = url.searchParams.get("mode") ?? "auto";
        state.searches.push({ q, mode });
        if (q.startsWith("__slow__")) {
          // 打桩超时：3s > bridge 的 requestTimeoutMs(1s)，bridge 应中止并 502
          return setTimeout(() => reply(200, { items: [], mode }), 3000);
        }
        return reply(200, { items: [{ id: "s1", type: "project", title: "hit:" + q, content: "fake search result", tags: [], importance: 3, source: "fake", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }], mode: "keyword" });
      }
      if (req.method === "GET" && p === "/memories") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        // v0.2：支持 minImportance 过滤（pins 桩）——>=5 的给高价值条目，
        // 否则回退普通 recent 条目（importance 3）
        const minImp = url.searchParams.get("minImportance");
        if (minImp !== null && Number(minImp) >= 5) {
          const pins = Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
            id: "p" + (i + 1), type: "preference", title: "pin-" + (i + 1),
            content: "pin-content-" + (i + 1),
            tags: [], importance: 5, source: "fake",
            created_at: "2026-02-0" + (i + 1) + "T00:00:00Z", updated_at: "2026-02-0" + (i + 1) + "T00:00:00Z"
          }));
          return reply(200, { items: pins, total: pins.length });
        }
        const items = Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
          id: "r" + (i + 1), type: "project", title: "recent-" + (i + 1), content: "c" + i,
          tags: [], importance: 3, source: "fake",
          created_at: "2026-01-0" + (i + 1) + "T00:00:00Z", updated_at: "2026-01-0" + (i + 1) + "T00:00:00Z"
        }));
        return reply(200, { items, total: items.length });
      }
      if (req.method === "GET" && p === "/status") {
        return reply(200, { version: "0.8.9", memories: { total: 42, byType: {} }, entities: 0, uptime_s: 1 });
      }
      return reply(404, { error: "not-found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, state }));
  });
}

// ---- bridge 子进程 -------------------------------------------------------------
const children = [];

/** 用给定 config 起一个 bridge 子进程（config 落在 tmp，env 重定向）。 */
async function startBridge(cfg, tag, tmp) {
  const cfgPath = join(tmp, `config-${tag}.json`);
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const child = spawn(NODE, [join(BRIDGE_DIR, "server.js")], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      MNEME_BRIDGE_CONFIG: cfgPath,
      MNEME_BRIDGE_LOG_DIR: join(tmp, "logs-" + tag),
      MNEME_BRIDGE_DATA_DIR: join(tmp, "buffer-" + tag)   // v0.5.1：缓冲隔离（不再烧生产 buffer.db）
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.push(child);
  const out = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  child.on("exit", (code, sig) => out.push(`[child exit ${code} ${sig}]\n`));

  // 就绪等待：/health 免鉴权，轮询到 200 为止（10s 上限）
  const base = `http://127.0.0.1:${cfg.port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await http("GET", base + "/health", { timeoutMs: 1500 });
      if (r.status === 200) return { child, base, logs: () => out.join("") };
    } catch { /* 未就绪，继续轮询 */ }
    await sleep(150);
  }
  throw new Error(`bridge ${tag} not ready in 10s\nlogs:\n${out.join("")}`);
}

function stopBridge(b) {
  if (!b) return sleep(50);
  try { b.child.kill(); } catch { /* 已退出 */ }
  children.splice(children.indexOf(b.child), 1);
  return sleep(200);
}

process.on("exit", () => { for (const c of children) { try { c.kill(); } catch { /* noop */ } } });

// ---- 主流程 --------------------------------------------------------------------
async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "mneme-bridge-smoke-"));
  const prodStatBefore = await stat(join("F:/DeepSeek/.dsh/memory", "memory.db"));
  console.log("smoke tmpdir:", tmp);

  // 生产库只复制不打开（任务硬性约束 3）：memory.db + -wal + -shm 三件套
  const embedDir = join(tmp, "embedded-data");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(embedDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await copyFile(join("F:/DeepSeek/.dsh/memory", "memory.db" + suffix), join(embedDir, "memory.db" + suffix));
    } catch (e) {
      if (suffix === "") throw new Error("生产库 memory.db 复制失败：" + e.message);
      // wal/shm 不存在是正常态（checkpoint 后消失）
    }
  }

  // v0.4 断点续跑端到端要真跑蒸馏器：生成 fake-dsh 的 .cmd 包装（distiller 在
  // win32 下 shell:true 单串拼接 spawn，.cmd 是它可执行的最小形态）。
  const fakeDshCmd = join(tmp, "fake-dsh.cmd");
  await writeFile(fakeDshCmd, "@echo off\nnode \"" + join(BRIDGE_DIR, "scripts", "fake-dsh.mjs").replace(/\\/g, "/") + "\"\n", "utf8");

  const [FM, BA, BB, BC, DEAD] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const fake = await startFakeMneme(FM);

  const baseCfg = {
    bridgeToken: "bt-" + TAG,
    conversation: { capacity: 500 }
  };
  const cfgA = { ...baseCfg, port: BA, host: "127.0.0.1", import: { maxImportChars: 50000 }, mneme: { mode: "remote", url: `http://127.0.0.1:${FM}`, token: FAKE_MNEME_TOKEN, requestTimeoutMs: 1000 } };
  const cfgB = { ...baseCfg, bridgeToken: "bt-B-" + TAG, port: BB, host: "127.0.0.1", mneme: { mode: "remote", url: `http://127.0.0.1:${DEAD}`, token: FAKE_MNEME_TOKEN, requestTimeoutMs: 1000 } };
  const cfgC = {
    ...baseCfg, bridgeToken: "bt-C-" + TAG, port: BC, host: "127.0.0.1",
    mneme: { mode: "embedded", libPath: "", dataDir: embedDir.replace(/\\/g, "/") },   // libPath 留空走自动探测（v0.5.40 开源化）
    // v0.4 断点续跑端到端：蒸馏命令指向 fake-dsh 包装（秒回固定 JSON）；
    // 探测拉长防误触发（dsh-probe 只在离线→在线跳变时触发，fake 端口恒离线）
    distill: { enabled: false, dshCommand: fakeDshCmd, headlessTimeoutMs: 30000 },
    // v0.6.2（task-12）：蒸馏后清理的 DSH home 重定向到临时目录——smoke 绝不
    // 碰真实 ~/.dsh/sessions（与生产库零写红线同级的隔离纪律）
    sessionCleanup: { dshHome: join(tmp, "fake-dsh-home") }
  };

  try {
    // ============================ remote 模式（bridge A） ========================
    section = "remote";
    console.log("\n-- remote 模式（假 mneme 打桩）--");
    const A = await startBridge(cfgA, "A", tmp);
    const tA = "bt-" + TAG;

    // health 免鉴权
    {
      const r = await http("GET", A.base + "/health");
      check("GET /health 免鉴权 200", r.status === 200, r.status + " " + r.text.slice(0, 120));
      check("health.backend=remote", r.json?.backend === "remote", JSON.stringify(r.json));
      check("health.ok=true", r.json?.ok === true, JSON.stringify(r.json));
      check("health.mneme.url=reachable", r.json?.mneme?.url === "reachable", JSON.stringify(r.json?.mneme));
    }

    // OPTIONS 预检
    {
      const r = await http("OPTIONS", A.base + "/memory/save", { headers: { origin: "http://example.com" } });
      check("OPTIONS 预检 204", r.status === 204, r.status);
      check("CORS Allow-Origin=*", r.headers.get("access-control-allow-origin") === "*", String(r.headers.get("access-control-allow-origin")));
      check("CORS Allow-Headers 含 Authorization", (r.headers.get("access-control-allow-headers") ?? "").includes("Authorization"), String(r.headers.get("access-control-allow-headers")));
    }

    // 401 分支
    {
      const r1 = await http("GET", A.base + "/memory/recent");
      check("无 token → 401", r1.status === 401 && r1.json?.error === "unauthorized", r1.status + " " + r1.text.slice(0, 120));
      const r2 = await http("GET", A.base + "/memory/recent", { token: "wrong-token" });
      check("错 token → 401", r2.status === 401, r2.status);
      const r3 = await http("GET", A.base + "/health");
      check("/health 不吃 401（免鉴权）", r3.status === 200, r3.status);
    }

    // save：转发 + mneme token 鉴权转发
    {
      const r = await http("POST", A.base + "/memory/save", {
        token: tA,
        body: { type: "pitfall", title: "smoke-remote-save", content: "remote 链路打桩内容", importance: 2, tags: ["smoke"], source: "smoke" }
      });
      check("POST /memory/save → 201", r.status === 201, r.status + " " + r.text.slice(0, 160));
      check("上游收到的 auth = mneme token", fake.state.lastAuth === "Bearer " + FAKE_MNEME_TOKEN, fake.state.lastAuth);
      check("上游收到完整 body", fake.state.saves.at(-1)?.body?.title === "smoke-remote-save", JSON.stringify(fake.state.saves.at(-1)?.body ?? null).slice(0, 160));
      // 4xx 透传：上游 400 原样透传
      const bad = await http("POST", A.base + "/memory/save", { token: tA, body: { title: "no-type" } });
      check("上游 400 透传", bad.status === 400 && bad.json?.error === "invalid-body", bad.status + " " + bad.text.slice(0, 120));
    }

    // search
    {
      const r = await http("POST", A.base + "/memory/search", { token: tA, body: { q: "smoke-query", mode: "auto", topK: 5 } });
      check("POST /memory/search → 200 items", r.status === 200 && Array.isArray(r.json?.items) && r.json.items[0]?.title === "hit:smoke-query", r.status + " " + r.text.slice(0, 160));
      check("search 透传 q/mode", fake.state.searches.at(-1)?.q === "smoke-query" && fake.state.searches.at(-1)?.mode === "auto", JSON.stringify(fake.state.searches.at(-1)));
    }

    // search 超时 → 502（假 mneme 延迟 3s > bridge 1s 超时）
    {
      const t0 = Date.now();
      const r = await http("POST", A.base + "/memory/search", { token: tA, body: { q: "__slow__timeout" }, timeoutMs: 8000 });
      const dt = Date.now() - t0;
      check("上游超时 → 502 mneme-unavailable", r.status === 502 && r.json?.error === "mneme-unavailable", r.status + " " + r.text.slice(0, 120));
      check("超时在 ~1s 触发（而非等满 3s）", dt < 2500, dt + "ms");
    }

    // recent
    {
      const r = await http("GET", A.base + "/memory/recent?limit=3", { token: tA });
      check("GET /memory/recent → 200 items", r.status === 200 && Array.isArray(r.json?.items) && r.json.items.length === 3, r.status + " " + r.text.slice(0, 160));
    }

    // conversation + 去重
    {
      const conv = { user: "remote 冒烟用户提问", assistant: "remote 冒烟助手回答", url: "https://chat.deepseek.com/a/b", sessionId: "s-" + TAG };
      const r1 = await http("POST", A.base + "/memory/conversation", { token: tA, body: conv });
      check("POST /memory/conversation 首次入库（进缓冲）", r1.status === 201 && r1.json?.action === "buffered", r1.status + " " + r1.text.slice(0, 160));
      // v0.5：原料进 bridge 缓冲（不落 mneme）
      const savesAtConvStart = fake.state.saves.length;
      check("conversation 未写 mneme", fake.state.saves.length === savesAtConvStart, "saves=" + fake.state.saves.length);
      const r2 = await http("POST", A.base + "/memory/conversation", { token: tA, body: conv });
      check("重复 conversation → 200 deduped:true", r2.status === 200 && r2.json?.deduped === true, r2.status + " " + r2.text.slice(0, 160));
      const savesBefore = fake.state.saves.length;
      const r3 = await http("POST", A.base + "/memory/conversation", { token: tA, body: { ...conv, assistant: "换一个回答就不去重" } });
      check("内容不同再次入缓冲（mneme 仍零写入）", r3.status === 201 && fake.state.saves.length === savesBefore, r3.status + " saves=" + fake.state.saves.length);

  // ---- v0.4 批量导入 ----
  {
    const r1 = await http("POST", A.base + "/memory/import", { token: tA, body: { items: [
      { user: "旧会话问1", assistant: "旧会话答1", url: "https://x/s/old1" },
      { user: "旧会话问2", assistant: "旧会话答2" },
      { user: "", assistant: "半条应拒" },
      { user: "旧会话问1", assistant: "旧会话答1", url: "https://x/s/old1" }
    ] } });
    check("POST /memory/import 批量受理", r1.status === 200, r1.status + " " + r1.text.slice(0, 120));
    check("import 计数 accepted=2 deduped=1 rejected=1", r1.json?.accepted === 2 && r1.json?.deduped === 1 && r1.json?.rejected === 1, JSON.stringify(r1.json));
    // v0.5：导入原料进 bridge 缓冲（不落 mneme）
    check("import 未写 mneme", fake.state.saves.length === savesAtConvStart, "saves=" + fake.state.saves.length);
    const r2 = await http("POST", A.base + "/memory/import", { token: tA, body: { items: [] } });
    check("import 空数组受理 accepted=0", r2.status === 200 && r2.json?.accepted === 0, r2.status + " " + r2.text.slice(0, 100));
    const r3 = await http("POST", A.base + "/memory/import", { token: tA, body: {} });
    check("import 无 items → 400", r3.status === 400, r3.status + " " + r3.text.slice(0, 100));
    }

    // ---- v0.4（task-9）：/memory/import/estimate 预估器 + maxImportChars 闸 ----
    {
      const savesBeforeImport = fake.state.saves.length; // estimate 不得落库的基准
      // 卡片形态 items：与 L2 摘要卡同构（sessionId + kind）
      const cardItems = [
        { sessionId: "sess-est-1", kind: "summary-card", user: "首条用户消息：帮我写爬虫", assistant: "好的，方案用 Playwright。", url: "https://chat.deepseek.com/a/sess-est-1" },
        { sessionId: "sess-est-1", kind: "summary-card", user: "末条：部署到 VPS", assistant: "已完成部署。", url: "https://chat.deepseek.com/a/sess-est-1" },
        { sessionId: "sess-est-2", kind: "summary-card", user: "second session", assistant: "done" },
        { user: "无标记会话", assistant: "每条独立计" }
      ];
      const e1 = await http("POST", A.base + "/memory/import/estimate", { token: tA, body: { items: cardItems } });
      check("estimate 200 纯计算", e1.status === 200, e1.status + " " + e1.text.slice(0, 160));
      check("estimate.char 数值正确（含框架字符）", typeof e1.json?.estimateChars === "number" && e1.json.estimateChars > 0, JSON.stringify(e1.json));
      // 手工重算口径：每条 content = "用户: "+user+"\n助手: "+assistant（+url 行）
      const expectLen = cardItems.reduce((a, it) =>
        a + ("用户: " + it.user + "\n助手: " + it.assistant + (it.url ? "\nurl: " + it.url : "")).length, 0);
      check("estimate.char 与落库口径一致", e1.json?.estimateChars === expectLen, "got=" + e1.json?.estimateChars + " want=" + expectLen);
      check("estimate.tokens ≈ chars/1.6", e1.json?.estimateTokens === Math.ceil(expectLen / 1.6), String(e1.json?.estimateTokens));
      // 会话数：sess-est-1 两条去重 + sess-est-2 + 无标记独立 = 3
      check("estimate.sessions 按 sessionId 去重", e1.json?.sessions === 3, String(e1.json?.sessions));
      check("estimate 回报 maxImportChars=50000 与 wouldExceed=false", e1.json?.maxImportChars === 50000 && e1.json?.wouldExceed === false, JSON.stringify(e1.json));
      check("estimate 不落库（上游零新增）", fake.state.saves.length === savesBeforeImport, "saves=" + fake.state.saves.length);
      // 空数组
      const e2 = await http("POST", A.base + "/memory/import/estimate", { token: tA, body: { items: [] } });
      check("estimate 空数组 → 全零", e2.status === 200 && e2.json?.estimateChars === 0 && e2.json?.sessions === 0, JSON.stringify(e2.json));
      // 非法 body
      const e3 = await http("POST", A.base + "/memory/import/estimate", { token: tA, body: {} });
      check("estimate 无 items → 400", e3.status === 400, e3.status);
      // 鉴权
      const e4 = await http("POST", A.base + "/memory/import/estimate", { body: { items: [] } });
      check("estimate 无 token → 401", e4.status === 401, e4.status);
      // 超限预估：wouldExceed 标记（不拒绝——纯计算）。
      // 数据口径：user/assistant 落库各截 8000，单条满载 content ≈ 16018 字符，
      // 4 条 ≈ 64072 > 50000 才真超限（闸的口径 = 落库字符量，测试数据必须按它构造）。
      const big = { user: "x".repeat(8000), assistant: "y".repeat(8000) };
      const e5 = await http("POST", A.base + "/memory/import/estimate", { token: tA, body: { items: [big, big, big, big] } });
      check("estimate 超限 → wouldExceed:true 且 200", e5.status === 200 && e5.json?.wouldExceed === true && e5.json?.estimateChars > 50000, JSON.stringify(e5.json)?.slice(0, 160));

      // maxImportChars 闸：import 落库前确认，超限 400 {error:"too-large", estimateChars}
      const tooBig = { user: "u".repeat(8000), assistant: "a".repeat(8000) };
      const rBig = await http("POST", A.base + "/memory/import", { token: tA, body: { items: [tooBig, tooBig, tooBig, tooBig] } });
      check("import 超限 → 400 too-large", rBig.status === 400 && rBig.json?.error === "too-large" && rBig.json?.estimateChars > 50000, rBig.status + " " + rBig.text.slice(0, 160));
      check("import 超限不落库", fake.state.saves.length === savesBeforeImport, "saves=" + fake.state.saves.length);
      // 预算内放行：两条不同内容、各 9000 字符（落库 ~9016×2 ≈ 1.8万 < 5万）
      const ok1 = { sessionId: "sess-under", kind: "summary-card", user: "u".repeat(4500), assistant: "a".repeat(4500) };
      const ok2 = { sessionId: "sess-under", kind: "summary-card", user: "v".repeat(4500), assistant: "b".repeat(4500) };
      const rOk = await http("POST", A.base + "/memory/import", { token: tA, body: { items: [ok1, ok2] } });
      check("import 预算内（~1.8万字符）放行", rOk.status === 200 && rOk.json?.accepted === 2, rOk.status + " " + rOk.text.slice(0, 120));
      // v0.5：sessionId/kind 进 bridge 缓冲行（session_id 列 / kind 列）
      const bufDb1 = openBufferDb(join(tmp, "buffer-A", "buffer.db"));
      const bufRows = bufDb1 ? bufDb1.prepare("SELECT * FROM buffer WHERE status='pending' AND session_id='sess-under'").all() : [];
      if (bufDb1) bufDb1.close();
      check("import sessionId 进缓冲 session_id 列", bufRows.length === 2, "found=" + bufRows.length);
      check("import summary-card kind 进缓冲 kind 列", bufRows.every(r => r.kind === "summary-card"), JSON.stringify(bufRows.map(r => r.kind)));
    }
  }

    // status 透传 + backend 标记
    {
      const r = await http("GET", A.base + "/memory/status", { token: tA });
      check("GET /memory/status 透传 + backend", r.status === 200 && r.json?.version === "0.8.9" && r.json?.backend === "remote", r.status + " " + r.text.slice(0, 160));
    }

    // ---- GET /memory/context（v0.2 remote 聚合）----
    {
      // 带 q：四路聚合
      const r = await http("GET", A.base + "/memory/context?q=smoke-query&topK=4", { token: tA });
      check("remote context 200", r.status === 200, r.status + " " + r.text.slice(0, 200));
      check("context.profile 是 string 非空", typeof r.json?.profile === "string" && r.json.profile.length > 0, JSON.stringify(r.json?.profile)?.slice(0, 120));
      check("context.rules 是 string[]", Array.isArray(r.json?.rules) && r.json.rules.every((x) => typeof x === "string") && r.json.rules.length === 2, JSON.stringify(r.json?.rules)?.slice(0, 120));
      check("context.pins 全部 importance>=5", Array.isArray(r.json?.pins) && r.json.pins.length > 0 && r.json.pins.every((m) => m.importance >= 5), JSON.stringify(r.json?.pins)?.slice(0, 160));
      check("context.pins 每条只留 4 字段", r.json.pins.every((m) => Object.keys(m).sort().join(",") === "content,importance,title,type"), JSON.stringify(r.json.pins[0] ?? {}));
      check("context.related 命中搜索桩", Array.isArray(r.json?.related) && r.json.related.length === 1 && r.json.related[0].title === "hit:smoke-query", JSON.stringify(r.json?.related)?.slice(0, 160));
      check("context.related content 截 160 字", r.json.related.every((m) => typeof m.content === "string" && m.content.length <= 160), "len=" + (r.json?.related?.[0]?.content ?? "").length);
      // q 空：related 必须是 [] 且不打上游 /search
      const before = fake.state.searches.length;
      const r2 = await http("GET", A.base + "/memory/context", { token: tA });
      check("context q 空 → 200 且 related=[]", r2.status === 200 && Array.isArray(r2.json?.related) && r2.json.related.length === 0, r2.status + " " + r2.text.slice(0, 160));
      check("context q 空 → 不打上游 /search", fake.state.searches.length === before, "searches=" + fake.state.searches.length);
      // 鉴权：context 同样要 token
      const r3 = await http("GET", A.base + "/memory/context?q=x");
      check("context 无 token → 401", r3.status === 401, r3.status);
      // 四字段瘦身对 related 也生效
      check("context.related 每条只留 4 字段", r.json.related.every((m) => Object.keys(m).sort().join(",") === "content,importance,title,type"), JSON.stringify(r.json.related[0] ?? {}));
    }

    // 未知路由
    {
      const r = await http("GET", A.base + "/memory/nope", { token: tA });
      check("未知路由 404", r.status === 404, r.status);
    }

    await stopBridge(A);

    // ============================ 502 分支（bridge B） ===========================
    section = "502";
    console.log("\n-- 502 分支（上游死端口）--");
    const B = await startBridge(cfgB, "B", tmp);
    {
      const r1 = await http("POST", B.base + "/memory/save", { token: "bt-B-" + TAG, body: { type: "project", title: "x", content: "y" } });
      check("上游不可达 save → 502", r1.status === 502 && r1.json?.error === "mneme-unavailable", r1.status + " " + r1.text.slice(0, 120));
      const r2 = await http("GET", B.base + "/memory/recent", { token: "bt-B-" + TAG });
      check("上游不可达 recent → 502", r2.status === 502 && r2.json?.error === "mneme-unavailable", r2.status + " " + r2.text.slice(0, 120));
      const r3 = await http("GET", B.base + "/health");
      check("上游不可达 /health 仍 200（bridge 活着）", r3.status === 200 && r3.json?.mneme?.url === "unreachable", r3.status + " " + r3.text.slice(0, 120));
    }
    await stopBridge(B);

    // ============================ embedded 模式（bridge C） ======================
    section = "embedded";
    console.log("\n-- embedded 模式（副本库）--");
    const C = await startBridge(cfgC, "C", tmp);
    const tC = "bt-C-" + TAG;
    {
      const r = await http("GET", C.base + "/health");
      check("embedded /health backend=embedded", r.status === 200 && r.json?.backend === "embedded", r.status + " " + r.text.slice(0, 160));
    }
    {
      // OPTIONS 也验一遍（embedded 分支同一 router）
      const r = await http("OPTIONS", C.base + "/memory/save");
      check("embedded OPTIONS 204", r.status === 204, r.status);
    }
    let savedId = null;
    {
      const r = await http("POST", C.base + "/memory/save", {
        token: tC,
        body: { type: "pitfall", title: "smoke-embedded-pitfall-" + TAG, content: "副本库写入内容 " + TAG, importance: 4, tags: ["smoke"], source: "smoke" }
      });
      check("embedded save → 201 created", r.status === 201 && r.json?.action === "created", r.status + " " + r.text.slice(0, 200));
      savedId = r.json?.id ?? null;
      check("embedded save 返回 id", typeof savedId === "string" && savedId.length > 0, String(savedId));
      // 同 (type,title) 再存 → mneme 合并语义 200 merged
      const r2 = await http("POST", C.base + "/memory/save", {
        token: tC,
        body: { type: "pitfall", title: "smoke-embedded-pitfall-" + TAG, content: "追加内容触发 merged" }
      });
      check("embedded 同标题再存 → 200 merged", r2.status === 200 && r2.json?.action === "merged", r2.status + " " + r2.text.slice(0, 200));
      // 非法 type → 400
      const r3 = await http("POST", C.base + "/memory/save", { token: tC, body: { type: "no-such-type", title: "x", content: "y" } });
      check("embedded 非法 type → 400", r3.status === 400, r3.status + " " + r3.text.slice(0, 120));
    }
    {
      const r = await http("POST", C.base + "/memory/search", { token: tC, body: { q: "smoke-embedded-pitfall-" + TAG, topK: 5 } });
      const hit = Array.isArray(r.json?.items) && r.json.items.some((i) => i.id === savedId);
      check("embedded search 命中新写入", r.status === 200 && hit, r.status + " " + r.text.slice(0, 200));
    }
    {
      const r = await http("GET", C.base + "/memory/recent?limit=5", { token: tC });
      const items = Array.isArray(r.json?.items) ? r.json.items : [];
      check("embedded recent 200 + 含新写入", r.status === 200 && items.some((i) => i.id === savedId), r.status + " " + r.text.slice(0, 200));
      check("embedded recent order=chrono（新写入居首）", items[0]?.id === savedId, "items[0]=" + JSON.stringify(items[0]?.id) + " saved=" + savedId);
    }
    {
      const conv = { user: "embedded 冒烟用户提问", assistant: "embedded 冒烟助手回答", sessionId: "e-" + TAG };
      const r1 = await http("POST", C.base + "/memory/conversation", { token: tC, body: conv });
      check("embedded conversation 入缓冲", r1.status === 201 && r1.json?.action === "buffered", r1.status + " " + r1.text.slice(0, 200));
      const r2 = await http("POST", C.base + "/memory/conversation", { token: tC, body: conv });
      check("embedded conversation 去重", r2.status === 200 && r2.json?.deduped === true, r2.status + " " + r2.text.slice(0, 160));
    }
    {
      const r = await http("GET", C.base + "/memory/status", { token: tC });
      check("embedded status: version/backend/total", r.status === 200 && r.json?.backend === "embedded" && typeof r.json?.version === "string" && typeof r.json?.memories?.total === "number", r.status + " " + r.text.slice(0, 220));
    }
    // ---- GET /memory/context（v0.2 embedded 聚合，副本库）----
    {
      // 副本库的用户设置表先垫高价值数据：profile/rules 写进 user_settings kv，
      // pins 用一条 importance=5 的记忆（经 save 链路写入，不直改库）
      const db2 = new DatabaseSync(join(embedDir, "memory.db"));
      db2.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('profile', ?), ('rules', ?)")
        .run("smoke 副本库画像：偏好简洁中文回复", JSON.stringify(["副本规则一：先结论后细节", "副本规则二：给出来源"]));
      db2.close();

      // pins 数据：importance 5 的记忆（上一段已存 importance=4 的 pitfall，
      // 另存一条 5 的专门命中 pins 过滤）
      await http("POST", C.base + "/memory/save", {
        token: tC,
        body: { type: "project", title: "smoke-pin-high-" + TAG, content: "高价值项目记忆用于 pins 过滤断言", importance: 5 }
      });

      // 带 q：聚合四字段
      const r = await http("GET", C.base + "/memory/context?q=smoke-pin-high-" + TAG + "&topK=4", { token: tC });
      check("embedded context 200", r.status === 200, r.status + " " + r.text.slice(0, 220));
      check("embedded context.profile 读自 settings", r.json?.profile === "smoke 副本库画像：偏好简洁中文回复", JSON.stringify(r.json?.profile));
      check("embedded context.rules 读自 settings", Array.isArray(r.json?.rules) && r.json.rules.length === 2 && r.json.rules[0] === "副本规则一：先结论后细节", JSON.stringify(r.json?.rules));
      check("embedded context.pins 全部为身份记忆（preference/constraint）", Array.isArray(r.json?.pins) && r.json.pins.length > 0 && r.json.pins.every(p => p.type === "preference" || p.type === "constraint"), JSON.stringify(r.json?.pins?.map(p => p.type)));
      check("embedded context.related 含刚写的高价值记忆（q 检索路径）", Array.isArray(r.json?.related) && r.json.related.some(p => p.title === "smoke-pin-high-" + TAG), JSON.stringify(r.json?.related?.map(p => p.title)?.slice(0, 3)));
      check("embedded context.related 命中搜索", Array.isArray(r.json?.related) && r.json.related.some((m) => m.title === "smoke-pin-high-" + TAG), JSON.stringify(r.json?.related)?.slice(0, 220));
      check("embedded context 每条只留 4 字段且截 160", [...r.json.pins, ...r.json.related].every((m) =>
        Object.keys(m).sort().join(",") === "content,importance,title,type" && m.content.length <= 160
      ), JSON.stringify(r.json?.pins?.[0] ?? {}));
      // q 空：related=[]
      const r2 = await http("GET", C.base + "/memory/context", { token: tC });
      check("embedded context q 空 → related=[]", r2.status === 200 && Array.isArray(r2.json?.related) && r2.json.related.length === 0, r2.status + " related=" + JSON.stringify(r2.json?.related)?.slice(0, 80));
      check("embedded context q 空 → profile/pins 仍在", typeof r2.json?.profile === "string" && r2.json.profile.length > 0 && r2.json.pins.length > 0, "profile len=" + (r2.json?.profile ?? "").length + " pins=" + r2.json?.pins?.length);
      // 鉴权
      const r3 = await http("GET", C.base + "/memory/context?q=x");
      check("embedded context 无 token → 401", r3.status === 401, r3.status);
    }

    // ---- v0.4（task-9）：断点续跑端到端（副本库 + fake-dsh headless 桩）----
    // 真实触发路径：同会话分批上报（超 MAX_BATCH 的大会话）。批 1 蒸馏后该会话
    // 在 tags 里留 imp-sess:<sid>distilled；批 2（迟到条目）到齐后再蒸馏时被
    // 会话级跳过——不烧 LLM，且迟到条目被标 distilled 排空状态机。
    {
      // 批 1：会话 sess-rs-1 的两张摘要卡
      const batch1 = [
        { sessionId: "sess-rs-1", kind: "summary-card", user: "RS会话首条：偏好简洁回复", assistant: "好的已记录。", url: "https://chat.deepseek.com/a/sess-rs-1" },
        { sessionId: "sess-rs-1", kind: "summary-card", user: "RS会话末条：部署完成", assistant: "已部署到生产。", url: "https://chat.deepseek.com/a/sess-rs-1" }
      ];
      const i1 = await http("POST", C.base + "/memory/import", { token: tC, body: { items: batch1 } });
      check("resume: 批1 导入受理", i1.status === 200 && i1.json?.accepted === 2, i1.status + " " + i1.text.slice(0, 120));

      // 蒸馏前的产物基准
      const countDistilled = () => {
        const db = new DatabaseSync(join(embedDir, "memory.db"), { readOnly: true });
        try {
          return db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source LIKE 'dsh-distiller%'").get().n;
        } finally { db.close(); }
      };
      const before1 = countDistilled();

      // 手动触发第 1 轮蒸馏（fake-dsh 秒回固定 2 条）
      const d1 = await http("POST", C.base + "/memory/distill", { token: tC });
      check("resume: 第 1 轮蒸馏受理 202", d1.status === 202, d1.status);
      // 轮询直到「产物入库 + 原始行标记」全部落定（同一次 runIfPending 的两个
      // 写步骤，产物在前标记在后——分开断言会撞上中间态）
      let round1 = -1;
      let marks1 = [];
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const db1 = new DatabaseSync(join(embedDir, "memory.db"), { readOnly: true });
        const buf1 = openBufferDb(join(tmp, "buffer-C", "buffer.db"));   // v0.5.1 实例隔离
        try {
          round1 = db1.prepare("SELECT COUNT(*) AS n FROM memories WHERE source LIKE 'dsh-distiller%'").get().n;
          // v0.5：原始行在 bridge 缓冲——蒸馏完成 = status='done' + session_id 匹配
          marks1 = buf1 ? buf1.prepare("SELECT status FROM buffer WHERE session_id = 'sess-rs-1'").all() : [];
        } finally { db1.close(); if (buf1) buf1.close(); }
        if (round1 === before1 + 2 && marks1.length >= 2 && marks1.every(t => t.status === "done")) break;   // v0.5：原料全部 done
      }
      check("resume: 批1 蒸馏产物入库（+2）", round1 === before1 + 2, "before=" + before1 + " after=" + round1);
      // v0.5：原料 4 行（批1 2 行 + 已 done 的），全部标 done
      check("resume: 批1 原料行标记 done（无 pending 残留）", marks1.length >= 2 && marks1.every(t => t.status === "done"), JSON.stringify(marks1).slice(0, 200));
      check("resume: 批1 原料无 pending 残留", !marks1.some(t => t.status === "pending"), "pending 数=" + marks1.filter(t => t.status === "pending").length);

      // 批 2：同会话迟到条目（内容不同，不触发导入去重）
      const batch2 = [
        { sessionId: "sess-rs-1", kind: "summary-card", user: "RS会话迟到条目甲", assistant: "补充说明甲。", url: "https://chat.deepseek.com/a/sess-rs-1" },
        { sessionId: "sess-rs-1", kind: "summary-card", user: "RS会话迟到条目乙", assistant: "补充说明乙。", url: "https://chat.deepseek.com/a/sess-rs-1" }
      ];
      const i2 = await http("POST", C.base + "/memory/import", { token: tC, body: { items: batch2 } });
      check("resume: 批2（迟到）导入受理", i2.status === 200 && i2.json?.accepted === 2, i2.status + " " + i2.text.slice(0, 120));

      // 第 2 轮蒸馏：批 2 应被会话级跳过——蒸馏产物不新增（fake-dsh 不再被调）
      const before2 = countDistilled();
      const d2 = await http("POST", C.base + "/memory/distill", { token: tC });
      check("resume: 第 2 轮蒸馏受理 202", d2.status === 202, d2.status);
      await sleep(3000); // 给 runIfPending 留完成时间（跳过路径无 LLM，秒级）
      const after2 = countDistilled();
      check("resume: 迟到批次被跳过（产物不新增，不烧 LLM）", after2 === before2, "before=" + before2 + " after=" + after2);

      // 迟到条目也被标 distilled（状态机排空，不留永久 pending）——轮询等待排空完成
      let marks2 = [];
      for (let p = 0; p < 40; p++) {
        await sleep(500);
        const buf2 = openBufferDb(join(tmp, "buffer-C", "buffer.db"));
        try {
          marks2 = buf2 ? buf2.prepare("SELECT status FROM buffer WHERE session_id = 'sess-rs-1'").all() : [];
        } finally { if (buf2) buf2.close(); }
        if (marks2.length >= 4 && marks2.every(t => t.status === "done")) break;   // 全 done 即排空
      }
      // v0.5：迟到条目也排空（status=done，不留永久 pending）
      check("resume: 批2（迟到）行也标 done", marks2.length >= 4 && marks2.every(t => t.status === "done"), "rows=" + marks2.length + " " + JSON.stringify(marks2));
      await sleep(8000);
      {
        const buf2b = openBufferDb(join(tmp, "buffer-C", "buffer.db"));
        try { console.log("[dbg-late] 8 秒后:", JSON.stringify(buf2b.prepare("SELECT status FROM buffer WHERE session_id='sess-rs-1'").all())); } finally { if (buf2b) buf2b.close(); }
      }
    }

    // [dbg-logsC] 打印 C 实例蒸馏日志尾部（定位批2 排空时序）
    try {
      const logC = join(tmp, "logs-C", "bridge.log");
      if (existsSync(logC)) {
        const tail = readFileSync(logC, "utf8").trim().split("\n").filter(l => /distill|resume|skip/.test(l));
        console.log("[dbg-logsC] C 实例蒸馏日志尾部:");
        tail.slice(-10).forEach(l => console.log("   ", l.slice(0, 220)));
      } else console.log("[dbg-logsC] logs-C/bridge.log 不存在");
    } catch (e) { console.log("[dbg-logsC] 读取失败", String(e).slice(0, 100)); }
    await stopBridge(C);

    // node:sqlite 直查副本：embedded 写链路真的落了 SQLite
    {
      const db = new DatabaseSync(join(embedDir, "memory.db"));
      const row = db.prepare("SELECT id, type, title, source FROM memories WHERE id = ?").get(savedId);
      check("副本库直查到 embedded 写入行", row && row.source === "smoke" && row.title.includes(TAG), JSON.stringify(row));
      // v0.5：原料不落 mneme——副本库应查无此行，且 buffer.db 有对应行
      const convRow = db.prepare("SELECT id FROM memories WHERE type = 'history' AND source = 'edge-extension' AND content LIKE ?").get("%embedded 冒烟用户提问%");
      check("副本库无 conversation 原料行（v0.5 架构）", !convRow, JSON.stringify(convRow));
      const buf3 = openBufferDb(join(tmp, "buffer-C", "buffer.db"));   // v0.5.1 实例隔离
      const bufRow = buf3 ? buf3.prepare("SELECT id, status FROM buffer WHERE user LIKE '%embedded 冒烟用户提问%'").get() : null;
      if (buf3) buf3.close();
      check("缓冲库直查到 conversation 原料行", Boolean(bufRow), JSON.stringify(bufRow));
      db.close();
    }

    // ============================ 生产库零接触校验 ================================
    section = "safety";
    console.log("\n-- 生产库零接触校验 --");
    const prodStatAfter = await stat(join("F:/DeepSeek/.dsh/memory", "memory.db"));
    check("生产库 size 未变", prodStatBefore.size === prodStatAfter.size, `${prodStatBefore.size} → ${prodStatAfter.size}`);
    check("生产库 mtime 未变", prodStatBefore.mtimeMs === prodStatAfter.mtimeMs, `${prodStatBefore.mtimeMs} → ${prodStatAfter.mtimeMs}`);

    // 清理临时目录（失败也无所谓：系统临时目录会定期清）
    const allOk = results.length > 0 && results.every(r2 => r2.ok);
    if (allOk) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    else console.log("[dbg] 保留 tmp 供调试:", tmp);
  } finally {
    fake.server.close();
    for (const c of children.splice(0)) { try { c.kill(); } catch { /* noop */ } }
  }

  if (!summarize()) process.exit(1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  summarize();
  process.exit(1);
});