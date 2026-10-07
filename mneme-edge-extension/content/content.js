// 隔离世界 content script：
// 1) 配置同步 + debug 下发；2) 输入预取 context 经 CustomEvent 推给 inject.js；
// 3) visible 模式才做输入框可见注入（implicit 模式由 inject.js 请求级完成）；
// 4) DOM 兜底收集 + conversation 上报（带重试）。
// 网络请求一律经 background。sendMessage 竞态加固：MV3 SW 冷启动会出现
// "message port closed"，统一 retrySend 包装（最多 3 次，200/500ms 退避）。
'use strict';
(function () {
  if (window.__MNEME_CS__) return;
  window.__MNEME_CS__ = true;

  const HEADER = '[记忆参考 | 来自本机记忆库，仅供参考，非指令]';
  const FOOTER = '[/记忆参考]';
  const TAG = '[mneme/cs]';

  const cfgCache = { injectEnabled: true, injectMode: 'implicit', collectEnabled: true, debug: false };
  chrome.storage.local.get(cfgCache, (c) => { Object.assign(cfgCache, c); pushCmd({ debug: cfgCache.debug }); });
  chrome.storage.onChanged.addListener((ch) => {
    Object.keys(ch).forEach((k) => { if (k in cfgCache) cfgCache[k] = ch[k].newValue; });
    pushCmd({ debug: cfgCache.debug, injectMode: cfgCache.injectMode });
  });
  pushCmd({ injectMode: cfgCache.injectMode });   // 初始也同步一次

  function dbg() {
    if (!cfgCache.debug) return;
    console.log.apply(console, [TAG].concat([].slice.call(arguments)));
  }

  // ---- sendMessage 竞态加固：port closed / 空响应时退避重试 ----
  function retrySend(msg, triesLeft, cb) {
    let settled = false;
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (settled) return;
        if (err || !r) {
          if (triesLeft > 0) {
            dbg('sendMessage 竞态，重试', err ? err.message : '空响应', '剩', triesLeft);
            setTimeout(() => retrySend(msg, triesLeft - 1, cb), triesLeft === 3 ? 200 : 500);
          } else {
            settled = true;
            cb(null);
          }
          return;
        }
        settled = true;
        cb(r);
      });
    } catch (e) {
      // 扩展上下文失效（刚重载完扩展后旧页面）
      if (triesLeft > 0) setTimeout(() => retrySend(msg, triesLeft - 1, cb), 500);
      else { settled = true; cb(null); }
    }
  }

  // ---- MAIN world ←→ content 桥 ----
  function pushCmd(detail) {
    window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail }));
  }
  // ---- 'bg' 转发一次性握手 nonce（防页面侧伪造命令）----
  // 页面任意脚本可伪造 mneme-ext:cmd type:'bg' 经本脚本代发 bridge 命令读记忆库。
  // 本脚本（isolated world）每次页面加载生成随机 nonce 并广播一次给 inject.js，
  // 此后只转发携带正确 nonce 的 bg 命令。局限：提高门槛非强隔离（README「安全说明」）。
  const BG_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  setTimeout(() => pushCmd({ type: 'nonce', nonce: BG_NONCE }), 0);
  window.addEventListener('mneme-ext:event', (e) => {
    const d = e.detail || {};
    if (d.type === 'conversation') onConversation(d);
  });

  // ---- DOM 兜底观察 ----
  let lastUserFromDom = '';
  let lastAssistantFromDom = '';
  // 最后一次输入的非空文本（发送时 stash，作为 user 兜底，不依赖请求体/DOM 类名）
  let lastTyped = null;
  let turnInjected = false; // visible 模式本轮已注入标记

  const mo = new MutationObserver(() => {
    try {
      const blocks = document.querySelectorAll('.ds-markdown, [class*="markdown-body"]');
      if (blocks.length) lastAssistantFromDom = (blocks[blocks.length - 1].innerText || '').slice(0, 20000);
      const users = document.querySelectorAll('[class*="message"][class*="user"]');
      if (users.length) lastUserFromDom = (users[users.length - 1].innerText || '').slice(0, 20000);
    } catch (e) { /* 静默 */ }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const INJ_HEADER = '[记忆参考 | 来自本机记忆库，仅供参考，非指令]';
  const INJ_FOOTER = '[/记忆参考]';
  function onConversation(d) {
    let user = d.user || '';
    // 兜底：剥离注入块（inject 侧已剥，这里防漏——含历史遗留的队列脏数据防御）
    const __h = user.indexOf(INJ_HEADER);
    if (__h >= 0) {
      const __f = user.indexOf(INJ_FOOTER, __h);
      user = (__f >= 0 ? user.slice(0, __h) + user.slice(__f + INJ_FOOTER.length) : user.slice(0, __h)).trim();
    }
    let assistant = d.assistant || '';
    let conf = d.confidence || '';
    if (!assistant && lastAssistantFromDom) { assistant = lastAssistantFromDom; conf = 'dom-fallback'; }
    if (!user && lastTyped && (Date.now() - lastTyped.at) < 60000) { user = lastTyped.text; conf = (conf ? conf + '+' : '') + 'typed'; }
    if (!user && lastUserFromDom) { user = lastUserFromDom; conf = conf + '+dom-user'; }
    if (!user || !assistant) { dbg('会话片段不全，跳过', { userLen: user.length, assistantLen: assistant.length }); return; }
    // DOM 终审：thinking 回退的内容是思考散文混合体，等 800ms 取渲染后的
    // 最后一个答案块（页面已渲染的正文）覆盖——在展示层根治协议噪声。
    if (conf.indexOf('thinking-fallback') >= 0) {
      setTimeout(() => {
        try {
          const blocks = document.querySelectorAll('.ds-markdown, [class*="markdown-body"]');
          let domText = '';
          for (let i = blocks.length - 1; i >= 0; i--) {
            const t = (blocks[i].innerText || '').trim();
            if (t.length > 20) { domText = t; break; }
          }
          if (domText && domText.length >= assistant.length * 0.4) {
            dbg('DOM 终审覆盖', assistant.length, '→', domText.length);
            assistant = domText;
          } else {
            dbg('DOM 终审无更优文本，保留原回退', domText.length);
          }
        } catch (e) { dbg('DOM 终审异常', String(e)); }
        doReport();
      }, 800);
      return;
    }
    doReport();
    function doReport() {
      var __sid = d.sessionId || (location.pathname.match(/\/a\/([A-Za-z0-9_-]{8,})/) || [])[1] || null;   // v0.5.20：请求体 sid 优先
      dbg('上报对话', { userLen: user.length, assistantLen: assistant.length, conf, sid: __sid ? __sid.slice(0, 8) : null });
      retrySend({ type: 'saveConversation', user, assistant, url: location.href, sessionId: __sid }, 3, (r) => dbg('上报结果', r));
      turnInjected = false;
    }
  }

  // ---- 输入框探测（visible 模式用） ----
  function isVisible(el) { return !!(el && el.offsetWidth > 30 && el.offsetHeight > 10); }
  function likelyChatInput(el) {
    if (el.getAttribute('placeholder')) return true;
    return !!el.closest('form') || el.getBoundingClientRect().bottom > window.innerHeight * 0.5;
  }
  function findInput() {
    const a = document.querySelector('#chat-input');
    if (isVisible(a)) return a;
    const tas = document.querySelectorAll('textarea[data-testid], textarea');
    for (const t of tas) if (isVisible(t) && likelyChatInput(t)) return t;
    const ces = document.querySelectorAll('[contenteditable="true"]');
    for (const c of ces) if (isVisible(c) && likelyChatInput(c)) return c;
    return null;
  }
  function readValue(el) { return el.tagName === 'TEXTAREA' ? el.value : (el.innerText || ''); }
  function writeValue(el, v) {
    if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // visible 模式用 innerText 直赋（execCommand 插入在该输入框不可靠）
      el.innerText = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  // ---- 输入预取：拉 context 并推给 inject.js（implicit 注入的数据源） ----
  let prefetchTimer = null;
  let prefetching = false;
  function prefetchNow(text) {
    if (prefetching) return;
    prefetching = true;
    retrySend({ type: 'getContext', text: String(text || '').slice(0, 120) }, 3, (r) => {
      prefetching = false;
      if (!r || !r.ok) { dbg('预取失败', r); return; }
      pushCmd({ type: 'ctx', key: String(text || '').slice(0, 120), ctx: r.ctx });
      const n = (r.ctx.related || []).length;
      dbg('预取 context 完成 related=' + n + (r.ctx.profile ? ' 有画像' : ''));
    });
  }
  document.addEventListener('input', (e) => {
    const input = findInput();
    if (e.target !== input) return;
    clearTimeout(prefetchTimer);
    const t = readValue(input);
    if (!t.trim()) return; // 空输入不预取（v0.2.1：消除 related=0 日志噪声）
    lastTyped = { text: t.trim(), at: Date.now() }; // v0.2.2：随输入 stash
    prefetchTimer = setTimeout(() => prefetchNow(t), 400);
  }, true);

  // 发送前即时预取——按 Enter 或点发送按钮的瞬间，用输入框**最终全文**
  // 立即拉 context（不等 400ms debounce），让「打完字马上回车」的场景也能带着
  // 与第一句话匹配的 related 注入。预取异步进行，赶不上本轮就降级 globalOnly（不阻塞发送）。
  window.addEventListener('mneme-ext:cmd', (e) => {
    const d = e.detail || {};
    if (d.type === 'prefetch' && d.text) prefetchNow(d.text);
  });
  function immediatePrefetch() {
    try {
      const input = findInput();
      if (!input) return;
      const t = readValue(input);
      if (t && t.trim()) prefetchNow(t);
    } catch (e) { /* 预取失败不阻塞发送 */ }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    immediatePrefetch();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('button, div[role="button"]');
    if (!btn) return;
    immediatePrefetch();
  }, true);

  // ---- visible 模式：发送前插入可见记忆块（旧行为，可在设置切换） ----
  function buildVisibleBlock(ctx, skipGlobal) {
    if (!ctx) return '';
    const lines = [];
    const rel = (ctx.related || []).slice(0, 5).map((m) => '- ' + (m.title || '') + '：' + String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120));
    // skipGlobal=true（会话第 2+ 轮）只注 related——画像/偏好已在历史里
    if (!skipGlobal) {
      if (ctx.profile) lines.push('- 用户画像：' + ctx.profile.slice(0, 150));
      for (const r of (ctx.pins || []).slice(0, 3)) lines.push('- ' + (r.title || '') + '：' + String(r.content || '').slice(0, 120));
    }
    for (const l of rel) lines.push(l);
    if (!lines.length) return '';
    return HEADER + '\n' + lines.join('\n') + '\n' + FOOTER;
  }

  let visibleDoneSid = null;   // v0.5.34：本 URL 会话已做过 visible 注入的标记（内存态，无遗留问题）
  function currentUrlSid() {
    return (location.pathname.match(/\/a\/([A-Za-z0-9_-]{8,})/) || [])[1] || location.pathname + location.search;
  }
  function visibleIntercept(text, input, btn) {
    // visible 每轮发送都把块写进输入框 → DS 每轮 prompt 都带画像。
    // 门控：同一 URL 会话只写一次；切换会话（sid 变化）自动重置。0.5.33 的 sessionStorage
    // 有跨会话遗留问题（同 tab 换会话 800ms 轮询未清就被拦），改为内存 + sid 关联。
    const sid = currentUrlSid();
    // 每一轮都注入 related（本轮问话的相关记忆）；
    // 区别只在——首轮带「画像+偏好」全局段，后续轮只带 related（全局段已在历史里）。
    var skipGlobal = visibleDoneSid === sid;   // 同会话第 2+ 轮
    prefetchNow(text);
    // 用最近一次预取结果（bg 有 60s 缓存，此刻通常已就绪）
    retrySend({ type: 'getContext', text: String(text || '').slice(0, 120) }, 1, (r) => {
      const ctx = r && r.ok ? r.ctx : null;
      const block = buildVisibleBlock(ctx, skipGlobal);
      if (!block) { replaySend(input, btn); return; }
      writeValue(input, block + '\n\n' + text);
      turnInjected = true;
      if (!skipGlobal) visibleDoneSid = sid;   // v0.5.39：仅首轮登记（后续轮 skipGlobal）
      dbg('visible 注入完成（本会话首次，sid=' + visibleDoneSid.slice(0, 12) + '）');
      // 从首页发出第一句后 URL 会从 / 变成 /a/chat/s/<id>——同一场对话的延续。
      // 监听一次性迁移：URL 出现会话 id 且当前门控还是旧值时，把门控同步到新 sid，
      // 否则第 2 轮会被判成新会话再注一次。
      const oldSid = visibleDoneSid;
      const migrate = setInterval(() => {
        const cur = currentUrlSid();
        if (cur !== oldSid) { visibleDoneSid = cur; clearInterval(migrate); dbg('visible 门控 sid 迁移 → ' + cur.slice(0, 14)); }
      }, 500);
      setTimeout(() => clearInterval(migrate), 10000);   // 10 秒内没变就放弃（本就是会话页）
      setTimeout(() => replaySend(input, btn), 120);
    });
  }

  let replaying = false;
  function shouldBypass() {
    if (replaying || !cfgCache.injectEnabled || turnInjected) return true;
    return cfgCache.injectMode !== 'visible'; // implicit 模式不拦截输入框
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    if (shouldBypass()) return;
    const input = ev.target;
    if (!input || !(input.tagName === 'TEXTAREA' || input.isContentEditable)) return;
    const text = readValue(input);
    if (!text.trim() || text.indexOf(HEADER) === 0) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    visibleIntercept(text, input, null);
  }, true);

  document.addEventListener('click', (ev) => {
    if (shouldBypass()) return;
    const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) return;
    const input = findInput();
    if (!input) return;
    const inFooter = !!btn.closest('form') || btn.getBoundingClientRect().bottom > window.innerHeight * 0.5;
    if (!(btn.type === 'submit' || inFooter)) return;
    const text = readValue(input);
    if (!text.trim() || text.indexOf(HEADER) === 0) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    visibleIntercept(text, input, btn);
  }, true);

  function replaySend(input, btn) {
    replaying = true;
    try {
      if (btn) { btn.click(); return; }
      const btns = document.querySelectorAll('button[type="submit"], form button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.bottom > window.innerHeight * 0.5 && r.width > 0) { b.click(); return; }
      }
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } finally {
      setTimeout(() => { replaying = false; }, 300);
    }
  }

  // 把面板需要的工具暴露给第二个 IIFE（mountPanel）——
  // 两个 IIFE 是独立作用域，cfgCache/retrySend 原本面板拿不到（实测 ReferenceError）。
  window.__MNEME_CS_SHARED__ = {
    cfgCache: cfgCache,
    retrySend: retrySend,
    dbg: dbg
  };
  console.log('[mneme/cs] content script 版本 0.6.1 mode=' + cfgCache.injectMode); dbg('content script 就绪 (v0.2, mode=' + cfgCache.injectMode + ')');
})();

