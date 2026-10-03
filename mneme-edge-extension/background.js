// mneme bridge 扩展 —— 后台 service worker：全扩展唯一的网络出口。
// v0.2：新增 getContext（组合检索：画像/规则/高价值/相关），老 bridge 自动回退
// search/recent。重试队列（alarms）与去重逻辑不变。
'use strict';

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8760',
  token: '',
  injectEnabled: true,
  injectMode: 'implicit',   // implicit = 请求级隐式注入（推荐）；visible = 输入框可见块（旧行为）
  collectEnabled: true,
  debug: false
};

const QUEUE_KEY = 'mnemeRetryQueue';
const DEDUP_KEY = 'mnemeDedup';
const DELAYS_MIN = [1, 2, 4, 8, 16];
// context 检索缓存：同 query 60s 内复用，减少 bridge 压力
const CTX_TTL_MS = 60000;
let ctxCache = { key: '', at: 0, data: null };

function log() {
  const args = ['[mneme/bg]'].concat([].slice.call(arguments));
  console.log.apply(console, args);
}

function cfg() { return chrome.storage.local.get(DEFAULTS); }

async function bridge(path, opts) {
  const c = await cfg();
  const headers = { 'Content-Type': 'application/json' };
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  const url = c.bridgeUrl.replace(/\/+$/, '') + path;
  const res = await fetch(url, Object.assign({ headers }, opts || {}));
  if (!res.ok) throw new Error('bridge ' + res.status + ' ' + url);
  return res.json();
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- 重试队列（alarms 驱动；MV3 SW 会休眠，不能用 setTimeout） ----
async function readQueue() {
  const o = await chrome.storage.local.get({ [QUEUE_KEY]: [] });
  return o[QUEUE_KEY] || [];
}
async function writeQueue(q) { await chrome.storage.local.set({ [QUEUE_KEY]: q }); }

async function enqueue(item) {
  item.tries = (item.tries || 0) + 1;
  if (item.tries > 5) { log('放弃（重试超 5 次）', item.key); return; }
  const q = await readQueue();
  q.push(item);
  await writeQueue(q);
  await scheduleRetry();
}

async function scheduleRetry() {
  const q = await readQueue();
  const next = q.length ? q[0] : null;
  if (!next) return;
  const minutes = DELAYS_MIN[Math.min((next.tries || 1) - 1, DELAYS_MIN.length - 1)];
  chrome.alarms.create('mneme-retry', { delayInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mneme-retry') return;
  const q = await readQueue();
  if (!q.length) return;
  const item = q.shift();
  await writeQueue(q);
  try {
    await bridge(item.path, { method: 'POST', body: item.body });
    log('重试成功', item.key);
  } catch (e) {
    log('重试失败', item.key, String(e));
    await enqueue(item);
    return;
  }
  if (q.length) await scheduleRetry();
});

// ---- 检索：v0.2 组合检索（画像+规则+高价值+相关），老 bridge 回退 search/recent ----
async function getContext(text) {
  const key = String(text || '').slice(0, 120);
  if (ctxCache.data && ctxCache.key === key && (Date.now() - ctxCache.at) < CTX_TTL_MS) {
    return ctxCache.data;
  }
  let data = null;
  try {
    const r = await bridge('/memory/context?q=' + encodeURIComponent(key) + '&topK=6');
    data = {
      profile: String(r.profile || ''),
      rules: Array.isArray(r.rules) ? r.rules : [],
      pins: Array.isArray(r.pins) ? r.pins : [],
      related: Array.isArray(r.related) ? r.related : []
    };
  } catch (e) {
    // 老版 bridge 没有 /memory/context（404）或 bridge 未起：退回 v0.1 路径
    log('context 回退:', String(e.message || e));
    let items = [];
    try {
      const r = await bridge('/memory/search', {
        method: 'POST',
        body: JSON.stringify({ q: key, mode: 'auto', topK: 6 })
      });
      items = (r && r.items) || [];
    } catch (e2) { log('search 失败:', String(e2)); }
    if (!items.length) {
      try { const r = await bridge('/memory/recent?limit=6'); items = (r && r.items) || []; }
      catch (e2) { log('recent 失败:', String(e2)); }
    }
    data = { profile: '', rules: [], pins: [], related: items };
  }
  ctxCache = { key, at: Date.now(), data };
  return data;
}

// ---- 对话入库：去重 + LRU 200 + 失败入队 ----
async function saveConversation(msg, sendResponse) {
  const c = await cfg();
  if (!c.collectEnabled) { sendResponse({ ok: false, skipped: true }); return; }
  const key = await sha256((msg.user || '') + '\n' + (msg.assistant || ''));
  const d = await chrome.storage.local.get({ [DEDUP_KEY]: {} });
  if (d[DEDUP_KEY][key]) { sendResponse({ ok: true, deduped: true }); return; }
  const body = JSON.stringify({
    user: msg.user, assistant: msg.assistant,
    url: msg.url || null, sessionId: msg.sessionId || null
  });
  try {
    await bridge('/memory/conversation', { method: 'POST', body });
  } catch (e) {
    log('写入失败，入重试队列:', String(e));
    await enqueue({ path: '/memory/conversation', body, key, ts: Date.now() });
    sendResponse({ ok: false, queued: true });
    return;
  }
  const d2 = await chrome.storage.local.get({ [DEDUP_KEY]: {} });
  d2[DEDUP_KEY][key] = Date.now();
  const keys = Object.keys(d2[DEDUP_KEY]).sort((a, b) => d2[DEDUP_KEY][a] - d2[DEDUP_KEY][b]);
  while (keys.length > 200) delete d2[DEDUP_KEY][keys.shift()];
  await chrome.storage.local.set({ [DEDUP_KEY]: d2[DEDUP_KEY] });
  sendResponse({ ok: true });
}

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'getContext') {
        sendResponse({ ok: true, ctx: await getContext(msg.text) });
      } else if (msg.type === 'getMemory') {
        // v0.1 兼容消息：映射到 context 的 related 字段
        const ctx = await getContext(msg.text);
        sendResponse({ ok: true, items: ctx.related });
      } else if (msg.type === 'saveConversation') {
        await saveConversation(msg, sendResponse);
      } else if (msg.type === 'ping') {
        try { const r = await bridge('/health'); sendResponse({ ok: true, r }); }
        catch (e) { sendResponse({ ok: false, error: String(e) }); }
      } else if (msg.type === 'getList') {
        // v0.3.18（面板增强②）：按类型/分组列出记忆（GET /memory/list?type=X|types=A,B&limit=N）
        // 验证：面板「记忆库」分组标签切换时列表内容随之变化。
        try {
          const lim = Math.min(Math.max(parseInt(msg.limit, 10) || 50, 1), 200);
          const qs = [];
          // v0.3.23：记忆类型走 memType（此前用 msg.type 会被消息类型字段覆盖 → 请求变成 {type:'preference'}）
          const memType = msg.memType || msg.memtype || null;
          if (memType) qs.push('type=' + encodeURIComponent(memType));
          if (msg.types) qs.push('types=' + encodeURIComponent(msg.types));
          qs.push('limit=' + lim);
          const r = await bridge('/memory/list?' + qs.join('&'));
          sendResponse({ ok: true, items: (r && r.items) || [], total: (r && r.total) || 0 });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'getImportedIds') {
        // v0.5.17：已入库会话集合（导入列表隐藏用）
        try {
          const res = await fetch((await cfg()).bridgeUrl.replace(/\/+$/, '') + '/memory/imported-ids', { headers: { Authorization: 'Bearer ' + (await cfg()).token } });
          const j = await res.json();
          sendResponse({ ok: res.ok, ids: (j && j.ids) || [] });
        } catch (e) { sendResponse({ ok: false, ids: [] }); }
      } else if (msg.type === 'deletePending') {
        // v0.5.13：删除缓冲条目（DELETE /memory/pending?id=）
        try {
          const res = await fetch((await cfg()).bridgeUrl.replace(/\/+$/, '') + '/memory/pending?id=' + encodeURIComponent(msg.id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + (await cfg()).token }
          });
          sendResponse({ ok: res.ok });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'getPending') {
        // v0.4.4：缓冲队列查看（GET /memory/pending?limit=N）
        try {
          const lim = Math.min(Math.max(parseInt(msg.limit, 10) || 100, 1), 500);
          const r = await bridge('/memory/pending?limit=' + lim);
          sendResponse({ ok: true, items: (r && r.items) || [], total: (r && r.total) || 0 });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'getRecent') {
        // v0.2.9 悬浮面板：最近记忆列表（GET /memory/recent?limit=10）
        // 验证：面板「最近记忆/刷新」或 curl http://127.0.0.1:8760/memory/recent?limit=10
        try {
          const lim = Math.min(Math.max(parseInt(msg.limit, 10) || 10, 1), 50);
          const r = await bridge('/memory/recent?limit=' + lim);
          sendResponse({ ok: true, items: (r && r.items) || [] });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'triggerDistill') {
        // v0.2.9 悬浮面板：立即蒸馏（桩位）。bridge 侧蒸馏触发路由由 Lead 并行添加；
        // bridge 无此路由时这里会 404 → ok:false，面板只提示不重试不入队（仅提示已发送，不强报结果）。
        // 验证：面板点「立即蒸馏」→ bridge 日志应出现蒸馏动作或 404 记录（桩位期）。
        try {
          await bridge('/memory/distill', { method: 'POST', body: '{}' });
          sendResponse({ ok: true, sent: true });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'importBatch') {
        // v0.3.1 旧会话导入（task-6）：单批写入（items ≤200，由 injected 侧切好）。
        // 验证：面板导入流程跑通时 bridge 日志应出现 POST /memory/import。
        try {
          const r = await bridge('/memory/import', { method: 'POST', body: msg.body });
          sendResponse({ ok: true, r });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'importEstimate') {
        // v0.3.14（task-8 L3）：导入预估 → POST /memory/import/estimate
        // bridge-dev 并行实现；无此路由 404 → ok:false（content 降级为本地字数估算）
        try {
          const r = await bridge('/memory/import/estimate', { method: 'POST', body: msg.body });
          sendResponse({ ok: true, r });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      } else if (msg.type === 'openOptions') {
        // v0.2.9 悬浮面板「打开设置页」：content script 没有 openOptionsPage 权限，必须走 background。
        try {
          chrome.runtime.openOptionsPage(() => { void chrome.runtime.lastError; sendResponse({ ok: true }); });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      } else {
        sendResponse({ ok: false, error: 'unknown-type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步 sendResponse
});

log('service worker 已启动 (v0.2)');
