// distill 链路专项测试：副本库 + 假 dsh 命令，验证 pending→distill→入库→标记 全流程
import { mkdtemp, copyFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const B = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tmp = await mkdtemp(join(tmpdir(), "mneme-distill-test-"));
const dataDir = join(tmp, "data");
await mkdir(dataDir, { recursive: true });
for (const s of ["", "-wal", "-shm"]) {
  try { await copyFile("<dataDir>/memory.db" + s, join(dataDir, "memory.db" + s)); }
  catch (e) { if (s === "") throw e; }
}
// 预置两条 pending 对话行（模拟扩展上报的产物）
const MNEME = "";
const { createStore } = await import(pathToFileURL(MNEME + "/store.js").href);
const store = createStore(join(dataDir, "memory.db"));
const ins = store.db.prepare("INSERT INTO memories (id,type,title,content,tags,importance,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
const now = new Date().toISOString();
ins.run("test-conv-1", "history", "网页对话:记住浅色", "用户: 记住我偏好浅色主题\n助手: 好的已记住\nurl: https://x/s/abc", '["web","edge","pending-distill"]', 3, "edge-extension", now, now);
ins.run("test-conv-2", "history", "网页对话:子串匹配坑", "用户: thought 不含 think 怎么办\n助手: 用词表 thought|think\nurl: https://x/s/abc", '["web","edge","pending-distill"]', 3, "edge-extension", now, now);
store.db.close();
// 起 bridge（embedded，distill.dshCommand 指向假 dsh）
const { spawn } = await import("node:child_process");
const cfgPath = join(tmp, "config.json");
await writeFile(cfgPath, JSON.stringify({
  bridgeToken: "dt-" + Date.now(),
  port: 18760, host: "127.0.0.1",
  mneme: { mode: "embedded", libPath: MNEME, dataDir: dataDir.replace(/\\/g, "/") },
  distill: { enabled: true, dshWebPort: 19999, probeIntervalMs: 100000 }
}, null, 2), "utf8");
// 注意：dshCommand 只支持单命令，假 dsh 需要带参数——distiller.spawn 目前不支持 args 数组
// （本次测试目的：验证「探测跳变→调 distiller→解析→入库→标记」链路；headless 调用失败
//  也会被记为 failedGroups，我们用 distill-test 直接 import distiller 驱动，绕过 dshCommand 限制）
console.log("distill-test: 直接 import distiller 驱动");
const { createStore: cs } = await import(pathToFileURL(MNEME + "/store.js").href);
const { createService } = await import(pathToFileURL(MNEME + "/service.js").href);
const { createMirror } = await import(pathToFileURL(MNEME + "/mirror.js").href);
const { createSettings } = await import(pathToFileURL(MNEME + "/settings.js").href);
const store2 = cs(join(dataDir, "memory.db"));
createSettings(store2.db);
const mirror = createMirror(dataDir, "zh");
const service = createService({ store: store2, mirror, config: { language: "zh" }, logger: console });
const backend = { backend: "embedded", save: async (memory) => {
  const r = service.saveWithDedupe(memory);
  return { status: r.action === "created" ? 201 : 200, json: r };
} };
const { createPendingStore } = await import(pathToFileURL(join(B, "lib", "pending.js").replace(/^\//, "")).href);
const pending = createPendingStore(store2);
const loaded = pending.load(60);
console.log("pending 加载:", loaded.length, "条");
if (loaded.length < 2) { console.error("FAIL: pending 不足 2 条，实际 " + loaded.length); process.exit(1); }
if (!loaded.some(e => e.id === "test-conv-1") || !loaded.some(e => e.id === "test-conv-2")) {
  console.error("FAIL: 预置 pending 行缺失"); process.exit(1);
}
const { createDistiller } = await import(pathToFileURL(join(B, "lib", "distiller.js").replace(/^\//, "")).href);
// 直接注入假 runHeadless（不真调 dsh）
const distiller = createDistiller({ config: { distill: {} }, backend, loadPending: () => pending.load(60), markDistilled: (ids) => pending.mark(ids) });
// monkey-patch：替换 runHeadless —— distiller 内部函数不可 patch，改走子进程：用 node 跑 fake-dsh 脚本
// （distiller 的 dshCommand 支持 PATH 命令；这里用 process.execPath + 无法传参，改为包装 cmd）
console.log("（用 fake-dsh 包装验证：把 distiller 的 spawn 目标换成 node fake-dsh.mjs）");
// 简化：直接构造一个 dsh.cmd 包装（Windows PATH 语义）
const { writeFileSync } = await import("node:fs");
const fakeDsh = join(B, "scripts", "fake-dsh.mjs");
const fakeCmd = join(tmp, "fake-dsh.cmd");
writeFileSync(fakeCmd, "@echo off\nnode " + fakeDsh.replace(/\\/g, "\\") + "\n");
// 重新 createDistiller，config.distill.dshCommand 指向 fakeCmd
const distiller2 = createDistiller({ config: { distill: { dshCommand: process.execPath, dshArgs: [fakeDsh], headlessTimeoutMs: 30000 } }, backend, loadPending: () => pending.load(60), markDistilled: (ids) => pending.mark(ids) });
const summary = await distiller2.runIfPending();
console.log("蒸馏结果:", JSON.stringify(summary));
// 验证：2 条入库 + 原始行被标记
const after = pending.load(60);
console.log("蒸馏后 pending:", after.length, "条（期望 0）");
const saved1 = store2.db.prepare("SELECT COUNT(*) n FROM memories WHERE source='dsh-distiller'").get();
console.log("入库蒸馏条目:", saved1.n, "（期望 2）");
const marked = store2.db.prepare("SELECT tags FROM memories WHERE id='test-conv-1'").get();
console.log("原始行标记:", marked.tags.includes("distilled") ? "✓" : "✗");
const pass = after.length === 0 && saved1.n >= 2 && marked.tags.includes("distilled");
console.log(pass ? "DISTILL-TEST PASS" : "DISTILL-TEST FAIL");
process.exit(pass ? 0 : 1);