// ====================================================================
// 面板：唯一入口 = DS 左侧栏底部「记忆设置」菜单项
// （与「系统设置/帮助与反馈」并列）。无双模式。
// 点击侧栏项 → 居中弹层，模拟「系统设置」风格（遮罩+圆角卡片分组+iOS 开关）。
// 侧栏锚点：文本命中「系统设置/帮助与反馈」→ 向上爬 28~56px 的「行」级祖先
// （不猜 class，改版韧性高）；SPA 路由重建由 MutationObserver 防抖自动重挂。
// 网络一律 retrySend 经 background；Shadow DOM(closed) 隔离；挂载失败静默，
// 绝不影响注入/收集主链路。
// 作用域纪律：本 IIFE 整体 strict（文件级 'use strict'），
// try 块内声明的函数（plog/esc/renderList…）块外不可见——try 块外的唯一
// 日志用 cfgCache 守卫的 console.log（cfgCache 是 var，函数级提升可见）。
// 验证方法（人工）：
//   1) 重载扩展+刷新：左侧栏底部出现「记忆设置」项（hover 有底色反馈）
//   2) 点该项 → 居中弹层：状态/开关/最近记忆/立即蒸馏/设置 齐全；Esc、✕、点遮罩均可关闭
//   3) 状态区「bridge：连通 ✓」绿点；开关与 options 页双向同步
//   4) 切换会话/路由（侧栏重建）→ 侧栏项自动恢复；硬刷新后依然
//   5) Console 跑 __MNEME_SIDEBAR_PROBE__() → 打印侧栏行结构 + 设置弹层视觉 token
// ====================================================================
(function mountPanel() {
  var __shared = window.__MNEME_CS_SHARED__ || {};
  var cfgCache = __shared.cfgCache || { debug: false };
  var retrySend = __shared.retrySend || function (msg, tries, cb) { setTimeout(function () { cb(null); }, 0); };
  try {
    if (document.getElementById('mneme-panel-host')) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
      return;
    }


    // ---- host + closed shadow ----
    var host = document.createElement('div');
    host.id = 'mneme-panel-host';
    var hs = host.style;
    hs.position = 'fixed'; hs.left = '0'; hs.top = '0'; hs.width = '0'; hs.height = '0';
    hs.zIndex = '2147483646';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'closed' });

    // ---- 样式：弹层模拟「系统设置」（居中 dialog + 遮罩 + 分组卡片 + iOS 开关），深浅色自适应 ----
    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      // 字体栈/尺寸对齐 DS 设计系统（quote-cjk-patch/Inter 14px/22px）
      '* { box-sizing: border-box; font: var(--mn-font, 14px/22px -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif); }',
      // 视觉 token 集中管理——默认值=当前实现；
  
      '.dialog { --dhead: var(--mn-dialog-bg, #fff); position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);',
        'width: var(--mn-dialog-w, 760px); max-width: calc(100vw - 48px); max-height: var(--mn-dialog-maxh, 560px); height: var(--mn-dialog-h, 560px); overflow: hidden;', // v0.3.20：双栏布局下弹层不滚（滚动交给右侧 mpane），消除双滚动条
        'border-radius: var(--mn-dialog-radius, 12px); background: var(--mn-dialog-bg, #fff); color: var(--mn-dialog-color, #1f2329);',
        'border: var(--mn-dialog-border, 1px solid rgba(0,0,0,.08)); box-shadow: var(--mn-dialog-shadow, 0 16px 48px rgba(0,0,0,.28)); }',
      '.dialog .sec { padding: 0 20px 4px; }', // v0.3.17：去掉整块灰底（DS 是白底+浅灰卡片），此层仅作布局容器
      '.dialog .sec-title { font-size: 13px; font-weight: 500; color: var(--mn-dialog-color, #1f2329); opacity: .55; padding: 18px 0 8px; }', // v0.3.17：与卡片同左边距（此前 22px 使标题比行文字更右）
      '.dialog .card { background: var(--mn-card-bg, rgba(0,0,0,.035)); border: none; border-radius: 12px; padding: 0 16px; overflow: hidden; }',
      // DS 系统设置式双栏布局（左 nav 176px + 右内容滚动）
      '.mwrap { display: flex; min-height: 300px; max-height: 62vh; }',
      '.mnav { width: 168px; flex-shrink: 0; padding: 6px 10px 12px; display: flex; flex-direction: column; gap: 2px; }',
      '.mnav-item { display: flex; align-items: center; gap: 9px; padding: 9px 12px; border: none; background: transparent; color: inherit; font-size: 14px; text-align: left; border-radius: 10px; cursor: pointer; transition: background .15s; width: 100%; }',
      '.mnav-item:hover { background: rgba(127,127,127,.09); }',
      '.mnav-item.active { background: rgba(127,127,127,.13); font-weight: 500; }',
      '.mnav-item svg { flex-shrink: 0; opacity: .85; }',
      '.mpane { flex: 1; min-width: 0; overflow-y: auto; padding: 2px 20px 16px 4px; }',
      '.mpane::-webkit-scrollbar { width: 6px; }',
      '.mpane::-webkit-scrollbar-track { background: transparent; }',
      '.mpane::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); border-radius: 3px; }',
      '.mpane { scrollbar-width: thin; }',
      '.list { background: var(--mn-card-bg, rgba(0,0,0,.035)); border-radius: 12px; padding: 0 14px; }',
      '.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }',
      '.tab { padding: 5px 12px; border-radius: 4096px; border: 1px solid rgba(127,127,127,.28); background: transparent; color: inherit; font-size: 12px; cursor: pointer; transition: background .15s, border-color .15s; }',
      '.tab:hover { background: rgba(127,127,127,.1); }',
      '.tab.active { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }',
      '.list-head { font-size: 12px; opacity: .55; padding: 2px 0 8px; }',
      '.list .imp i { width: 5px; height: 5px; border-radius: 50%; background: rgba(127,127,127,.28); }',
      '.list .imp i.on { background: #4d6bfe; }',
      '.badge { font-size: 11px; padding: 1px 7px; border-radius: 4096px; background: rgba(127,127,127,.15); flex-shrink: 0; }',
      '.dialog .num { width: 92px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font-size: 13px; text-align: right; }',
      '.dialog .num:focus { outline: none; border-color: #4d6bfe; }',
      '.dialog .radio { position: relative; width: 18px; height: 18px; flex-shrink: 0; display: inline-block; }',
      '.dialog .radio input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }',
      '.dialog .radio i { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid rgba(127,127,127,.5); pointer-events: none; }',
      '.dialog .radio input:checked + i { border-color: #4d6bfe; border-width: 5px; }',
      '.dialog .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 54px; padding: 11px 0; border-bottom: 1px solid var(--mn-dialog-border, rgba(0,0,0,.06)); }',
      '.dialog .row:last-child { border-bottom: none; }',
      '.dialog .row-label { font-size: 14px; font-weight: 500; line-height: 20px; }',
      '.dialog .row-desc { font-size: 12px; opacity: .55; margin-top: 4px; line-height: 16px; }',
      '.dialog .row:hover { background: var(--mn-sec-hover, rgba(0,0,0,.04)); }', // v0.3.17：卡片内 hover，不再外扩
      '.dialog .row .arrow { font-size: 20px; opacity: .32; margin-left: 8px; line-height: 1; }',
      '.dialog .row-wrap { display: flex; flex-direction: column; }',
      '.dialog .row[style*="cursor"] { cursor: pointer; }',
            '.modal::-webkit-scrollbar { width: 6px; }',
      '.modal::-webkit-scrollbar-track { background: transparent; }',
      '.modal::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 3px; background-clip: padding-box; }',
      '.modal { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.35) transparent; overflow: hidden; }', // v0.3.17：弹层本体不滚（子列表滚），圆角完整
      // 导入弹层——弹层本体不滚，仅列表滚；列表 flex 撑满剩余高度
      '.modal { display: flex; flex-direction: column; max-height: 78vh; }',
      '.modal .mbody { display: flex; flex-direction: column; min-height: 0; flex: 1; }',
      '.im-list { flex: 1; min-height: 180px; max-height: 52vh; overflow-y: auto; border-radius: 12px; background: var(--mn-card-bg, rgba(0,0,0,.035)); padding: 0 14px; }',
      '.im-list::-webkit-scrollbar-track { background: transparent; }',
      '.im-list label.row { min-height: 46px; }',
      '.im-list label.row:hover { background: rgba(127,127,127,.06); }',
      '.im-list .muted { opacity: .5; }',
      '.im-kw { flex: 1 1 140px; min-width: 110px; }',
      '.im-filter { align-items: center; }',
      '.im-filter .btn { flex: 0 0 auto; }',
      '.im-filter .im-file { color: #4d6bfe; border-color: rgba(77,107,254,.4); }',
      '.im-status { margin: 6px 0 2px; font-size: 13px; }',
      '.im-sel { font-size: 12.5px; }',
      '.im-list::-webkit-scrollbar { width: 6px; }',
      '.im-list::-webkit-scrollbar-track { background: transparent; }',
      '.im-list::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); border-radius: 3px; }',
      '.im-list { scrollbar-width: thin; }',
'.dialog::-webkit-scrollbar { width: 6px; }',
      '.dialog::-webkit-scrollbar-track { background: transparent; }',
      '.dialog::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 3px; background-clip: padding-box; }',
      '.dialog { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.35) transparent; }',
      // 滚动条贴圆角会盖住右侧弧线——给 dialog 补圆角裁剪上下文
      '.dialog { will-change: scroll-position; }',
      '.dialog > * { border-radius: inherit; }',
      '.dialog .head { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; padding: 18px 24px 14px;',
        'background: var(--mn-dialog-bg, #fff); border-bottom: 1px solid var(--mn-dialog-border, rgba(0,0,0,.08));',
        'padding: var(--mn-head-pad, 14px 18px 10px); background: var(--dhead); z-index: 1; }',
      '.dialog .head b { font-size: var(--mn-head-fs, 15px); font-weight: var(--mn-head-fw, 600); }',
      '.dialog .head button { border: none; background: transparent; cursor: pointer; font-size: 15px; color: inherit; opacity: .7; }',
      '.dialog .head button:hover { opacity: 1; }',
      '.sec { padding: 0 var(--mn-sec-px, 18px) var(--mn-sec-pb, 16px); }',
      '.sec-title { display: flex; justify-content: space-between; align-items: center;',
        'font-size: var(--mn-sectitle-fs, 12px); opacity: var(--mn-sectitle-op, .55); margin: 10px 0 6px; }',
      '.card { border: var(--mn-card-border, 1px solid rgba(0,0,0,.08)); border-radius: var(--mn-card-radius, 10px); overflow: hidden; }',
      '.row { display: flex; justify-content: space-between; align-items: center; padding: var(--mn-row-pad, 10px 12px); cursor: default; }',
      '.row + .row { border-top: var(--mn-row-divider, 1px solid rgba(0,0,0,.06)); }',
      '.status { display: flex; align-items: center; gap: 8px; padding: var(--mn-status-pad, 12px 16px); border-radius: var(--mn-status-radius, 12px);',
        'background: var(--mn-status-bg, rgba(0,0,0,.05)); word-break: break-all; }',
      '.dot { width: 8px; height: 8px; border-radius: 50%; background: #b0b0b0; flex-shrink: 0; }',
      // DS 组件量级（xs 13/20；head 15/22）
      '.dialog .head b { font-size: var(--mn-head-fs, 15px); font-weight: var(--mn-head-fw, 600); line-height: var(--mn-head-lh, 22px); }',
      '.linklike { font-size: var(--mn-linklike-fs, 13px); }',
      // 开关：DS 复刻参数位（轨道/滑块/配色/过渡）
      '.tgl { position: relative; width: var(--mn-tgl-w, 34px); height: var(--mn-tgl-h, 20px); flex-shrink: 0; display: inline-block; }',
      '.tgl input { display: none; }',
      '.tgl i { position: absolute; inset: 0; border-radius: var(--mn-tgl-radius, 10px); background: var(--mn-tgl-off, rgba(127,127,127,.35)); transition: var(--mn-tgl-timing, background .15s); cursor: pointer; }',
      '.tgl i::after { content: ""; position: absolute; left: var(--mn-tgl-knob-off, 2px); top: 2px; width: var(--mn-tgl-knob, 16px); height: var(--mn-tgl-knob, 16px); border-radius: 50%;',
        'background: var(--mn-tgl-knob-bg, #fff); box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: var(--mn-tgl-knob-timing, transform .15s); }',
      '.tgl input:checked + i { background: var(--mn-tgl-on, #4f6ef7); }',
      '.tgl input:checked + i::after { transform: translateX(14px); }',
      // 按钮：DS 复刻参数位（主/次级填充、圆角、hover）
      '.btns { display: flex; gap: 10px; margin: 6px 0 2px; flex-wrap: wrap; }',
      '.btn { padding: var(--mn-btn-pad, 7px 14px); border-radius: var(--mn-btn-radius, 4096px); border: var(--mn-btn-border, 1px solid rgba(127,127,127,.4));',
        'background: var(--mn-btn-bg, transparent); color: inherit; cursor: pointer; font-size: var(--mn-btn-fs, 13px); line-height: var(--mn-btn-lh, 20px); transition: background .15s; }',
      '.btn:hover { background: var(--mn-btn-hover, rgba(127,127,127,.12)); }',
      '.btn.primary { background: var(--mn-btn-primary-bg, #4f6ef7); border-color: var(--mn-btn-primary-bg, #4f6ef7); color: var(--mn-btn-primary-color, #fff); }',
      '.btn.primary:hover { background: var(--mn-btn-primary-hover, #3f5ce0); }',
      '.linklike { border: none; background: transparent; color: inherit; opacity: .65; cursor: pointer; font-size: 12px; padding: 0; }',
      '.linklike:hover { opacity: 1; }',
      '.list .row-item { padding: 12px 14px; display: block; }',
      '.list .row-item + .row-item { border-top: 1px solid rgba(127,127,127,.12); }',
      '.list .row-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }',
      '.list .row-head b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; }',
      '.list .badge { font-size: 11px; padding: 1px 8px; border-radius: 4096px; background: rgba(77,107,254,.12); color: #4d6bfe; flex-shrink: 0; }',
      '.list .row-content { font-size: 12.5px; opacity: .6; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
      '.list .imp { display: flex; gap: 3px; margin-top: 6px; }',
      '.list .row-item label { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; min-width: 0; }',
      '.im-list .row-item { padding: 12px 14px; display: block; }',
      '.im-list .row-item + .row-item { border-top: 1px solid rgba(127,127,127,.12); }',
      '.im-list .row-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }',
      '.im-list .row-head b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; }',
      '.im-list .badge { font-size: 11px; padding: 1px 8px; border-radius: 4096px; background: rgba(77,107,254,.12); color: #4d6bfe; flex-shrink: 0; }',
      '.im-list .row-content { font-size: 12.5px; opacity: .6; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
      '.im-list .list-head { font-size: 12.5px; opacity: .55; }',
      '.im-list .hint { font-size: 12.5px; opacity: .5; }',
      '.q-del:hover { opacity: 1 !important; background: rgba(229,72,77,.15) !important; }',
      '.row-item .q-del { transition: opacity .15s; }',
      '.list input[type="checkbox"] { width: 16px; height: 16px; flex-shrink: 0; cursor: pointer; accent-color: #4d6bfe; }',
      '.list .row-item + .row-item { border-top: var(--mn-list-divider, 1px solid rgba(0,0,0,.06)); }',
      '.row-head { display: flex; gap: 6px; align-items: center; }',
      '.row-head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.badge { font-size: 10px; padding: 0 6px; border-radius: 8px; background: rgba(79,110,247,.16); flex-shrink: 0; }',
      '.row-content { color: inherit; opacity: .72; margin-top: 2px; word-break: break-word; }',
      '.hint { opacity: .6; padding: 8px 12px; }',
      '.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 72px;',
        'padding: 6px 14px; border-radius: 6px; background: rgba(0,0,0,.78); color: #fff; }',
      '.scrim { position: fixed; inset: 0; background: var(--mn-scrim, rgba(0,0,0,.35)); }',

      '@media (prefers-color-scheme: dark) {',
      '  .dialog { --dhead: #26292e; --mn-dialog-bg: #26292e; --mn-dialog-color: #e8eaed; --mn-dialog-border: 1px solid rgba(255,255,255,.14); }',
      '  .status { --mn-status-bg: rgba(255,255,255,.08); }',
      '  .card { --mn-card-border: 1px solid rgba(255,255,255,.1); } .list .row-item + .row-item { --mn-list-divider: 1px solid rgba(255,255,255,.1); }',
      '  .badge { background: rgba(79,110,247,.35); }',
      '}',
      '.modal { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);',
        'width: 400px; max-width: calc(100vw - 48px); max-height: 74vh; overflow-y: auto;',
        'border-radius: 12px; background: #fff; color: #1f2329;',
        'border: 1px solid rgba(0,0,0,.08); box-shadow: 0 16px 48px rgba(0,0,0,.28); }',
      '.modal .mhead { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center;',
        'padding: 14px 18px 10px; background: #fff; z-index: 1; }',
      '.modal .mhead b { font-size: 15px; font-weight: 600; }',
      '.modal .mhead button { border: none; background: transparent; cursor: pointer; font-size: 15px; color: inherit; opacity: .7; }',
      '.modal .msec { padding: 0 18px 16px; }',
      '.modal .msec p { margin: 6px 0; }',
      '.modal .muted { opacity: .65; }',
      '.bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.25); overflow: hidden; margin: 10px 0; }',
      '.bar > i { display: block; height: 100%; width: 0; background: #4f6ef7; transition: width .3s; }',
      '@media (prefers-color-scheme: dark) {',
        '.modal { background: #26292e; color: #e8eaed; border-color: rgba(255,255,255,.14); }',
        '.modal .mhead { background: #26292e; }',
      '}',
    ].join('\n');
    root.appendChild(style);

    // ---- DOM：遮罩 + 居中弹层 + toast ----
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.style.display = 'none';

    var panelBox = document.createElement('div');
    panelBox.className = 'dialog';
    panelBox.style.display = 'none';
    panelBox.innerHTML =
      '<div class="head"><b>记忆设置</b><button class="close" title="关闭 (Esc)">✕</button></div>' +
      '<div class="mwrap">' +
      '  <nav class="mnav">' +
      '    <button class="mnav-item active" data-pane="switches">' +
      '      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>' +
      '      <span>功能开关</span></button>' +
      '    <button class="mnav-item" data-pane="maintain">' +
      '      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="4"/></svg>' +
      '      <span>记忆维护</span></button>' +
      '    <button class="mnav-item" data-pane="library">' +
      '      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M10 4h8.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10"/></svg>' +
      '      <span>记忆库</span></button>' +
      '  </nav>' +
      '  <section class="mpane">' +
      // ---- 面板1：功能开关（含注入方式 + 更多设置）----
      '    <div class="pane" data-pane="switches">' +
      '      <div class="status" style="display:flex;align-items:center;gap:8px;"><span class="dot"></span><span class="status-text" style="flex:1;">bridge：检测中…</span><button class="linklike act-settings" title="Bridge 地址、Token 与高级选项">设置</button></div>' +
      '      <div class="sec-title">开关</div>' +
      '      <div class="card">' +
      '        <label class="row"><span class="row-wrap"><span class="row-label">记忆注入</span><span class="row-desc">发送消息时自动检索相关记忆</span></span><span class="tgl"><input type="checkbox" data-cfg="injectEnabled"><i></i></span></label>' +
      '        <label class="row"><span class="row-wrap"><span class="row-label">对话收集</span><span class="row-desc">聊天结束后自动存入记忆库，等待蒸馏</span></span><span class="tgl"><input type="checkbox" data-cfg="collectEnabled"><i></i></span></label>' +
      '      </div>' +
      '      <div class="sec-title">注入方式</div>' +
      '      <div class="card">' +
      '        <label class="row" style="cursor:pointer"><span class="row-wrap"><span class="row-label">隐式注入</span><span class="row-desc">记忆拼入请求体，输入框全程无感（推荐）</span></span><span class="radio"><input type="radio" name="mnInjectMode" value="implicit" data-cfg-radio="injectMode"><i></i></span></label>' +
      '        <label class="row" style="cursor:pointer"><span class="row-wrap"><span class="row-label">可见注入</span><span class="row-desc">把记忆块写进输入框，发送前可自行编辑</span></span><span class="radio"><input type="radio" name="mnInjectMode" value="visible" data-cfg-radio="injectMode"><i></i></span></label>' +
      '      </div>' +
      '      <div class="sec-title">更多设置</div>' +
      '      <div class="card">' +
      '        <label class="row"><span class="row-wrap"><span class="row-label">调试日志</span><span class="row-desc">Console 输出详细过程日志</span></span><span class="tgl"><input type="checkbox" data-cfg="debug"><i></i></span></label>' +
      '        <label class="row"><span class="row-wrap"><span class="row-label">最大导入会话数</span><span class="row-desc">单次勾选上限（1~200）</span></span><input class="num" type="text" data-cfg-num="maxImportSessions" placeholder="20"></label>' +
      '        <label class="row"><span class="row-wrap"><span class="row-label">导入总字符量闸</span><span class="row-desc">超出则拒绝导入（默认 50000）</span></span><input class="num" type="text" data-cfg-num="maxImportChars" placeholder="1500000"></label>' +
      '      </div>' +
      '    </div>' +
      // ---- 面板2：记忆维护 ----
      '    <div class="pane" data-pane="maintain" style="display:none">' +
      '      <div class="sec-title">记忆维护</div>' +
      '      <div class="card">' +
      '        <div class="row act-import" style="cursor:pointer"><span class="row-wrap"><span class="row-label">导入旧会话</span><span class="row-desc">勾选历史会话，蒸馏为长期记忆</span></span><span class="arrow">›</span></div>' +
      '      </div>' +
      '      <div class="sec-title" style="margin-top:16px;display:flex;align-items:center;"><span style="flex:1;">待蒸馏队列</span><button class="q-refresh-title" title="重新加载队列" style="border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:13px;padding:2px 8px;border-radius:4px;">⟳ 刷新</button></div>' +
      '      <div class="card" id="queue-card" style="padding:0;">' +
      '        <div class="hint" style="padding:16px;">加载中…</div>' +
      '      </div>' +
      '    </div>' +
      // ---- 面板3：记忆库 ----
      '    <div class="pane" data-pane="library" style="display:none">' +
      '      <div class="sec-title"><span>记忆库</span><button class="refresh linklike" title="刷新">↻ 刷新</button></div>' +
      '      <div class="tabs">' +
      '        <button class="tab active" data-tab="recent">最近</button>' +
      '        <button class="tab" data-tab="preference">偏好</button>' +
      '        <button class="tab" data-tab="constraint">约束</button>' +
      '        <button class="tab" data-tab="decision">决策</button>' +
      '        <button class="tab" data-tab="project">项目</button>' +
      '        <button class="tab" data-tab="pitfall">陷阱</button>' +
      '        <button class="tab" data-tab="all">全部</button>' +
      '      </div>' +
      '      <div class="card list"><div class="hint">加载中…</div></div>' +
      '    </div>' +
      '  </section>' +
      '</div>';

    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.display = 'none';

    root.appendChild(scrim);
    root.appendChild(panelBox);
    root.appendChild(toast);

    // ---- 弹层开关 ----
    // 桥必须在 mountPanel 挂载阶段就设置（放在 openPanel 体内——首次点击时
    // 桥尚不存在，if 守卫静默跳过 → 永远打不开）。函数声明提升保证此处引用 openPanel 合法。
    window.__MNEME_OPEN_PANEL__ = openPanel;
    var panelOpen = false;
    function openPanel() {
      if (panelOpen) return;
      panelOpen = true;
      scrim.style.display = '';
      panelBox.style.display = '';
      refreshStatus();
      loadRecent();
      plog('面板打开');
    }
    function closePanel() {
      if (!panelOpen) return;
      panelOpen = false;
      scrim.style.display = 'none';
      panelBox.style.display = 'none';
    }
    scrim.addEventListener('click', closePanel);
    root.querySelector('.close').addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (panelOpen && e.key === 'Escape') { e.stopPropagation(); closePanel(); }
    }, true);


    // ================= 旧会话导入 =================
    // 编排在 content；DeepSeek 历史拉取在 injected（MAIN world 页面态 fetch，
    // host_permissions 不含 chat.deepseek.com——任务书唯一豁免）；bridge 写入在
    // background（importBatch）。三方经 CustomEvent（detail 只放数据字段）串接。
    var imWrap = null;      // 导入弹层根（scrim+modal 包裹层，关闭=整棵移除）
    var importBusy = false; // 导入中（防重复开启、锁定关闭钮）

    function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    function imOpen(title) {
      // imWrap 是单例共享变量——重复调用 imOpen 会覆盖引用，导致旧弹层变成
      // 无法关闭的孤儿（X/遮罩全失效，无法再关）。先清旧的。
      if (imWrap) { try { imWrap.remove(); } catch (e) {} imWrap = null; }
      imWrap = document.createElement('div');
      imWrap.innerHTML =
        '<div class="scrim"></div>' +
        '<div class="modal">' +
        '  <div class="mhead"><b>' + title + '</b><button class="mclose" title="关闭">✕</button></div>' +
        '  <div class="msec mbody"></div>' +
        '</div>';
      // 用 self 捕获本次创建的弹层节点——避免稍后 imOpen 覆盖 imWrap 后，
      // 旧弹层的按钮错关到新弹层（或关不掉）。
      var self = imWrap;
      self.querySelector('.mclose').addEventListener('click', function () { importBusy = false; self.remove(); if (imWrap === self) imWrap = null; });
      self.querySelector('.scrim').addEventListener('click', function () { importBusy = false; self.remove(); if (imWrap === self) imWrap = null; });
      // capture+stopPropagation 会掐断 .mbody 内部所有按钮的 click（取消无响应根因）。
            // 改为仅拦截「冒泡到 mbody 自身」的点击（防透传到 scrim 关闭），内部按钮事件正常抵达。
            self.querySelector('.mbody').addEventListener('click', function (e) { if (e.target === this) e.stopPropagation(); }, false);
      root.appendChild(imWrap);
      return imWrap.querySelector('.mbody');
    }
    function imClose() {
      if (imWrap) { imWrap.remove(); imWrap = null; }
    }
    // 统一强制关闭入口——复位 importBusy（防"卡死"）+ 断开事件表 + 关弹层
    function closePanelImport() {
      importBusy = false;
      try { imHandlers.progress = null; imHandlers.done = null; imHandlers.summariesReady = null; } catch (e) {}
      try { imClose(); } catch (e) {}
    }

    // ================= 导入三层漏斗 =================
    // L1 勾选列表（本函数）→ L2 摘要卡（imStart）→ L3 预算确认（imConfirm）
    // 全选/反选/关键词过滤；默认全不勾；白名单上限 = maxImportSessions
    var funnelPreview = [];   // v0.4.2：预览样本（batches 留在 injected，不跨 world 传）
    var funnelChars = 0;
    var funnelCards = 0;


    // 缓冲队列查看器（待蒸馏条目 + 右下角「立即蒸馏」）
        function openImportFlow() {
      if (importBusy) { plog('导入进行中，忽略重复点击'); return; }
      importBusy = true;
      funnelChars = 0; funnelCards = 0;
      var mb = imOpen('导入旧会话 · 选择会话');
      mb.innerHTML =
        '<p class="muted im-status">正在拉取会话列表… <span class="im-lc">0</span> 个</p>' +
        '<div class="bar"><i></i></div>' +
        '<p class="muted im-hint100" style="margin:6px 0 0;">DeepSeek 接口仅返回最近 100 个会话；更早的会话请用下方按钮从导出文件载入。</p>' +
        '<button class="btn im-file" style="width:100%;margin:10px 0 4px;padding:9px 12px;color:#4d6bfe;border-color:rgba(77,107,254,.4);">📄 从导出文件导入</button>' +
        '<input class="im-fileinput" type="file" accept=".json,application/json" style="display:none">' +
        '<div class="im-filter" style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;">' +
        '  <input class="im-kw" type="text" placeholder="按标题过滤" style="flex:1;min-width:120px;padding:6px 10px;border-radius:var(--mn-btn-radius,8px);border:var(--mn-btn-border,1px solid rgba(127,127,127,.4));background:transparent;color:inherit;font-size:13px;">' +
        '  <select class="im-sort" style="padding:6px 8px;border-radius:var(--mn-btn-radius,8px);border:var(--mn-btn-border,1px solid rgba(127,127,127,.4));background:transparent;color:inherit;font-size:13px;">' +
        '    <option value="time">按修改时间</option>' +
        '    <option value="rounds">按轮次多少</option>' +
        '    <option value="title">按标题</option>' +
        '  </select>' +
        '  <button class="btn im-all">全选</button>' +
        '  <button class="btn im-none">反选</button>' +
        '</div>' +
        '<div class="im-list card" style="max-height:44vh;overflow-y:auto;"></div>' +
        '<p class="muted im-sel" style="margin-top:8px;">已选 0 / 0</p>' +
        '<div class="btns" style="margin-top:10px;">' +
        '  <button class="btn primary im-next" disabled title="按当前排序与勾选，本地生成摘要卡后预估预算">生成摘要卡</button>' +
        '  <button class="btn im-full" disabled title="重要会话用：携带完整对话蒸馏，成本按字符量计，远高于摘要卡">全量导入</button>' +
        '  <button class="btn im-cancel">取消</button>' +
        '</div>';
      mb.querySelector('.im-cancel').addEventListener('click', closePanelImport); // v0.3.16：统一强制关闭
      // 从 DeepSeek 官方导出 JSON 导入（在本地完成解析；覆盖接口拿不到的更早会话）
      (function bindFileImport() {
        var fileBtn = mb.querySelector('.im-file');
        var fileInput = mb.querySelector('.im-fileinput');
        if (!fileBtn || !fileInput) return;
        fileBtn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            try {
            var parsed = null;
            try { parsed = JSON.parse(String(fr.result || '')); } catch (e) { parsed = null; }
            if (!parsed) { showToast('文件解析失败（不是合法 JSON）'); return; }
            var list = extractSessionsFromExport(parsed);
            if (!list.length) { showToast('文件里没解析出会话'); return; }
            sessions = list;
            if (listEl) listEl.innerHTML = '';
            // 更新顶部状态行（与实际解析数保持一致）
            var stEl = mb.querySelector('.im-status');
            if (stEl) stEl.innerHTML = '已从导出文件载入 <span class="im-lc">' + mnFmt(list.length) + '</span> 个会话';
            var barWrap = mb.querySelector('.bar');
            if (barWrap) barWrap.style.display = 'none';
            var lc2 = mb.querySelector('.im-lc');
            if (lc2) lc2.textContent = mnFmt(list.length);
            var hintEl = mb.querySelector('.im-hint100');
            if (hintEl) hintEl.style.display = 'none';   // v0.3.25：已完成文件导入，100 条限制说明自动消失
            renderList();
            syncSel();
            showToast('已从文件载入 ' + mnFmt(list.length) + ' 个会话');
            plog('文件导入：解析出会话', list.length, '个');
            } catch (err) {
              showToast('文件导入出错：' + String((err && err.message) || err).slice(0, 60));
              console.warn('[mneme/panel] 文件导入异常:', err);
            }
          };
          fr.readAsText(f);
        });
      })();
      // 从 DS 导出 JSON 提取会话（结构容错：数组 / {data:[...]} / {chat_sessions:[...]}，字段名多形态）
      function extractSessionsFromExport(root) {
        // 按 DS 真实导出结构解析（DS 官方「导出对话」JSON 格式）：
        //   [ { id, title, inserted_at(ISO), updated_at(ISO), mapping: { nodeId: { id, parent, children, message: { model, inserted_at, fragments:[{type,content}] } } } } ]
        //   fragments.type ∈ REQUEST(用户) / THINK(思维链，必须丢弃) / RESPONSE(助手)
        // 只认 messages/chat_messages 顶层数组，其余结构解析不出（列表空、排序塌缩）。
        var sessions = null;
        if (Array.isArray(root)) sessions = root;
        else if (root && Array.isArray(root.conversations)) sessions = root.conversations;
        else if (root && Array.isArray(root.data)) sessions = root.data;
        if (!sessions || !sessions.length) return [];
        // 判定是否 DS 导出形态：元素含 mapping 或 fragments
        var probe = sessions[0] || {};
        var isDsExport = !!(probe.mapping || probe.updated_at || probe.inserted_at);
        if (!isDsExport) {
          // 退路：老的数组形态（每条会话自带 messages 数组）
          return extractLegacy(sessions);
        }
        var out = [];
        for (var q = 0; q < sessions.length; q++) {
          var s0 = sessions[q] || {};
          var sid = s0.id || s0.chat_session_id || s0.session_id;
          if (!sid) continue;
          var msgs = [];
          var rounds = 0;
          var map = s0.mapping;
          if (map && typeof map === 'object') {
            // 按节点 id 数值序（或插入序）遍历，保证对话顺序
            var keys = Object.keys(map);
            var orderable = keys.every(function (k) { return k === 'root' || /^\d+$/.test(k); });
            if (orderable) keys.sort(function (a, b) {
              if (a === 'root') return -1; if (b === 'root') return 1;
              return Number(a) - Number(b);
            });
            for (var ki = 0; ki < keys.length; ki++) {
              var node = map[keys[ki]];
              var m = node && node.message;
              if (!m || !Array.isArray(m.fragments)) continue;
              var reqText = '', resText = '';
              for (var fi = 0; fi < m.fragments.length; fi++) {
                var f = m.fragments[fi] || {};
                var ft = String(f.type || '').toUpperCase();
                if (ft === 'REQUEST') reqText += (f.content || '');
                else if (ft === 'RESPONSE') resText += (f.content || '');
                // THINK 及其他类型一律丢弃（思维链不应进记忆）
              }
              if (reqText) { msgs.push({ role: 'user', content: reqText, inserted_at: m.inserted_at }); rounds++; }
              if (resText) msgs.push({ role: 'assistant', content: resText, inserted_at: m.inserted_at });
            }
          }
          // 不持有全量消息（大会话全量可能数百 MB，跨 world 事件传递会爆），
          // 只保留摘要卡真正需要的内容：首条用户、末条用户、首条助手（各截断 400 字）。
          var userMsgs = [], asstMsgs = [];
          for (var mi = 0; mi < msgs.length; mi++) {
            if (msgs[mi].role === 'user') userMsgs.push(msgs[mi].content || '');
            else asstMsgs.push(msgs[mi].content || '');
          }
          var rawSlim = [];
          if (userMsgs.length) rawSlim.push({ role: 'user', content: String(userMsgs[0]).slice(0, 400) });
          if (asstMsgs.length) rawSlim.push({ role: 'assistant', content: String(asstMsgs[0]).slice(0, 400) });
          if (userMsgs.length > 1) rawSlim.push({ role: 'user', content: String(userMsgs[userMsgs.length - 1]).slice(0, 400) });
          out.push({
            id: String(sid),
            // title 可能含换行/代码块 → 折叠为单行便于列表展示
            title: String(s0.title || s0.name || '(无标题)').replace(/\s+/g, ' ').trim().slice(0, 120) || '(无标题)',
            ts: s0.updated_at || s0.inserted_at || null,
            rounds: rounds,
            fromFile: true,
            raw: rawSlim.length ? rawSlim : null,
            rawFull: msgs.length            // 诊断用：原始消息条数
          });
        }
        return out;
      }
      // 退路：旧形态（会话自带 messages 数组）
      function extractLegacy(sessions) {
        var out = [];
        var MSG_KEYS = ['messages', 'chat_messages', 'chatMessages', 'message_list', 'messageList'];
        for (var q = 0; q < sessions.length; q++) {
          var s0 = sessions[q] || {};
          var sid = s0.id || s0.chat_session_id || s0.session_id;
          if (!sid) continue;
          var msgs = null;
          for (var mk = 0; mk < MSG_KEYS.length; mk++) {
            if (Array.isArray(s0[MSG_KEYS[mk]]) && s0[MSG_KEYS[mk]].length) { msgs = s0[MSG_KEYS[mk]]; break; }
          }
          var userCnt = 0;
          if (Array.isArray(msgs)) {
            for (var mc = 0; mc < msgs.length; mc++) {
              var role = String((msgs[mc] && (msgs[mc].role || msgs[mc].sender)) || '').toLowerCase();
              if (role === 'user' || role === 'human') userCnt++;
            }
          }
          out.push({
            id: String(sid),
            title: String(s0.title || s0.name || '(无标题)').replace(/\s+/g, ' ').trim().slice(0, 120) || '(无标题)',
            ts: s0.updated_at || s0.inserted_at || s0.update_time || null,
            rounds: userCnt || (Array.isArray(msgs) ? Math.ceil(msgs.length / 2) : 0),
            fromFile: true,
            raw: msgs || null
          });
        }
        return out;
      }
      var listEl = mb.querySelector('.im-list');
      var selEl = mb.querySelector('.im-sel');
      var importedIds = {};   // v0.5.17：已入库会话 id 集（渲染时隐藏）
      retrySend({ type: 'getImportedIds' }, 1, function (r0) {
        if (r0 && r0.ok && Array.isArray(r0.ids)) {
          r0.ids.forEach(function (x) { importedIds[String(x)] = 1; });
          try { renderList(); } catch (e) { /* 列表未就绪时忽略，后续渲染自会生效 */ }
        }
      });
      var nextBtn = mb.querySelector('.im-next');
      var lcEl = mb.querySelector('.im-lc');
      var barEl = mb.querySelector('.bar > i');
      var sessions = [];
      var importMode = 'card';   // v0.3.33：card=摘要卡 | full=全文（由点击的按钮决定）
      function checkedIds() {
        var out = [];
        var boxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
        for (var i = 0; i < boxes.length; i++) {
          var sid = boxes[i].dataset.sid;
          var rec = null;
          for (var q = 0; q < sessions.length; q++) { if (String(sessions[q].id) === String(sid)) { rec = sessions[q]; break; } }
          out.push({ id: sid, title: boxes[i].dataset.title || '', ts: rec ? rec.ts : null, fromFile: !!(rec && rec.fromFile), raw: rec ? rec.raw : null, mode: importMode });
        }
        return out;
      }
      function syncSel() {
        var c = checkedIds();
        selEl.textContent = '已选 ' + fmtInt(c.length) + ' / ' + fmtInt(sessions.length);
        nextBtn.disabled = !c.length;
        var fb = mb.querySelector('.im-full');
        if (fb) fb.disabled = !c.length;
      }
      function renderList() {
        var kw = String(mb.querySelector('.im-kw').value || '').trim().toLowerCase();
        // 多方式排序（修改时间 / 轮次 / 标题）
        var sortKey = (mb.querySelector('.im-sort') || {}).value || 'time';
        var ordered = sessions.slice();
        // 排序键归一——时间戳统一转毫秒（秒/毫秒/ISO 串），轮次缺失回退；
        // ts/rounds 为空时两种排序都会退化为原序，必须保证键有效。
        function tsMs(v) {
          if (v == null || v === '') return 0;
          if (typeof v === 'string') { var d = new Date(v); return isNaN(d.getTime()) ? 0 : d.getTime(); }
          var n = Number(v);
          if (!isFinite(n) || n <= 0) return 0;
          if (n >= 1e12) return n;
          if (n > 1e9) return n * 1000;
          if (n > 1e6) return n * 1000;
          return 0;
        }
        // 次键改用标题（与主键正交）——「按轮次」缺轮次数据时若回退到时间，
        // 与「按时间」结果完全相同，两种排序无法区分。
        if (sortKey === 'rounds') {
          ordered.sort(function (a, b) {
            var d = (Number(b.rounds || b.msgCount || 0)) - (Number(a.rounds || a.msgCount || 0));
            if (d !== 0) return d;
            return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
          });
        } else if (sortKey === 'title') {
          ordered.sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || ''), 'zh'); });
        } else {
          ordered.sort(function (a, b) {
            var d = tsMs(b.ts) - tsMs(a.ts);
            if (d !== 0) return d;
            return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
          });
        }
        var html = '';
        for (var i = 0; i < ordered.length; i++) {
          var s0 = ordered[i];
          if (kw && String(s0.title || '').toLowerCase().indexOf(kw) < 0) continue;
          if (importedIds[String(s0.id)]) continue;   // 已入库会话隐藏（明确"哪些已入库/哪些没有"）
          // ts 支持 ISO 字符串与秒/毫秒数值三形态（文件导入的 updated_at 是 ISO 串，
          // Number(ISO) = NaN → 全部显示"(无日期)"）
          var t = null;
          if (s0.ts != null && s0.ts !== '') {
            if (typeof s0.ts === 'string') { var td = new Date(s0.ts); t = isNaN(td.getTime()) ? null : td; }
            else { var _tsn = Number(s0.ts); t = new Date(_tsn > 0 && _tsn < 1e11 ? _tsn * 1000 : _tsn); if (isNaN(t.getTime())) t = null; }
          }
          var tstr = (t && !isNaN(t.getTime())) ? (t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')) : '';
          html += '<label class="row" style="cursor:pointer;">' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s0.title || '(无标题)') +
            (tstr ? ' <span class="muted" style="font-size:11px;">' + tstr + '</span>' : ' <span class="muted" style="font-size:11px;">(无日期)</span>') +
            (s0.rounds ? ' <span class="muted" style="font-size:11px;">· ' + s0.rounds + ' 轮</span>' : '') + '</span>' +
            '<input type="checkbox" data-sid="' + esc(s0.id) + '" data-title="' + esc(s0.title || '') + '" style="flex-shrink:0;">' +
            '</label>';
        }
        listEl.innerHTML = html || '<div class="hint">（无匹配会话）</div>';
        listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.addEventListener('change', syncSel); });
        syncSel();
      }
      mb.querySelector('.im-kw').addEventListener('input', renderList);
      var sortSel = mb.querySelector('.im-sort');
      if (sortSel) sortSel.addEventListener('change', renderList); // v0.3.18（增强①）：切换排序即重排
      mb.querySelector('.im-all').addEventListener('click', function () {
        listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = true; });
        syncSel();
      });
      mb.querySelector('.im-none').addEventListener('click', function () {
        listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = !cb.checked; });
        syncSel();
      });
      // 双按钮——生成摘要卡/ 全量导入（全文蒸馏，重要会话用）
      function guardAndStart(mode) {
        var ids = checkedIds();
        chrome.storage.local.get({ maxImportSessions: 20 }, function (c) {
          var cap = Math.max(1, Math.min(parseInt(c.maxImportSessions, 10) || 20, 200));
          if (ids.length > cap) { showToast('已选 ' + ids.length + ' 个，超过上限 ' + cap + '（设置页可调）'); return; }
          imStart(ids, mode);
        });
      }
      nextBtn.addEventListener('click', function () { guardAndStart('card'); });
      var fullBtn = mb.querySelector('.im-full');
      if (fullBtn) {
        fullBtn.addEventListener('click', function () { guardAndStart('full'); });
        fullBtn.addEventListener('mouseenter', function () {
          var ids = checkedIds();
          var chars = 0;
          for (var i = 0; i < ids.length; i++) {
            var rec = null;
            for (var q = 0; q < sessions.length; q++) { if (String(sessions[q].id) === String(ids[i].id)) { rec = sessions[q]; break; } }
            if (rec && rec.rawFull) chars += rec.rawFull * 12;      // 粗估：每条消息 ≈ 12 字符（含回复）
            else chars += 3000;                                      // API 会话未知，按典型会话估
          }
          fullBtn.title = '全文蒸馏：约 ' + fmtInt(chars) + ' 字符 ≈ ' + fmtInt(Math.round(chars / 1.7)) + ' token。';
        });
      }
      // L1 数据：拉全量会话列表（injected fetchAllSessions 分页）
      window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'sessions-list' } }));
      imHandlers.listProgress = function (p) {
        lcEl.textContent = fmtInt(p.done || 0);
        barEl.style.width = Math.min(60, (p.done || 0) / 2) + '%';
      };
      imHandlers.sessionsList = function (d) {
        sessions = d.sessions || [];
        if (d.error) { listEl.innerHTML = '<div class="hint">拉取失败：' + esc(d.error) + '</div>'; return; }
        barEl.style.width = '100%';
        mb.querySelector('.bar').style.opacity = '.35';
        renderList();
        plog('L1 会话列表就绪', sessions.length, '个');
      };
    }

      // 「导入旧会话」绑定（openPanel 内、与 openImportFlow 同闭包层）
      var __ib = root.querySelector('.act-import');
      if (__ib && !__ib.dataset.mnBound) { __ib.dataset.mnBound = '1'; __ib.addEventListener('click', openImportFlow); } // v0.3.5a：openPanel 可重入，防 handler 叠加

    function imStart(ids, mode) {
      // mode='card' 摘要卡 | 'full' 全文蒸馏（重要会话）
      mode = mode || 'card';
      importBusy = true;
      var mb = imOpen(mode === 'full' ? '正在提取完整对话…' : '正在生成摘要卡…');   // v0.4.1：标题随模式
      mb.innerHTML =
        '<div class="im-stage"><p class="muted">准备中…</p></div>' +
        '<div class="bar"><i></i></div>';
      var stage = mb.querySelector('.im-stage');
      var barEl = mb.querySelector('.bar > i');
      function setBar(pct) { if (barEl) barEl.style.width = pct + '%'; }
      window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'summarize', sessions: ids, mode: mode } }));
      // 会话处理完成后还有 estimate 往返——进度文案动态切换，避免"看似卡死"
      imHandlers.extractDone = function () {
        stage.innerHTML = '<p class="muted">正在估算预算…</p>';
        setBar(96);
      };
      imHandlers.progress = function (p) {
        if (p.phase === 'sessions') {
          stage.innerHTML = '<p>已处理会话 ' + fmtInt(p.done) + ' / ' + fmtInt(p.total) + '</p>' +
            '<p class="muted">' + (mode === 'full' ? '拉取全文并整理对话对…' : '本地提取中…') + '</p>';   // v0.4.1：进度随模式
          setBar(p.total ? Math.round(p.done / p.total * 92) : 4);
        }
        // 估算阶段可见（estimate 往返期间进度条不能静止）
        if (p.phase === 'estimate') {
          console.log('[P12] 进入估算阶段（content 已收到事件）');
          stage.innerHTML = '<p class="muted">正在估算预算…（大会话需要一些时间）</p>';
          setBar(96);
        }
      };
      imHandlers.summariesReady = function (d) {
        console.log('[P11] content 收到 summaries-ready', { ok: d.ok, cards: d.cards, mode: d.mode, previewN: (d.preview || []).length });
        // batches 留在 injected（__pendingBatches），content 只收统计+preview 样本
        if (!d.ok) {
          importBusy = false;
          var isFull = d.mode === 'full';
          stage.innerHTML = '<p>✗ ' + (isFull ? '完整对话提取失败：' : '摘要卡生成失败：') + esc(d.error || '未知错误') + '</p>' +
            '<div class="btns" style="margin-top:10px;"><button class="btn im-finish">关闭</button></div>';
          var f0 = stage.querySelector('.im-finish');
          if (f0) f0.addEventListener('click', closePanelImport);
          return;
        }
        funnelChars = d.chars || 0;
        funnelCards = d.cards || 0;
        funnelPreview = d.preview || [];
        imConfirm(d);
      };
    }

    // L3：预估确认（bridge estimate 桩位 {estimateChars,estimateTokens,sessions}；404 降级本地字数估算）
    function imConfirm(d) {
      console.log('[P13] imConfirm 弹出', { sessions: d.sessions, cards: d.cards, mode: d.mode });
      importBusy = false;
      importModeName = d.mode === 'full' ? 'full' : 'card';   // v0.3.34：随事件传入
      var mb = imOpen('导入预览 · 确认预算');
      var est = d.estimate || {};
      var estOk = !!est.ok;
      var estChars = estOk && est.estimate && est.estimate.estimateChars !== undefined ? est.estimate.estimateChars : d.chars;
      var estTokens = estOk && est.estimate && est.estimate.estimateTokens !== undefined ? est.estimate.estimateTokens : Math.round((d.chars || 0) / 1.7);
      var exceed = estOk && est.estimate && est.estimate.wouldExceed === true; // v0.3.15：bridge 字符闸判定透出
      var exceedCap = estOk && est.estimate && est.estimate.maxImportChars !== undefined ? est.estimate.maxImportChars : 0;
      // 预估费用按 DeepSeek 官方最便宜模型（V4-Flash）定价：
      // 输入 1 元/百万 tokens，输出 2 元/百万 tokens；蒸馏输入:输出 ≈ 20:1 → 加权 1.05 元/百万 tokens
      var YUAN_PER_MTOK = 1.05;
      function estYuan(tokens) { return '≈ ￥' + (Math.round(tokens / 1000000 * YUAN_PER_MTOK * 100) / 100).toFixed(2); }
      var estLines = estOk
        ? '<p>bridge 预估：<b>' + fmtInt(estChars) + '</b> 字符 ≈ <b>' + fmtInt(estTokens) + '</b> token，' +
          '<b>' + estYuan(estTokens) + '</b>' +
          (est.estimate && est.estimate.sessions ? '（' + fmtInt(est.estimate.sessions) + ' 会话）' : '') + '</p>'
        : '<p>本地估算：<b>' + fmtInt(d.chars) + '</b> 字符 ≈ <b>' + fmtInt(Math.round((d.chars || 0) / 1.7)) + '</b> token，<b>' + estYuan(Math.round((d.chars || 0) / 1.7)) + '</b></p>';
      mb.innerHTML =
        '<p>已为 <b>' + fmtInt(d.sessions) + '</b> 个会话提取 <b>' + fmtInt(d.cards) + '</b> 条' + (importModeName === 'full' ? '完整对话对（全文蒸馏）' : '摘要卡') + '。</p>' +
        estLines +
        '<p class="muted">确认后进入蒸馏队列，下次 DSH 启动时蒸馏为正式记忆。</p>' +
        '<div class="card" style="max-height:30vh;overflow-y:auto;margin:8px 0;">' + previewCards(funnelPreview) + '</div>' +
        (exceed ? '<p style="color:#e5484d;margin:6px 0;">⚠ 超出字符闸（' + fmtInt(estChars) + ' / ' + fmtInt(exceedCap) + '），请减少勾选会话或调大设置页「导入总字符量闸」。</p>' : '') +
        '<div class="btns" style="margin-top:10px;">' +
        '  <button class="btn primary im-send"' + (exceed ? ' disabled style="opacity:.45;cursor:not-allowed;"' : '') + '>确认导入</button>' +
        '  <button class="btn im-cancel2">取消</button>' +
        '</div>';
      if (exceed) {
        var sb = mb.querySelector('.im-send');
        if (sb) sb.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
      }
      mb.querySelector('.im-cancel2').addEventListener('click', imClose);
      mb.querySelector('.im-send').addEventListener('click', function () {
        importBusy = true;
        var mb2 = imOpen('正在导入…');
        mb2.innerHTML = '<div class="im-stage"><p class="muted">发送中…</p></div><div class="bar"><i></i></div>';
        var stage2 = mb2.querySelector('.im-stage');
        var bar2 = mb2.querySelector('.bar > i');
        window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'send-confirm' } }));   // v0.4.2：injected 直接用 __pendingBatches }));
        imHandlers.progress = function (p) {
          if (p.phase === 'import') {
            stage2.innerHTML = '<p>已导入 ' + fmtInt(p.imported) + ' 条（第 ' + fmtInt(p.done) + '/' + fmtInt(p.total) + ' 批）</p>';
            bar2.style.width = Math.round(p.done / Math.max(1, p.total) * 100) + '%';
          }
        };
        imHandlers.funnelDone = function (res) {
          importBusy = false;
          bar2.style.width = '100%';
          if (res.ok) {
            stage2.innerHTML = '<p>✓ 完成：导入 <b>' + fmtInt(res.imported) + '</b> 条摘要（' + fmtInt(res.batches) + ' 批）。</p>' +
              '<p class="muted">已进入蒸馏队列，下次 DSH 启动时自动总结。</p>' +
              '<div class="btns" style="margin-top:10px;"><button class="btn im-finish">完成</button></div>';
          } else {
            stage2.innerHTML = '<p>✗ 导入失败：' + esc(res.error || '未知错误') + '</p>' +
              '<div class="btns" style="margin-top:10px;"><button class="btn im-finish">关闭</button></div>';
          }
          var fin = stage2.querySelector('.im-finish');
          if (fin) fin.addEventListener('click', closePanelImport);
        };
      });
    }
    var importModeName = 'card';   // v0.3.34：预览标题随模式
    function previewCards(batches) {
      var all = [];
      for (var b = 0; b < (batches || []).length; b++) all = all.concat(batches[b]);
      var html = '';
      for (var i = 0; i < Math.min(all.length, 50); i++) {
        var it = all[i] || {};
        var a = String(it.assistant || '').trim();
        html += '<div class="row-item"><div class="row-content" style="white-space:pre-wrap;">' +
          '<b>问：</b>' + esc(String(it.user || '').slice(0, 160)) +
          (a ? '<br><b>答：</b>' + esc(a.slice(0, 200)) : '') +
          '</div></div>';
      }
      if (all.length > 50) html += '<div class="hint">…其余 ' + fmtInt(all.length - 50) + ' 条略</div>';
      return html || '<div class="hint">（无内容）</div>';
    }

    } catch (panelErr) {
      try { console.warn('[mneme/panel] 挂载失败(不影响主链路):', panelErr); } catch (e2) {}
    }

    // PANEL_TAG/plog 提升到函数体层——try 后段的侧栏挂载/面板构建
    // 在 try 外（严格模式块级作用域拿不到块内声明），裸引用会炸断挂载。
    var PANEL_TAG = '[mneme/panel]';
    function plog() {
      if (!cfgCache.debug) return;
      console.log.apply(console, [PANEL_TAG].concat([].slice.call(arguments)));
    }
    var imHandlers = { progress: null, done: null, listProgress: null, sessionsList: null, summariesReady: null, funnelDone: null };
    imHandlers.done = function (res) {
        importBusy = false;
        setBar(100);
        if (res.ok) {
          stage.innerHTML =
            '<p>✓ 完成：' + fmtInt(res.sessions) + ' 个会话，导入 <b>' + fmtInt(res.imported) + '</b> 条对话（' + fmtInt(res.batches) + ' 批）</p>' +
            '<p class="muted">已进入蒸馏队列，下次 DSH 启动时自动总结。</p>' +
            '<div class="btns" style="margin-top:10px;"><button class="btn im-finish">完成</button></div>';
        } else {
          stage.innerHTML =
            '<p>✗ 导入失败：' + esc(res.error || '未知错误') + '</p>' +
            '<p class="muted">排查：确认网页已登录；Console 执行 __MNEME_IMPORT_PROBE__() 把输出贴回来校准接口；bridge 未连通时检查设置页 Token。</p>' +
            '<div class="btns" style="margin-top:10px;"><button class="btn im-finish">关闭</button></div>';
        }
        var fin = stage.querySelector('.im-finish');
        if (fin) fin.addEventListener('click', closePanelImport);
      };
    // ---- 侧栏锚点：文本命中 → 向上爬「行」级祖先（28~56px 高、60~320px 宽）----
    function findSidebarRows() {
      var labels = ['系统设置', '帮助与反馈'];
      var all = document.querySelectorAll('aside *, nav *, [class*="sidebar" i] *, [class*="menu" i] *');
      var rows = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 3) continue;
        var t = (el.innerText || '').trim();
        if (labels.indexOf(t) < 0) continue;
        var row = climbToRow(el);
        var dup = false;
        for (var ri = 0; ri < rows.length; ri++) if (rows[ri].row === row) dup = true;
        if (row && !dup) rows.push({ row: row, label: el }); // 保留文本子元素，供同源取样式
      }
      return rows;
    }
    function climbToRow(el) {
      var cur = el;
      for (var d = 0; d < 5 && cur; d++) {
        var r = cur.getBoundingClientRect();
        if (r.height >= 28 && r.height <= 56 && r.width > 60 && r.width < 320) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    // 菜单项：浅克隆原生行壳（tagName/class，自动继承 DS 侧栏样式），内容自绘。
    // 关键样式直接从原生行
    // （ds-dropdown-menu-option）及其文本子元素的 computedStyle 复制——padding/
    // 字号/行高/颜色/圆角/间距同源，不再手写固定值；图标改为与 DS 原生一致的
    // 简洁线条 SVG（1.5px stroke，currentColor，尺寸取原生行内 svg 实测宽）。
    function buildSideItem(row, labelEl) {
      var item;
      try {
        item = row.cloneNode(false);
        if (item.id) item.removeAttribute('id');
        item.removeAttribute('href'); // 防 <a> 壳导航；非链接标签为无害 no-op
        while (item.firstChild) item.removeChild(item.firstChild);
      } catch (e) { item = document.createElement('div'); }
      item.setAttribute('data-mneme-side-item', '1');
      var s = item.style;
      // 手写兜底值在前（取不到原生样式时保底），同源同步在后覆盖
      s.cursor = 'pointer';
      s.display = 'flex'; s.alignItems = 'center'; s.gap = '10px';
      s.padding = '8px 12px';
      s.fontSize = '13px'; s.fontWeight = '500'; s.lineHeight = '1.6';
      s.color = 'inherit'; s.userSelect = 'none';
      s.transition = 'background .15s';
      try {
        var csR = window.getComputedStyle(row);
        var keys = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
          'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
          'fontSize', 'fontWeight', 'lineHeight', 'color',
          'borderRadius', 'minHeight', 'height'];
        for (var ki = 0; ki < keys.length; ki++) {
          var v = csR[keys[ki]];
          if (v && v !== 'auto' && v !== 'normal' && v !== 'none' && v !== '0px') item.style[keys[ki]] = v;
        }
        var cg = csR.columnGap;
        if (cg && cg !== 'normal' && parseFloat(cg) > 0) s.gap = cg;
      } catch (e1) { /* 取样式失败则保留兜底值 */ }
      item.addEventListener('mouseenter', function () { item.style.background = curHoverBg(); });
      item.addEventListener('mouseleave', function () { item.style.background = 'transparent'; });
      // 图标：尺寸与原生行内 svg 对齐；线条风格与 DS 原生一致（书签=收藏的记忆）
      var icoSize = 16;
      try {
        var nativeSvg = row.querySelector('svg');
        if (nativeSvg) {
          var nr = nativeSvg.getBoundingClientRect();
          if (nr.width >= 12 && nr.width <= 28) icoSize = Math.round(nr.width);
        }
      } catch (e2) {}
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(icoSize));
      svg.setAttribute('height', String(icoSize));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.5');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>';
      svg.style.flexShrink = '0';
      var label = document.createElement('span');
      label.textContent = '记忆设置';
      try {
        // 文本子元素样式同源复制（原生行字号/字重/行高/颜色可能挂在文本层而非行层）
        var csL = labelEl ? window.getComputedStyle(labelEl) : null;
        if (csL) {
          var lkeys = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'letterSpacing'];
          for (var li = 0; li < lkeys.length; li++) {
            var lv = csL[lkeys[li]];
            if (lv && lv !== 'normal' && lv !== 'none') label.style[lkeys[li]] = lv;
          }
        }
      } catch (e3) {}
      item.appendChild(svg);
      item.appendChild(label);
      // capture+stopPropagation：防 DS 侧栏容器的事件委托误路由；防 <a> 壳导航
      item.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (window.__MNEME_OPEN_PANEL__) window.__MNEME_OPEN_PANEL__();
      }, true);
      return item;
    }
    function curHoverBg() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)';
    }

    // ---- 侧栏挂载 + SPA 重挂（无 fallback：找不到就持续等 observer，30s 节流告警）----
    var sideItem = null;
    var attachTimer = null;
    var lastWarn = 0;
    function tryAttachSidebar() {
      if (sideItem && sideItem.isConnected) return;
      var rows = findSidebarRows();
      if (!rows.length) {
        if (Date.now() - lastWarn > 30000) { plog('侧栏锚点未命中（系统设置/帮助与反馈），持续观察中…'); lastWarn = Date.now(); }
        return;
      }
      // 入口插在「系统设置」与「帮助与反馈」之间
      var pick = rows.find(function (r) {
        var lt = (r.label && r.label.innerText) ? r.label.innerText.trim() : r.label;
        return lt === '系统设置';
      }) || rows[rows.length - 1];
      var row = pick.row;
      var parent = row.parentElement;
      if (!parent) return;
      var item = buildSideItem(row, pick.label);
      if (row.nextSibling) parent.insertBefore(item, row.nextSibling);
      else parent.appendChild(item);
      sideItem = item;
      plog('侧栏项已挂载，row tag=' + row.tagName + ' class=' + String(row.className).slice(0, 60));
    }
    function scheduleAttach() {
      if (attachTimer) return;
      attachTimer = setTimeout(function () { attachTimer = null; tryAttachSidebar(); }, 800);
    }
    var mo = new MutationObserver(scheduleAttach); // SPA：侧栏延迟渲染/路由重建 → 防抖重挂
    mo.observe(document.documentElement, { childList: true, subtree: true });
    tryAttachSidebar();

    // ---- 状态区 + 开关（与 options 共用 storage 键） ----
    var statusTextEl = root.querySelector('.status-text');
    var dotEl = root.querySelector('.dot');
    function refreshStatus() {
      statusTextEl.textContent = 'bridge：检测中…';
      dotEl.style.background = '#b0b0b0';
      retrySend({ type: 'ping' }, 2, function (r) {
        if (r && r.ok) { statusTextEl.textContent = 'bridge：连通 ✓'; dotEl.style.background = '#34c759'; }
        else { statusTextEl.textContent = 'bridge：不连通 ✗（检查 bridge 进程/设置页 Token）'; dotEl.style.background = '#e5484d'; }
      });
    }
    var CFG_DEFAULTS = { injectEnabled: true, collectEnabled: true, debug: false, injectMode: 'implicit', maxImportSessions: 20, maxImportChars: 1500000 };
    function syncCfgToUI(c) {
      root.querySelectorAll('input[data-cfg]').forEach(function (cb) { cb.checked = !!c[cb.dataset.cfg]; });
      // radio（注入方式）与数字输入（闸值）同步
      root.querySelectorAll('input[data-cfg-radio]').forEach(function (rb) {
        if (String(c[rb.dataset.cfgRadio] || 'implicit') === rb.value) rb.checked = true;
      });
      root.querySelectorAll('input[data-cfg-num]').forEach(function (nb) {
        var v = c[nb.dataset.cfgNum];
        nb.value = (v == null || v === '') ? '' : String(v);
      });
    }
    chrome.storage.local.get(CFG_DEFAULTS, function (c) { syncCfgToUI(c); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      // 增量同步——把单键 patch 传给 syncCfgToUI 时不能全量刷，缺失键
      // 取 undefined → !!undefined=false → 点 radio 后所有开关被错误置关。
      if (area !== 'local') return;
      root.querySelectorAll('input[data-cfg]').forEach(function (cb) {
        if (cb.dataset.cfg in ch) cb.checked = !!ch[cb.dataset.cfg].newValue;
      });
      root.querySelectorAll('input[data-cfg-radio]').forEach(function (rb) {
        if (rb.dataset.cfgRadio in ch) rb.checked = String(ch[rb.dataset.cfgRadio].newValue) === rb.value;
      });
      root.querySelectorAll('input[data-cfg-num]').forEach(function (nb) {
        if (nb.dataset.cfgNum in ch) nb.value = ch[nb.dataset.cfgNum].newValue == null ? '' : String(ch[nb.dataset.cfgNum].newValue);
      });
    });
    root.querySelectorAll('input[data-cfg]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var u = {}; u[cb.dataset.cfg] = cb.checked;
        chrome.storage.local.set(u);
      });
    });
    // 注入方式单选 + 数字输入绑定
    root.querySelectorAll('input[data-cfg-radio]').forEach(function (rb) {
      rb.addEventListener('change', function () {
        if (!rb.checked) return;
        var u2 = {}; u2[rb.dataset.cfgRadio] = rb.value;
        chrome.storage.local.set(u2);
        showToast(rb.value === 'visible' ? '已切换为可见注入' : '已切换为隐式注入');
      });
    });
    root.querySelectorAll('input[data-cfg-num]').forEach(function (nb) {
      nb.addEventListener('change', function () {
        var v = String(nb.value || '').replace(/[^0-9]/g, '');
        if (!v) { nb.value = ''; return; }
        var u3 = {}; u3[nb.dataset.cfgNum] = parseInt(v, 10);
        chrome.storage.local.set(u3);
      });
    });
    var advToggle = root.querySelector('.act-toggle-adv');
    if (advToggle) advToggle.addEventListener('click', function () {
      var ac = root.querySelector('.adv-card');
      if (ac) ac.style.display = ac.style.display === 'none' ? '' : 'none';
    });

    // ---- 最近记忆（经 background getRecent → GET /memory/recent?limit=10） ----
    var listEl = root.querySelector('.list');
    // 面板层自带格式化（renderList 引用 openPanel 内的 fmtInt 会 ReferenceError，
    // 导致记忆库所有标签点击后列表永不渲染）。
    function mnFmt(n) { return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function renderList(items, tab) {
      // 过滤管线缓冲行（pending-distill = 待蒸馏原料，尚未成为正式记忆）
      // 否则全量导入后「记忆库」被几十条旧会话原始对话刷屏
      items = (items || []).filter(function (m) {
        return !(Array.isArray(m.tags) && m.tags.indexOf('pending-distill') >= 0);
      });
      if (!items || !items.length) { listEl.innerHTML = '<div class="hint">暂无记忆（导入的会话将在 DSH 启动后蒸馏为记忆）</div>'; return; }
      var countEl = root.querySelector('.list-count');
      var head = '<div class="list-head">共 ' + mnFmt(items.length) + ' 条' + (tab && tab !== 'recent' && tab !== 'all' ? ' · ' + TYPE_LABEL[tab] : '') + '</div>';
      listEl.innerHTML = head + items.map(function (m) {
        var c = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        var t = m.type || '?';
        var imp = Number(m.importance || 0);
        var dots = '';
        for (var k = 0; k < 5; k++) dots += '<i class="' + (k < imp ? 'on' : '') + '"></i>';
        return '<div class="row-item"><div class="row-head"><b>' + esc(m.title || '(无标题)') + '</b>' +
          '<span class="badge">' + esc(TYPE_LABEL[t] || t) + '</span></div>' +
          (c ? '<div class="row-content">' + esc(c) + '</div>' : '') +
          '<div class="imp" title="重要度 ' + imp + '/5">' + dots + '</div></div>';
      }).join('');
    }
    // 记忆库分组浏览——recent=最近；其余按 mneme 类型拉取
    var curTab = 'recent';
    var TYPE_LABEL = { preference: '偏好', constraint: '约束', decision: '决策', project: '项目', pitfall: '陷阱', history: '历史', rejected_solution: '否决方案' };
    var ALL_TYPES = ['preference', 'constraint', 'decision', 'project', 'pitfall', 'history', 'rejected_solution'];
    function loadRecent() {
      listEl.innerHTML = '<div class="hint">加载中…</div>';
      if (curTab === 'recent') {
        retrySend({ type: 'getRecent', limit: 20 }, 2, function (r) {
          if (r && r.ok) { renderList(r.items, 'recent'); plog('recent 载入', r.items.length, '条'); }
          else listEl.innerHTML = '<div class="hint">加载失败（检查 bridge）</div>';
        });
        return;
      }
      // 按单类型并发拉取（多类型一次请求在扩展侧可能返回 0 条，并发规避）。
      var want = curTab === 'all' ? ALL_TYPES.slice() : [curTab];
      var acc = [];
      var pending = want.length;
      var failed = 0;
      want.forEach(function (t) {
        retrySend({ type: 'getList', memType: t, limit: curTab === 'all' ? 40 : 80 }, 2, function (r) {
          if (r && r.ok && r.items && r.items.length) {
            for (var i = 0; i < r.items.length; i++) acc.push(r.items[i]);
          } else if (!r || !r.ok) { failed++; }
          pending--;
          if (pending > 0) return;
          // 全部返回后排序（重要度降序 → 时间）并渲染
          acc.sort(function (a, b) {
            var d = (Number(b.importance) || 0) - (Number(a.importance) || 0);
            if (d !== 0) return d;
            return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
          });
          if (!acc.length) {
            listEl.innerHTML = '<div class="hint">' + (failed ? '加载失败（bridge 未连通或版本过旧？）' : '暂无记忆') + '</div>';
            plog('记忆库', curTab, '空结果，失败源', failed);
            return;
          }
          renderList(acc, curTab);
          plog('记忆库', curTab, '载入', acc.length, '条');
        });
      });
    }
    // 待蒸馏队列嵌入「记忆维护」面板（不再另起弹层）
    function renderQueueCard() {
      var card = root.querySelector('#queue-card');
      if (!card) return;
      retrySend({ type: 'getPending', limit: 200 }, 2, function (r) {
        if (!r || !r.ok) {
          card.innerHTML = '<div class="hint" style="padding:16px;">加载失败（bridge 未连通？）</div>';
          return;
        }
        var items = r.items || [];
        if (!items.length) {
          card.innerHTML = '<div class="hint" style="padding:16px;">没有可待蒸馏的会话</div>';
          return;
        }
        var groups = {};
        var order = [];
        items.forEach(function (it) {
          var sid = it.session_id || '未归属';
          if (!groups[sid]) { groups[sid] = []; order.push(sid); }
          groups[sid].push(it);
        });
        function fmtTime(t) {
          if (!t) return '';
          var d = new Date(t);
          if (isNaN(d.getTime())) return '';
          return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
        function qFmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }   // v0.5.8：本地格式化（fmtInt 在 try 块内，跨块不可见）
        var html = '<div style="padding:8px 14px;font-size:12.5px;opacity:.55;border-bottom:1px solid rgba(127,127,127,.12);display:flex;align-items:center;gap:8px;">' +
          '<span>共 ' + qFmt(items.length) + ' 条 · ' + qFmt(order.length) + ' 个会话</span>' +
          '<span style="flex:1;"></span>' +
          '<button class="act-distill-inline"' + (items.length ? '' : ' disabled') + ' style="padding:5px 14px;font-size:12.5px;border:none;border-radius:4096px;background:#4d6bfe;color:#fff;cursor:pointer;transition:background .15s;' + (items.length ? 'onmouseover=\"this.style.background=\'#6b85ff\'\" onmouseout=\"this.style.background=\'#4d6bfe\'\""' : 'opacity:.45;cursor:not-allowed;') + '>立即蒸馏</button>' +
          '</div>';
        html += '<div style="max-height:420px;overflow-y:auto;">';
        order.forEach(function (sid) {
          var g = groups[sid];
          html += '<div style="padding:8px 14px 4px;font-size:11px;opacity:.45;display:flex;align-items:center;gap:6px;">' +
            '<span>' + esc(sid === '未归属' ? '未归属' : '会话 ' + String(sid).slice(0, 8)) + '</span>' +
            '<span style="flex:1;height:1px;background:rgba(127,127,127,.12);"></span>' +
            '<span>' + qFmt(g.length) + ' 条</span></div>';
          g.forEach(function (it) {
            var u = String(it.user || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            var a = String(it.assistant || '').replace(/\s+/g, ' ').trim().slice(0, 90);
            html += '<div class="row-item" style="position:relative;" data-bid="' + esc(it.id) + '">' +
              '<div class="row-head"><b style="padding-right:22px;">' + esc(u || '(空)') + '</b>' +
              (it.distill_kind === 'summary-card' ? '<span class="badge">摘要卡</span>' : '') +
              '<button class="q-del" title="不蒸馏此条" data-bid="' + esc(it.id) + '" style="position:absolute;right:10px;top:10px;border:none;background:transparent;color:inherit;opacity:.35;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;">✕</button></div>' +
              (a ? '<div class="row-content">答：' + esc(a) + '</div>' : '') +
              (fmtTime(it.occurred_at) ? '<div style="font-size:11px;opacity:.4;margin-top:4px;">' + fmtTime(it.occurred_at) + '</div>' : '') +
              '</div>';
          });
        });
        html += '</div>';
        card.innerHTML = html;
        // 刷新按钮
        var qr = card.querySelector('.q-refresh');
        if (qr) qr.addEventListener('click', function () { qr.style.opacity = '.3'; renderQueueCard(); });
        // X 删除（事件委托——条目是动态渲染的）
        card.addEventListener('click', function (e) {
          var btn = e.target.closest ? e.target.closest('.q-del') : null;
          if (!btn) return;
          e.stopPropagation();
          var bid = btn.dataset.bid;
          btn.textContent = '…';
          retrySend({ type: 'deletePending', id: bid }, 1, function (r) {
            if (r && r.ok) { showToast('已从队列移除'); renderQueueCard(); }
            else { showToast('删除失败'); btn.textContent = '✕'; }
          });
        });
        var db = card.querySelector('.act-distill-inline');
        if (db) db.addEventListener('click', function () {
          if (db.disabled) return;
          db.disabled = true;
          var oldText = db.textContent;
          db.textContent = '蒸馏中…';
          db.style.opacity = '.6';
          var startCount = items.length;
          // 轮询队列条数：蒸馏是异步长任务（headless LLM 数分钟），条数下降=在推进
          var polls = 0;
          var poll = function () {
            polls++;
            retrySend({ type: 'getPending', limit: 200 }, 1, function (r2) {
              var n = (r2 && r2.ok) ? ((r2.items || []).length) : startCount;
              if (n === 0) {
                db.disabled = false; db.textContent = oldText; db.style.opacity = '';
                showToast('蒸馏完成：队列已清空');
                renderQueueCard();
              } else if (n < startCount) {
                db.disabled = false; db.textContent = oldText; db.style.opacity = '';
                showToast('蒸馏进行中：剩余 ' + n + ' 条（完成部分已入库）');
                renderQueueCard();
              } else if (polls >= 20) {
                db.disabled = false; db.textContent = oldText; db.style.opacity = '';
                showToast('蒸馏仍在后台进行，可稍后回来查看');
              } else {
                setTimeout(poll, 6000);
              }
            });
          };
          retrySend({ type: 'triggerDistill' }, 1, function (r) {
            if (r && r.ok) setTimeout(poll, 3000);
            else {
              db.disabled = false; db.textContent = oldText; db.style.opacity = '';
              showToast('蒸馏请求失败：bridge 未连通');
            }
          });
        });
      });
    }

    // 左侧栏导航切换（DS 系统设置式：左 nav + 右内容）
    var __qrt = root.querySelector('.q-refresh-title');
    if (__qrt) __qrt.addEventListener('click', function () { __qrt.style.opacity = '.3'; renderQueueCard(); setTimeout(function () { __qrt.style.opacity = '.55'; }, 400); });
    root.querySelectorAll('.mnav-item').forEach(function (nb) {
      nb.addEventListener('click', function () {
        root.querySelectorAll('.mnav-item').forEach(function (x) { x.classList.remove('active'); });
        nb.classList.add('active');
        var target = nb.dataset.pane;
        root.querySelectorAll('.pane').forEach(function (p) {
          p.style.display = p.dataset.pane === target ? '' : 'none';
        });
        if (target === 'library') loadRecent();
        if (target === 'maintain') renderQueueCard();   // v0.5.4：进入记忆维护时刷新待蒸馏队列
      });
    });

    root.querySelectorAll('.tab').forEach(function (tb) {
      tb.addEventListener('click', function () {
        root.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
        tb.classList.add('active');
        curTab = tb.dataset.tab;
        loadRecent();
      });
    });
    root.querySelector('.refresh').addEventListener('click', loadRecent);

    // ---- 快捷操作 ----
    var toastTimer = null;
    function showToast(msg) {
      toast.textContent = msg; toast.style.display = '';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.style.display = 'none'; }, 2200);
    }
    root.querySelector('.act-settings').addEventListener('click', function () {
      retrySend({ type: 'openOptions' }, 1, function () { /* 打开结果无需反馈 */ });
    });

    plog('面板挂载完成（侧栏入口模式）');
    if (cfgCache && cfgCache.debug) console.log('[mneme/panel] 面板挂载完成（侧栏入口模式）');

  // ---- injected → content 导入事件分发（单 listener；imHandlers 为 var 函数级可见）----
  window.addEventListener('mneme-ext:event', function (e) {
    var d = e.detail || {};
    if (d.type === 'import-progress' && imHandlers && imHandlers.progress) imHandlers.progress(d);
    else if (d.type === 'list-progress' && imHandlers && imHandlers.listProgress) imHandlers.listProgress(d);
    else if (d.type === 'sessions-list' && imHandlers && imHandlers.sessionsList) imHandlers.sessionsList(d);
    else if (d.type === 'summaries-ready' && imHandlers && imHandlers.summariesReady) imHandlers.summariesReady(d);
    else if (d.type === 'funnel-done' && imHandlers && imHandlers.funnelDone) imHandlers.funnelDone(d);
    else if (d.type === 'import-done' && imHandlers && imHandlers.done) {
      var cb = imHandlers.done; imHandlers.done = null; imHandlers.progress = null; cb(d);
    }
  });

  // ---- bg 命令转发——injected(MAIN world) 无 chrome.runtime，
  // 经此监听器代发 chrome.runtime.sendMessage 并把结果经 'bg-result' 事件带回 ----
  window.addEventListener('mneme-ext:cmd', function (e) {
    var d = e.detail || {};
    if (d.type !== 'bg') return;
    if (d.nonce !== BG_NONCE) { if (cfgCache.debug) dbg('bg 命令 nonce 校验失败，丢弃'); return; }   // v0.6.1：握手校验
    var id = d.id;
    try {
      chrome.runtime.sendMessage(d.msg, function (r) {
        var err = chrome.runtime.lastError;
        window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'bg-result', id: id, r: err ? null : (r === undefined ? null : r) } }));
      });
    } catch (e2) {
      window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'bg-result', id: id, r: null } }));
    }
  });

  // ---- 系统设置弹层视觉探测（点开系统设置后 Console 执行）----
  // dump 容器/组件 computedStyle 关键值 → 照数据替换 style 数组里的 --mn-* token，
  // 完成「系统设置」弹层一比一复刻（复制视觉参数，不复制页面 class，防改版）。
  window.__MNEME_SETTINGS_PROBE2__ = function () {
    function pick(cs, keys) {
      var o = {};
      for (var i = 0; i < keys.length; i++) o[keys[i]] = cs[keys[i]];
      return o;
    }
    var out = { found: false, container: null, cards: [], rows: [], toggles: [], buttons: [], note: '请先点开「系统设置」弹层再执行；输出按 --mn-* token 对照替换' };
    var cands = document.querySelectorAll('div');
    var best = null, bestArea = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var r = el.getBoundingClientRect();
      if (r.width > 320 && r.height > 240 && r.width < window.innerWidth * 0.95) {
        if ((el.innerText || '').indexOf('系统设置') >= 0) {
          var area = r.width * r.height;
          if (area < bestArea) { best = el; bestArea = area; } // 取最内层命中
        }
      }
    }
    if (best) {
      out.found = true;
      var csB = window.getComputedStyle(best);
      var rb = best.getBoundingClientRect();
      out.container = {
        cls: String(best.className).slice(0, 100),
        rect: [Math.round(rb.width), Math.round(rb.height)],
        position: csB.position,
        style: pick(csB, ['borderRadius', 'backgroundColor', 'color', 'border', 'boxShadow', 'padding', 'fontFamily', 'fontSize', 'lineHeight']),
        centerOffset: [Math.round(rb.left + rb.width / 2 - window.innerWidth / 2), Math.round(rb.top + rb.height / 2 - window.innerHeight / 2)]
      };
      var scrimEl = null, anc = best.parentElement;
      for (var a = 0; a < 4 && anc; a++) {
        var csA = window.getComputedStyle(anc);
        if (csA.backgroundColor && csA.backgroundColor.indexOf('rgba') === 0 && parseFloat(csA.backgroundColor.split(',')[3]) > 0) { scrimEl = anc; break; }
        anc = anc.parentElement;
      }
      if (scrimEl) out.container.scrim = window.getComputedStyle(scrimEl).backgroundColor;
      var cards = best.querySelectorAll('[class*="card"],[class*="group"],[class*="section"],[class*="item"]');
      for (var c = 0; c < cards.length && out.cards.length < 3; c++) {
        var rc = cards[c].getBoundingClientRect();
        if (rc.width < 200) continue;
        out.cards.push({ cls: String(cards[c].className).slice(0, 80), style: pick(window.getComputedStyle(cards[c]), ['borderRadius', 'border', 'backgroundColor', 'padding', 'margin']) });
      }
      var rowsEls = best.querySelectorAll('[class*="row"],[class*="item"],[class*="option"]');
      for (var r2 = 0; r2 < rowsEls.length && out.rows.length < 3; r2++) {
        var rr = rowsEls[r2].getBoundingClientRect();
        if (rr.height < 28 || rr.height > 72) continue;
        out.rows.push({ cls: String(rowsEls[r2].className).slice(0, 80), style: pick(window.getComputedStyle(rowsEls[r2]), ['height', 'padding', 'fontSize', 'color', 'borderBottom', 'borderRadius']) });
      }
      var tgs = best.querySelectorAll('[class*="switch"],[class*="toggle"],[role="switch"],input[type="checkbox"]');
      for (var t = 0; t < tgs.length && out.toggles.length < 2; t++) {
        var tg = tgs[t];
        var target = (tg.tagName === 'INPUT') ? tg.parentElement : tg;
        var rt = target.getBoundingClientRect();
        var firstKid = target.querySelector('*');
        out.toggles.push({
          cls: String(target.className).slice(0, 80), rect: [Math.round(rt.width), Math.round(rt.height)],
          style: pick(window.getComputedStyle(target), ['borderRadius', 'backgroundColor', 'transition', 'width', 'height']),
          knob: firstKid ? pick(window.getComputedStyle(firstKid), ['width', 'height', 'backgroundColor', 'borderRadius']) : null
        });
      }
      var btnsEls = best.querySelectorAll('button');
      for (var b = 0; b < btnsEls.length && out.buttons.length < 3; b++) {
        var bt = btnsEls[b];
        out.buttons.push({ text: (bt.innerText || '').trim().slice(0, 12), cls: String(bt.className).slice(0, 80), style: pick(window.getComputedStyle(bt), ['backgroundColor', 'color', 'borderRadius', 'border', 'padding', 'fontSize']) });
      }
    }
    window.__MNEME_SETTINGS_PROBE2_LAST__ = out;
    console.log('[mneme/panel] 系统设置弹层探测:', JSON.stringify(out, null, 1).slice(0, 4000));
    return out;
  };
  // ---- DS 侧栏/设置弹层结构探测（Console 执行；锚点未命中时把输出发回来调阈值）----
  // 注意：此处位于 try 块外（strict 模式），不得引用块内函数（plog 等）——用 cfgCache 守卫。
  window.__MNEME_SIDEBAR_PROBE__ = function () {
    function s(v) { return String(v == null ? '' : v).slice(0, 100); }
    var out = { sidebarItems: [], modalCandidates: [], note: 'sidebarItems 取「行」级祖先结构；modalCandidates 为当前可见弹层的视觉 token' };
    var labels = ['系统设置', '帮助与反馈', '设置'];
    var all = document.querySelectorAll('aside *, nav *, [class*="sidebar" i] *, [class*="menu" i] *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 3) continue;
      var t = (el.innerText || '').trim();
      if (labels.indexOf(t) < 0) continue;
      var row = null, cur = el;
      for (var d = 0; d < 5 && cur; d++) {
        var rr = cur.getBoundingClientRect();
        if (rr.height >= 28 && rr.height <= 56 && rr.width > 60 && rr.width < 320) { row = cur; break; }
        cur = cur.parentElement;
      }
      var r = el.getBoundingClientRect();
      out.sidebarItems.push({
        text: t, tag: el.tagName, cls: s(el.className),
        parentCls: s(el.parentElement && el.parentElement.className),
        rowTag: row ? row.tagName : null, rowCls: row ? s(row.className) : null,
        rowHtml: row ? String(row.outerHTML).slice(0, 220) : null,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      });
    }
    var dlg = document.querySelectorAll('[class*="modal" i],[class*="dialog" i],[class*="drawer" i],[class*="setting" i]');
    var seen = 0;
    for (var j = 0; j < dlg.length && seen < 3; j++) {
      var dEl = dlg[j];
      var dr = dEl.getBoundingClientRect();
      if (dr.width < 200 || dr.height < 120) continue;
      var cs = window.getComputedStyle(dEl);
      out.modalCandidates.push({
        cls: s(dEl.className), rect: [Math.round(dr.width), Math.round(dr.height)],
        bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius,
        shadow: String(cs.boxShadow).slice(0, 80), font: cs.fontFamily.slice(0, 60), fontSize: cs.fontSize
      });
      seen++;
    }
    window.__MNEME_SIDEBAR_PROBE_LAST__ = out;
    console.log('[mneme/panel] 侧栏探测结果:', JSON.stringify(out, null, 1).slice(0, 3000));
    return out;
  };
  if (cfgCache && cfgCache.debug) console.log('[mneme/panel] 侧栏探测函数已挂 window.__MNEME_SIDEBAR_PROBE__()');
})();
