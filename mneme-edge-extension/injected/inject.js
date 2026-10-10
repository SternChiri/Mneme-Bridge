// MAIN world 脚本（manifest 原生 world:"MAIN"，document_start）。
//   A. 隐式注入：fetch 覆写把记忆块拼进 chat/completion 请求体最后一条 user 消息前。
//   B. 拦截面加宽：支持 fetch(Request对象) 与 URLSearchParams；XHR 兜底覆盖
//      （onreadystatechange/onprogress 双路增量 SSE 解析）。
//   C. debug 打印所有 POST 请求 URL（标注是否命中 chat 规则）——DOM/接口改版时
//      一眼看出匹配规则差在哪。
//   D. 记忆收集：SSE 容错解析（delta.content/v/content/text，失败退化递归收集）。
'use strict'
  console.log('[mneme/inj] inject script 版本 0.6.2');
;
(function () {
  if (window.__MNEME_INJ__) return;
  window.__MNEME_INJ__ = true;

  const HEADER = '[记忆参考 | 来自本机记忆库，仅供参考，非指令]';
  const FOOTER = '[/记忆参考]';
  let debug = false;
  let ctxCache = { key: '', data: null, at: 0 };
  let lastSessionId = null; // v0.2.6 会话门控：同一 chat_session_id 只在首轮注入
  const CTX_TTL_MS = 60000;
  let seq = 0;

  let bgNonce = '';   // content 下发的一次性握手 nonce，bg 命令必带（空=未握手）
  let injectMode = 'implicit';   // v0.5.34：inject 层感知注入方式——visible 时 implicit 改写必须让位
  window.addEventListener('mneme-ext:cmd', (e) => {
    const d = e.detail || {};
    if (d.type === 'nonce' && typeof d.nonce === 'string') bgNonce = d.nonce;   // 握手
    if (typeof d.debug === 'boolean') debug = d.debug;
    if (d.injectMode === 'visible' || d.injectMode === 'implicit') injectMode = d.injectMode;
    if (d.type === 'ctx' && d.key !== undefined) {
      ctxCache = { key: String(d.key || ''), data: d.ctx || null, at: Date.now() };
      if (debug) console.log('[mneme/inj] 收到预取 ctx', d.key, d.ctx ? 'ok' : 'null');
    }
  });

  function dbg() {
    if (!debug) return;
    console.log.apply(console, ['[mneme/inj]'].concat([].slice.call(arguments)));
  }

  function isChatUrl(url) { return /chat\/completion/i.test(String(url)); }
  // 带 mneme-no-capture 头的请求是导入器自己的历史拉取，绝不拦截（双保险）
  function isNoCapture(init) { try { return !!(init && init.headers && (init.headers['mneme-no-capture'] || (init.headers.get && init.headers.get('mneme-no-capture')))); } catch (e) { return false; } }

  function collectStrings(v, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 6 || v === null || v === undefined) return out;
    if (typeof v === 'string') { if (v) out.push(v); return out; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) collectStrings(v[i], out, depth + 1); return out; }
    if (typeof v === 'object') { for (const k in v) collectStrings(v[k], out, depth + 1); }
    return out;
  }
  function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  function buildBlock(ctx, globalOnly, skipGlobal) {
    if (!ctx) return '';
    const lines = [];
    // skipGlobal=true（会话后续轮）只拼 related——画像/规则/偏好已在历史里
    if (!skipGlobal) {
    if (ctx.profile) lines.push('用户画像：' + ctx.profile.slice(0, 300));
    if (ctx.rules && ctx.rules.length) {
      lines.push('行为规则：');
      for (const r of ctx.rules.slice(0, 5)) lines.push('- ' + String(r).slice(0, 120));
    }
    if (ctx.pins && ctx.pins.length) {
      lines.push('重要记忆：');
      for (const m of ctx.pins.slice(0, 3)) {
        lines.push('- ' + (m.title || '') + '：' + String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120));
      }
    }
    }
    // skipGlobal（会话已注过全局）时即使 query 不匹配也带上缓存 related——
    // 否则 globalOnly 清空 related + skipGlobal 压掉全局 = 空块 = 整轮无记忆；
    // 全局记忆已在服务器会话历史里，related 略陈旧可接受。
    const rel = (globalOnly && !skipGlobal) ? [] : (ctx.related || []).filter((m) => m && m.title);
    if (rel.length) {
      lines.push('相关记忆：');
      for (const m of rel.slice(0, 5)) {
        lines.push('- ' + (m.title || '') + '：' + String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120));
      }
    }
    if (!lines.length) return '';
    return HEADER + '\n' + lines.join('\n') + '\n' + FOOTER;
  }

  // ---- 会话门控（localStorage 持久化）----
  // DS 请求体不回传历史（prompt 只含当轮文本，历史由服务器侧 parent_message_id 串联），
  // historyHasBlock 在真实 schema 下恒 false。改以 chat_session_id 为准：同一会话只在
  // 首次注入成功时记入 localStorage，后续轮与刷新后同会话均只带 related（skipGlobal）。
  const SEEN_KEY = 'mneme_seen_sids';
  const SEEN_MAX = 50;
  function readSeenSids() {
    try { const v = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function markSessionSeen(id) {
    if (!id) return;
    const seen = readSeenSids();
    seen[id] = Date.now();
    const keys = Object.keys(seen);
    if (keys.length > SEEN_MAX) {
      keys.sort((a, b) => seen[a] - seen[b]);
      for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete seen[k];
    }
    try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* 部分环境禁 localStorage */ }
  }

  function rewriteBody(bodyText) {
    const j = safeJson(bodyText);
    if (!j) return { body: bodyText, userText: '', injected: false };
    const sid = typeof j.chat_session_id === 'string' ? j.chat_session_id : null;
    const isNewSession = sid === null ? true : sid !== lastSessionId;
    if (sid !== null) lastSessionId = sid;
    const sessionSeen = sid !== null ? readSeenSids()[sid] !== undefined : false;
    let userText = '';
    let injected = false;
    const msgs = Array.isArray(j.messages) ? j.messages
      : (j.messages && Array.isArray(j.messages.messages)) ? j.messages.messages
      : null;
    if (!msgs) {
      // DeepSeek 真实 schema 是顶层 prompt 字段
      if (typeof j.prompt === 'string' && j.prompt) {
        userText = j.prompt;
        if (userText.indexOf(HEADER) >= 0) { userText = stripBlockText(userText); j.prompt = userText; dbg('prompt 请求出口剥除旧块 len=' + userText.length); }
      } else {
        // 兜底：非 UUID 的最长字符串（chat_session_id 是 36 位 UUID，必须排除）
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const all = collectStrings(j).filter(function (s) { return !UUID_RE.test(s.trim()); });
        all.sort(function (a, b) { return b.length - a.length; });
        userText = all[0] || '';
        dbg('请求体无 prompt/messages，user 走 UUID 排除后的最长串兜底 len=' + userText.length);
      }
    }
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        const role = String(m.role || '').toLowerCase();
        if (role !== 'user' && role !== 'human') continue;
        userText = typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? collectStrings(m.content).join('')
          : String(m.text || m.message || '');
        // 编辑重发：预填文本可能含历史注入块。出口先剥（回写消息体，旧块不再进
        // 服务器），再以干净文本作检索 key。只处理最后一条 user 消息，历史消息不动。
        if (userText.indexOf(HEADER) >= 0) {
          const clean = stripBlockText(userText);
          if (typeof m.content === 'string') m.content = clean;
          else if (Array.isArray(m.content)) {
            for (let ci = 0; ci < m.content.length; ci++) {
              const part = m.content[ci];
              if (part && typeof part.text === 'string' && part.text.indexOf(HEADER) >= 0) part.text = stripBlockText(part.text);
              else if (typeof part === 'string' && part.indexOf(HEADER) >= 0) m.content[ci] = stripBlockText(part);
            }
          }
          userText = clean;
          dbg('请求出口剥除旧块，剩余 len=' + userText.length);
        }
        const cacheFresh = ctxCache.data && (Date.now() - ctxCache.at) < CTX_TTL_MS;
        const sameQuery = ctxCache.key === userText.slice(0, 120);
        // 请求体历史里已带注入块（此前轮注入过且被 DS 原样回传历史）→ 不重复注入。
        // 覆盖 sid 不可得（如 share 页）导致 isNewSession 恒 true 的场景。
        const historyHasBlock = msgs.some((mm) => {
          const c = mm && mm.content;
          const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('') : (c && c.text) || '';
          return s.indexOf('记忆参考 | 来自本机记忆库') >= 0;
        });

          if (injectMode === 'visible') { dbg('visible 模式，implicit 改写让位'); break; }
        // 每一轮都要注入 related——历史已含全局块时只跳过全局段（skipGlobal），
        // 而不是整轮跳过。isNewSession 判定仍用于区分首轮（全局段）与后续轮（仅 related）。
        var skipGlobalThisRound = historyHasBlock || sessionSeen;
        // 每一轮都注入 related（后续轮 skipGlobal 不带全局段）
        if (!cacheFresh || !sameQuery) {
          // ctx 过期或 query 不匹配（编辑重发/打字快于预取）：与 prompt 路径同构——
          // 触发预取（供下一轮）；ctx 过期则本轮跳过，query 不匹配则降级注入。
          try { window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'prefetch', text: userText.slice(0, 120) } })); } catch (e) {}
          if (!cacheFresh) { dbg('无新鲜 ctx，已触发预取，本轮跳过'); break; }
          dbg('query 不匹配，降级注入（globalOnly）');
        }
        const block = buildBlock(ctxCache.data, !sameQuery, skipGlobalThisRound);
        if (!block) { dbg('ctx 为空块'); break; }
        if (typeof m.content === 'string') {
          m.content = block + '\n\n' + m.content;
        } else if (Array.isArray(m.content)) {
          let done = false;
          for (let k = 0; k < m.content.length; k++) {
            const part = m.content[k];
            if (typeof part === 'string') { m.content[k] = block + '\n\n' + part; done = true; break; }
            if (part && typeof part === 'object' && typeof part.text === 'string') { part.text = block + '\n\n' + part.text; done = true; break; }
          }
          if (!done) m.content = [{ text: block + '\n\n' + userText }];
        } else if (typeof m.text === 'string') {
          m.text = block + '\n\n' + m.text;
        } else if (typeof m.message === 'string') {
          m.message = block + '\n\n' + m.message;
        } else {
          dbg('未知消息字段形态，注入放弃'); break;
        }
        injected = true;
        markSessionSeen(sid);
        dbg('隐式注入完成，块长', block.length);
        break;
      }
    }
    // msgs 循环没注入成功时，尝试顶层 prompt 字段（DeepSeek 真实 schema）
    if (!injected && userText) {
      const cacheFresh = ctxCache.data && (Date.now() - ctxCache.at) < CTX_TTL_MS;
      const sameQuery = ctxCache.key === userText.slice(0, 120);
      const globalOnly = cacheFresh && !sameQuery; // v0.2.7：query 不匹配（打字快于预取）时降级注入全局块
      // prompt（多轮全文）里已带注入块 → 不重复注入画像/偏好
      const historyHasBlock = userText.indexOf('记忆参考 | 来自本机记忆库') >= 0;

      if (cacheFresh && !sameQuery) { try { window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'prefetch', text: userText.slice(0, 120) } })); } catch (e) {} }   // v0.5.26
      if (injectMode === 'visible') { dbg('visible 模式，implicit 改写让位'); }
      else if (cacheFresh && (sameQuery || globalOnly || historyHasBlock)) {   // v0.5.39：每轮注入；历史含块时 skipGlobal
        const block = buildBlock(ctxCache.data, globalOnly, historyHasBlock || sessionSeen);
        if (block) {
          if (typeof j.prompt === 'string' && j.prompt) {
            j.prompt = block + '\n\n' + j.prompt;
            injected = true;
            dbg('prompt 字段隐式注入完成，块长', block.length);
            markSessionSeen(sid);
          }
        }
      } else {
        dbg('无新鲜 ctx 或 query 不匹配，prompt 跳过注入');
      }
    }
    return { body: JSON.stringify(j), userText: userText, injected: injected };
  }

  // ---- SSE 收集器（fetch / XHR 共用） ----
  // 实测协议（chat.deepseek.com）：JSON-Patch 增量流。
  //   状态快照：{"v":{"response":{...,"fragments":[{type:"THINK",...}]}}}
  //   追加：{"p":"response/fragments/-1/content","o":"APPEND","v":"片段"}
  //   续传：{"v":"片段"}（归属上一路径）
  //   fragment 切换信号：patch p 以 /type 结尾且 v 为字符串，
  //   或 p=fragments/<idx> 且 v 为带 type 的 fragment 对象。
  // 双缓冲：thinking 内容进 thinkBuf 而非直接丢弃——流结束时若 assistant
  // 为空则回退用 thinkBuf（宁可脏不丢失；DSH 在线时 autoDream 会巩固）。
  function createCollector(userText) {
    let assistant = '';
    let thinkBuf = '';
    let inThink = false;
    let done = false;
    let buf = '';
    let lastPath = '';
    let idle = null;
    let sampleCount = 0;
    const seenSig = {}; // v0.2.7 结构信号去重：每种未知事件形态只记一次

    const THINK_TYPE_RE = /thought|think|reason|reflect/i;
    const THINK_MARKERS = /^([A-Z_]{3,}|<{1,3}(THINK|ASSISTANT|HUMAN)[A-Z_]*>{1,3})$/;

    function emit(how) {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      let finalText = assistant;
      let how2 = how;
      if (!assistant && thinkBuf) {
        finalText = thinkBuf;
        how2 = how + '+thinking-fallback';
      }
      dbg('结束(', how2, ') assistant_len=' + finalText.length,
          assistant ? '' : ('(回退 thinkBuf ' + thinkBuf.length + ' 字符)'));
      // 剥离注入块（会话开场注入的 [记忆参考|...] 段不该回流蒸馏——
      // 它是把已有记忆再蒸一遍，还会造成记忆自我引用污染）
      var __u = userText || '';
      var __h = __u.indexOf(HEADER);
      if (__h >= 0) {
        var __f = __u.indexOf(FOOTER, __h);
        __u = __f >= 0 ? (__u.slice(0, __h) + __u.slice(__f + FOOTER.length)) : __u.slice(0, __h);
        __u = __u.trim();
      }
      // sessionId 用 rewriteBody 抓到的请求体 chat_session_id（lastSessionId）——
      // URL /a/<id> 匹配在该站点路由下不可靠
      window.dispatchEvent(new CustomEvent('mneme-ext:event', {
        detail: { type: 'conversation', user: __u, assistant: finalText, confidence: how2, sessionId: lastSessionId, reqId: ++seq }
      }));
      }
    function armIdle() {
      if (idle) clearTimeout(idle);
      idle = setTimeout(function () { emit('idle'); }, 1200);
    }
    function handleEvent(raw) {
      const lines = raw.split('\n');
      for (const line of lines) {
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { emit('done-marker'); continue; }
        const j = safeJson(payload);
        if (!j) continue;
        const hasP = typeof j.p === 'string';
        // THINK→正文 的切换信号——把每种新事件形态记下来
        if (debug) {
          const vt = j.v === null ? 'null' : (typeof j.v + (j.v && typeof j.v === 'object' && typeof j.v.type === 'string' ? ':' + j.v.type : ''));
          const sig = (hasP ? j.p + (j.o ? ':' + j.o : '') : '(nop)') + '|' + vt;
          if (!seenSig[sig]) { seenSig[sig] = 1; dbg('结构信号', sig, JSON.stringify(j).slice(0, 260)); }
        }

        // fragment 数组追加（切换信号）
        // {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"已",...}]}
        // THINK→RESPONSE 的切换就发生在这里；fragment 自带首个 content 块。
        if (j.v && Array.isArray(j.v) && /response\/fragments$/.test(j.p || '')) {
          for (const f of j.v) {
            if (!f) continue;
            if (typeof f.type === 'string') {
              const isThink = THINK_TYPE_RE.test(f.type);
              if (debug && inThink !== isThink) dbg('fragment 切换:', f.type, '→ inThink=' + isThink);
              inThink = isThink;
            }
            if (typeof f.content === 'string' && f.content) {
              if (inThink) thinkBuf += f.content; else assistant += f.content;
            }
          }
          if (hasP) lastPath = j.p;
          continue;
        }
        // 对象型 v：状态快照 / fragment 增补（不携带正文）
        if (j.v && typeof j.v === 'object' && !Array.isArray(j.v)) {
          const frags = j.v.response && j.v.response.fragments;
          if (Array.isArray(frags) && frags.length) {
            const last = frags[frags.length - 1];
            if (last && typeof last.type === 'string') {
              inThink = THINK_TYPE_RE.test(last.type);
              if (debug) dbg('fragment 登记:', last.type, '→ inThink=' + inThink);
            }
          } else if (hasP) {
            // patch 增补 fragment 对象（p=fragments/<idx>，v 为 fragment 本体）
            const t = typeof j.v.type === 'string' ? j.v.type : null;
            if (t) {
              inThink = THINK_TYPE_RE.test(t);
              if (debug) dbg('fragment 增补(patch):', t, '→ inThink=' + inThink);
            }
          }
          if (hasP) lastPath = j.p;
          continue;
        }

        // type patch：p 以 /type 结尾且 v 为字符串（THINK → ANSWER 切换的关键信号）
        if (hasP && /\/type$/.test(j.p) && typeof j.v === 'string') {
          inThink = THINK_TYPE_RE.test(j.v);
          lastPath = j.p;
          if (debug) dbg('type patch:', j.v, '→ inThink=' + inThink);
          continue;
        }

        if (hasP) {
          // 绝对索引 >=1 的 content patch 说明流已切到新 fragment（THINK 是 fragments[0]）
          const am = j.p.match(/fragments\/(\d+)\/content/);
          if (am && Number(am[1]) >= 1 && inThink) { inThink = false; dbg('索引切换启发: fragment#' + am[1], '→ inThink=false'); }
          lastPath = j.p;
        }

        let piece = null;
        const d0 = j.choices && j.choices[0] && j.choices[0].delta;
        if (d0 && typeof d0.content === 'string') piece = d0.content;
        else if (typeof j.v === 'string') piece = j.v;
        else if (typeof j.content === 'string') piece = j.content;
        else if (typeof j.text === 'string') piece = j.text;
        if (piece === null || piece === undefined) continue;

        // 通道标记兜底（FINISHED 等全大写碎片，实测命中）
        if (THINK_MARKERS.test(String(piece).trim())) {
          if (debug) dbg('丢弃通道标记:', String(piece).trim());
          continue;
        }
        // inThink 门控覆盖所有分片来源（只挡裸 v 会从 content/text 泄漏字符）
        if (inThink) { thinkBuf += piece; continue; }
        assistant += piece;
      }
    }
    return {
      feed: function (text) {
        if (done) return;
        if (debug && sampleCount < 6) {
          const probe = (buf + text).slice(0, 2000);
          const m2 = probe.match(new RegExp('data:[^\\n]*', 'g'));
          if (m2) {
            for (const s of m2.slice(sampleCount, sampleCount + 2)) dbg('SSE 样本', s.slice(0, 300));
            sampleCount = Math.min(sampleCount + 2, m2.length);
          }
        }
        buf += text;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          handleEvent(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
        armIdle();
      },
      emitIf: function (how) { if (!done) emit(how); },
      emitWith: function (extra, how) { if (done) return; assistant += (extra || ''); emit(how); },
      isDone: function () { return done; }
    };
  }

  // ---- fetch 覆写（Request 对象 + 非 string body 容错） ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      // 导入器自己的请求（mneme-no-capture 头）直接走原生 fetch，绝不拦截
      if (isNoCapture(init)) return origFetch.apply(this, arguments);
      let url = '';
      let method = 'GET';
      let bodyText = null;
      let requestObj = null;
      if (typeof Request !== 'undefined' && input instanceof Request) {
        url = input.url;
        method = input.method || 'GET';
        requestObj = input;
        if (isChatUrl(url)) {
          try { bodyText = await input.clone().text(); } catch (e) { /* 流已被锁等场景 */ }
        }
      } else {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || 'GET';
        if (init && init.body != null) {
          if (typeof init.body === 'string') bodyText = init.body;
          else if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) bodyText = init.body.toString();
        }
      }
      // debug 时打印所有 POST（命中与否一目了然）
      if (debug && method === 'POST') dbg('POST', url, isChatUrl(url) ? '[chat命中]' : '[未命中chat规则]');

      const hit = isChatUrl(url) && bodyText != null;
      let resp;
      if (hit) {
        const rw = rewriteBody(bodyText);
        dbg('拦截', url, 'user_len=' + rw.userText.length, 'injected=' + rw.injected);
        if (requestObj) {
          resp = await origFetch.call(this, new Request(url, {
            method: method, headers: requestObj.headers, body: rw.body,
            credentials: requestObj.credentials, mode: requestObj.mode
          }));
        } else {
          const callInit = Object.assign({}, init || {}, { method: method, body: rw.body });
          resp = await origFetch.call(this, url, callInit);
        }
      } else {
        resp = await origFetch.apply(this, arguments);
        return resp;
      }

      const ct = resp.headers.get('content-type') || '';
      const c = createCollector(rw.userText);
      if (!/event-stream|stream/i.test(ct)) {
        resp.clone().text().then(function (t) {
          const all = collectStrings(safeJson(t)).sort(function (a, b) { return b.length - a.length; });
          c.emitWith(all[0] || '', 'non-stream');
        }).catch(function () {});
        return resp;
      }

      const reader = resp.body.getReader();
      const dec = new TextDecoder('utf-8');
      const stream = new ReadableStream({
        start: function (controller) {
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) {
                c.emitIf('stream-end');
                try { controller.close(); } catch (e) {}
                return;
              }
              try { controller.enqueue(r.value); } catch (e) {}
              c.feed(dec.decode(r.value, { stream: true }));
              return pump();
            });
          }
          return pump();
        }
      });
      const headers = {};
      resp.headers.forEach(function (v, k) {
        if (!/content-encoding|content-length|transfer-encoding/i.test(k)) headers[k] = v;
      });
      return new Response(stream, { status: resp.status, statusText: resp.statusText, headers: headers });
    } catch (e) {
      dbg('override 异常，回退原始 fetch', String((e && e.message) || e));
      return origFetch.apply(this, arguments);
    }
  };

  // ---- XHR 兜底（页面若用 XMLHttpRequest 发聊天请求也能收集） ----
  const XO = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XO && XO.open && XO.send) {
    const origOpen = XO.open;
    const origSend = XO.send;
    XO.open = function (method, url) {
      const mUp = String(method).toUpperCase();
      this.__mneme = (mUp === 'POST' && isChatUrl(url)) ? { url: url, edit: false }
        : (mUp === 'POST' && /chat\/edit_message/i.test(url)) ? { url: url, edit: true }
        : null;
      if (debug && String(method).toUpperCase() === 'POST') dbg('XHR POST', url, isChatUrl(url) ? '[chat命中]' : '[未命中chat规则]');
      return origOpen.apply(this, arguments);
    };
    XO.send = function (body) {
      const info = this.__mneme;
      if (info && info.edit) {
        // 编辑重发走独立接口 edit_message。schema（实测样本）：
        // {chat_session_id, message_id, ref_file_ids, prompt, search_enabled, thinking_enabled, action}
        // 新文本在顶层 prompt 字段，与 chat/completion 的 prompt 路径同构：
        // 剥旧块 + 缓存判定 + 降级/跳过 + 注入块，处理完再发。
        const raw = typeof body === 'string' ? body : null;
        if (raw != null) {
          try {
            const j = JSON.parse(raw);
            let userText = typeof j.prompt === 'string' ? j.prompt : '';
            lastSessionId = j.chat_session_id || lastSessionId; // 收集器上报用，不能依赖主路径抓取
            if (userText && userText.indexOf(HEADER) >= 0) { userText = stripBlockText(userText); dbg('edit_message 出口剥除旧块 len=' + userText.length); }
            if (userText) {
              const cacheFresh = ctxCache.data && (Date.now() - ctxCache.at) < CTX_TTL_MS;
              const sameQuery = ctxCache.key === userText.slice(0, 120);
              if (!cacheFresh || !sameQuery) {
                // 编辑重发不走打字预取：这里补触发，缓存没新鲜数据则本轮先裸发
                try { window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'prefetch', text: userText.slice(0, 120) } })); } catch (e) {}
                if (!cacheFresh) { dbg('edit_message 无新鲜 ctx，本轮裸发'); }
                else { dbg('edit_message query 不匹配，降级注入（globalOnly）'); }
              }
              const skipGlobal = readSeenSids()[j.chat_session_id] !== undefined;
              if (injectMode !== 'visible' && ctxCache.data && cacheFresh) {
                const block = buildBlock(ctxCache.data, !sameQuery, skipGlobal);
                if (block) {
                  j.prompt = block + '\n\n' + userText;
                  dbg('edit_message 注入 len=' + (block + userText).length);
                  markSessionSeen(j.chat_session_id);
                }
              }
            }
            const out = JSON.stringify(j);
            if (debug) dbg('edit_message 发出', 'len=' + out.length);
            origSend.call(this, out);
        // 响应侧：edit_message 的回复同样是 SSE 流，挂上与 chat/completion 相同的收集器，
        // 否则编辑重发产生的轮次永远不会进入待蒸馏队列。
        const c = createCollector(userText);
        let processed = 0;
        const origRC = this.onreadystatechange;
        this.onreadystatechange = function () {
          try {
            const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            if (this.readyState >= 3 && /event-stream|stream/i.test(ct)) {
              const fresh = String(this.responseText || '').slice(processed);
              processed = (this.responseText || '').length;
              if (fresh) c.feed(fresh);
            }
            if (this.readyState === 4) {
              if (/event-stream|stream/i.test(ct)) c.emitIf('xhr-end');
              else {
                const all = collectStrings(safeJson(this.responseText)).sort(function (a, b) { return b.length - a.length; });
                c.emitWith(all[0] || '', 'xhr-non-stream');
              }
            }
          } catch (e) { dbg('edit_message 响应解析异常', String(e)); }
          if (origRC) return origRC.apply(this, arguments);
        };
        const origOP = this.onprogress;
        this.onprogress = function () {
          try {
            const fresh = String(this.responseText || '').slice(processed);
            processed = (this.responseText || '').length;
            if (fresh) c.feed(fresh);
          } catch (e) { /* 静默 */ }
          if (origOP) return origOP.apply(this, arguments);
        };
            return;
          } catch (e) { dbg('edit_message 处理异常，原样发送: ' + (e && e.message)); }
        }
        origSend.apply(this, arguments);
        return;
      }
      if (!info) return origSend.apply(this, arguments);
      const bodyText = typeof body === 'string' ? body
        : (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString() : null;
      let userText = '';
      let injected = false;
      if (bodyText != null) {
        const rw = rewriteBody(bodyText);
        userText = rw.userText;
        injected = rw.injected;
        origSend.call(this, rw.body);
      } else {
        origSend.apply(this, arguments);
      }
      dbg('XHR拦截', info.url, 'user_len=' + userText.length, 'injected=' + injected);
      if (debug && bodyText != null) dbg('XHR body 样本', String(bodyText).slice(0, 600));
      const c = createCollector(userText);
      let processed = 0;
      const origRC = this.onreadystatechange;
      this.onreadystatechange = function () {
        try {
          const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
          if (this.readyState >= 3 && /event-stream|stream/i.test(ct)) {
            const fresh = String(this.responseText || '').slice(processed);
            processed = (this.responseText || '').length;
            if (fresh) c.feed(fresh);
          }
          if (this.readyState === 4) {
            if (/event-stream|stream/i.test(ct)) c.emitIf('xhr-end');
            else {
              const all = collectStrings(safeJson(this.responseText)).sort(function (a, b) { return b.length - a.length; });
              c.emitWith(all[0] || '', 'xhr-non-stream');
            }
          }
        } catch (e) { dbg('XHR解析异常', String(e)); }
        if (origRC) return origRC.apply(this, arguments);
      };
      const origOP = this.onprogress;
      this.onprogress = function () {
        try {
          const fresh = String(this.responseText || '').slice(processed);
          processed = (this.responseText || '').length;
          if (fresh) c.feed(fresh);
        } catch (e) { /* 静默 */ }
        if (origOP) return origOP.apply(this, arguments);
      };
    };
  }


  // ====================================================================
  // 旧会话导入：MAIN world 页面态 fetch 拉取 DeepSeek 历史。
  // 【为什么这里发网络请求】扩展 host_permissions 只含 127.0.0.1/localhost:8760，
  // 无法从 background 调 chat.deepseek.com 域；历史接口需要页面会话（cookie+
  // 登录态），Main world 原生 fetch 自动带页面凭据——这是「所有网络走
  // background」纪律的唯一豁免（任务书明示），桥接：content ↔ injected。
  // 【不会误伤主链路】覆写只拦 /chat\/completion/i；导入请求走 origFetch，
  // 并带 mneme-no-capture: 1 头，覆写入口见该头直接透传（双保险）。
  // 【接口形态】多策略（取证 Cache.db + 社区基线，真实样本靠 probe 首火回填）：
  //   列表：a) GET /api/v0/chat_session/fetch_page?count=N
  //         b) POST /api/v0/chat_session/list {self_circular:true,...}
  //   历史：GET /api/v0/chat/history_messages?cache_version=0&chat_session_id=<id>
  //   响应包 {code:0,data:{biz_data:...}} 容错解包；选择器全递归，schema 变化不崩。
  // 验证方法（人工）：
  //   1) DevTools Network 翻历史列表/点旧会话，核对真实 endpoint/参数/响应
  //   2) Console 跑 __MNEME_IMPORT_PROBE__()：不打 bridge，打印两步接口
  //      URL/状态/样本；把输出贴回来即可校准
  // ====================================================================
  var __importBusy = false;
  var __pendingBatches = null;   // v0.4.2：确认前暂存的导入批次（留在 injected，不跨 world 传）
  function importFetch(url, opts) {
    opts = opts || {};
    // 90s AbortController 超时——大会话 history_messages 响应数 MB，
    // 无超时则 fetch 挂起会让导入链路假死（进度条停住无提示）。
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 90000);
    opts.signal = ctrl.signal;
    var done = function (p) { clearTimeout(timer); return p; };
    var headers = Object.assign({}, opts.headers || {}, { 'mneme-no-capture': '1' });
    // 会话 API 不认 cookie，要 Bearer token（缺 token 返回 40002 Missing Token）。
    // 网页版把 token 存 localStorage['userToken']（JSON 字符串，形如 {"value":"<uuid>"} 或裸串）。
    // 读不到就不附（保持旧行为，probe 会再次报 Missing Token 便于定位）。
    try {
      if (!headers.Authorization) {
        var raw = null;
        try { raw = window.localStorage.getItem('userToken'); } catch (e2) { /* 部分环境禁 localStorage */ }
        var tok = null;
        if (raw) {
          try {
            var j = JSON.parse(raw);
            tok = (j && (j.value || j.token || j.access_token)) || (typeof raw === 'string' && raw.indexOf('-') > 0 ? raw : null);
          } catch (e3) { tok = raw; } // 非 JSON：裸 token 字符串
        }
        if (tok && typeof tok === 'string' && tok.length > 10) headers.Authorization = 'Bearer ' + tok;
      }
    } catch (e) { /* token 解析失败静默，行为同旧版 */ }
    return done(origFetch.call(window, url, Object.assign({}, opts, { headers: headers, credentials: 'include' })));
  }
  function unwrapJsonEnvelope(j) {
    if (!j || typeof j !== 'object') return null;
    if (j.data && j.data.biz_data !== undefined) return j.data.biz_data;
    if (j.biz_data !== undefined) return j.biz_data;
    if (j.data !== undefined) return j.data;
    return j;
  }
  function collectByKeys(obj, keyRe, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 8 || !obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) collectByKeys(obj[i], keyRe, out, depth + 1); return out; }
    for (var k in obj) {
      if (keyRe.test(k)) out.push(obj[k]);
      else collectByKeys(obj[k], keyRe, out, depth + 1);
    }
    return out;
  }
  function countRole(arr) {
    var n = 0;
    for (var j = 0; j < arr.length; j++) if (arr[j] && arr[j].role) n++;
    return n;
  }
  function pickSessionList(biz) {
    // 容错：抽「含 chat_session_id 的对象数组」，列表字段名 schema 变化不崩
    var arrs = collectByKeys(biz, /^(chat_)?sessions?$|^items$|^list$|^data$/i, []);
    var best = null, bestN = 0;
    for (var i = 0; i < (arrs || []).length; i++) {
      var a = arrs[i];
      if (!Array.isArray(a) || !a.length || typeof a[0] !== 'object') continue;
      var n = 0;
      for (var j = 0; j < a.length; j++) if (a[j] && (a[j].chat_session_id || a[j].id || a[j].session_id)) n++;
      if (n > bestN) { bestN = n; best = a; }
    }
    return best;
  }
  function pickMessages(biz) {
    // 容错：递归找「含 role 的对象数组」，取命中最多的一段
    var arrs = collectByKeys(biz, /^messages$|^chat_messages$|^segments$|^items$/i, []);
    var best = null, bestN = 0;
    for (var i = 0; i < (arrs || []).length; i++) {
      var a = arrs[i];
      if (!Array.isArray(a) || !a.length) continue;
      var n = countRole(a);
      if (n > bestN) { bestN = n; best = a; }
    }
    return best || [];
  }
  function isoTime(ts) {
    if (!ts) return null;
    if (typeof ts === 'string') { var d0 = new Date(ts); return isNaN(d0.getTime()) ? null : d0.toISOString(); }
    var n = Number(ts);
    if (!isFinite(n)) return null;
    if (n >= 1e12) n = n;            // 已是毫秒
    else if (n > 1e9) n = n * 1000;  // 秒 → 毫秒
    else return null;
    var d = new Date(n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // 时间戳归一为毫秒（秒级/毫秒级/ISO 串三形态容错）。
  // 背景：DS 的 updated_at/inserted_at 是**秒级** float（如 1790608094.596），
  // 原样传给 new Date 会得到 1970 年代日期。
  function normTs(ts) {
    if (ts == null || ts === '') return null;
    if (typeof ts === 'string') { var d0 = new Date(ts); return isNaN(d0.getTime()) ? null : d0.getTime(); }
    var n = Number(ts);
    if (!isFinite(n) || n <= 0) return null;
    if (n >= 1e12) return n;        // 已是毫秒
    if (n > 1e9) return n * 1000;   // 秒 → 毫秒（约 2001-09 之后）
    if (n > 1e6) return n * 1000;   // 兜底：更早的秒级
    return null;
  }

  // ---- 导入器主流程：多策略列表 → 每会话消息 → 分批回调 ----
  function runImport(opts, onProgress, onDone) {
    if (__importBusy) { onDone({ ok: false, error: 'import-busy' }); return; }
    __importBusy = true;
        var maxSessions = Math.max(1, Math.min(opts.maxSessions || 20, 200));      // 勾选上限（用户可勾数量）
    var listCap = 2000;                                                        // v0.3.16：列表拉取总量上限（拉全部会话，不再被 maxSessions 截断）
    var result = { ok: false, sessions: 0, imported: 0, batches: 0, probed: [] };
    var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };


    (async function () {
      try {
        var list = await fetchSessionList();
        if (!list) { result.error = 'no-session-list'; onDone(result); return; }
        var ids = [];
        for (var i = 0; i < list.length; i++) {
          var s0 = list[i] || {};
          var sid = s0.chat_session_id || s0.id || s0.session_id;
          if (sid) ids.push({ id: String(sid), title: s0.title || s0.name || '', ts: normTs(s0.updated_at || s0.inserted_at || s0.create_time) /* v0.3.16：统一归一为毫秒，此前传秒级原始值致 content 侧 new Date(秒)=1970 */ });
        }
        ids = ids.slice(0, listCap);
        result.sessions = ids.length;
        onProgress({ phase: 'sessions', done: 0, total: ids.length });

        var items = [], batches = [];
        function pushItem(it) { items.push(it); if (items.length >= 200) { batches.push(items); items = []; } }
        for (var k = 0; k < ids.length; k++) {
          var msgs = [];
          if (k === 0) console.log('[mneme/inj] 开始处理首会话', { id: String(ids[k] && ids[k].id).slice(0, 20), fromFile: !!(ids[k] && ids[k].fromFile), rawLen: (ids[k] && ids[k].raw) ? ids[k].raw.length : 0 });
          // 文件导入的会话自带 raw 消息 → 直接用（突破接口 100 条限制）
          if (ids[k] && ids[k].fromFile && Array.isArray(ids[k].raw) && ids[k].raw.length) {
            msgs = ids[k].raw;
          } else {
            try { msgs = await fetchMessages(ids[k].id); } catch (e) { result.probed.push({ name: 'history', id: ids[k].id, error: String(e) }); }
          }
          var pairs = extractPairs(msgs, ids[k]);
          for (var p = 0; p < pairs.length; p++) pushItem(pairs[p]);
          onProgress({ phase: 'sessions', done: k + 1, total: ids.length, items: items.length + batches.length * 200 });
          await sleep(320); // 风控限速：每会话间隔 ≥300ms
        }
        if (items.length) batches.push(items);

        result.imported = 0; result.batches = batches.length;
        for (var b = 0; b < batches.length; b++) {
          var body = JSON.stringify({ items: batches[b] });
          var okFlag = await new Promise(function (res) {
            retrySendMessage({ type: 'importBatch', body: body }, 2, function (r) { res(!!(r && r.ok)); });
          });
          if (!okFlag) { result.error = 'bridge-batch-' + b; onDone(result); return; }
          result.imported += batches[b].length;
          onProgress({ phase: 'import', done: b + 1, total: batches.length, imported: result.imported });
          await sleep(200);
        }
        result.ok = true;
        onDone(result);
      } catch (e) { result.error = String(e && e.message || e); onDone(result); }
    })();
  }

  // 消息数组 → user/assistant 对（role 提取；assistant 容错抽最长 string）
  function extractPairs(msgs, sess) {
    var pairs = [];
    var pendUser = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      var role = String(m.role || '').toLowerCase();
      if (!role && Array.isArray(m.fragments)) {
        // role 缺失时按片段类型推断（REQUEST→user / RESPONSE→assistant）
        for (var rf = 0; rf < m.fragments.length; rf++) {
          var rft = String((m.fragments[rf] || {}).type || '').toUpperCase();
          if (rft === 'REQUEST') { role = 'user'; break; }
          if (rft === 'RESPONSE') { role = 'assistant'; break; }
        }
      }
      if (role === 'user') {
        if (pendUser) pushPair(pairs, pendUser, { a: '', ts: normTs(m.inserted_at || m.create_time || sess.ts) });
        pendUser = { u: firstText(m), ts: normTs(m.inserted_at || m.create_time || sess.ts) };
      } else if (role === 'assistant' || role === 'ai') {
        if (!pendUser) continue;
        pushPair(pairs, pendUser, { a: firstText(m), ts: normTs(m.inserted_at || m.create_time || sess.ts) });
        pendUser = null;
      }
    }
    if (pendUser) pushPair(pairs, pendUser, { a: '', ts: pendUser.ts }); // 末尾悬挂 user（无 assistant 配对）
    // 导入条目必须带会话 id —— bridge 的 sessionKeyOf 读 it.sessionId，
    // 不带则导入原料 session_id=null、蒸出的记忆无法溯源。
    var __sessId = (sess && sess.id) ? String(sess.id) : null;
    if (__sessId) { for (var pi = 0; pi < pairs.length; pi++) pairs[pi].sessionId = __sessId; }
    return pairs;
  }
  function pushPair(pairs, u, a) {
    var userText = String(u.u || '').trim().slice(0, 8000);
    var asstText = String(a.a || '').trim().slice(0, 20000);
    if (!userText && !asstText) return;
    pairs.push({ user: userText, assistant: asstText, url: 'https://chat.deepseek.com/', occurred_at: isoTime(u.ts || a.ts) });
  }
  function firstText(m) {
    if (m == null) return '';
    if (typeof m === 'string') return m;
    // DS 历史接口的消息体是 fragments[]（REQUEST/RESPONSE/THINK），
    // 只找 m.content 会 undefined → 兜底取"最长字符串"会把思维链当成正文。
    if (Array.isArray(m.fragments) && m.fragments.length) {
      var body = '';
      for (var fi = 0; fi < m.fragments.length; fi++) {
        var f = m.fragments[fi] || {};
        var ft = String(f.type || '').toUpperCase();
        if (ft === 'REQUEST' || ft === 'RESPONSE') body += (f.content || '');
        // THINK / 其他一律丢弃
      }
      if (body) return body;
    }
    var v = m.content !== undefined ? m.content : (m.text !== undefined ? m.text : m);
    if (typeof v === 'string') return v;
    var arr = collectStrings(v, [], 0);
    return arr.sort(function (a, b) { return b.length - a.length; })[0] || '';
  }

  // MAIN world 侧 sendMessage 重试（此 IIFE 无 retrySend，就地小实现）
  // 本脚本运行在 MAIN world，chrome.runtime 不可用！
  // 所有到 background 的消息改经 content 转发：dispatch 'bg' 命令 → content 代发 → 'bg-result' 带回。
  var __bgSeq = 0;
  var __bgPending = {};
  window.addEventListener('mneme-ext:event', function (e) {
    var d = e.detail || {};
    if (d.type === 'bg-result' && __bgPending[d.id]) {
      var cb = __bgPending[d.id];
      delete __bgPending[d.id];
      cb(d.r);
    }
  });
  function bgSend(msg, cb) {
    var id = 'bg' + (++__bgSeq);
    __bgPending[id] = cb;
    window.dispatchEvent(new CustomEvent('mneme-ext:cmd', { detail: { type: 'bg', id: id, nonce: bgNonce, msg: msg } }));   // nonce 握手
    // 兜底超时：content 侧异常时回调 null
    setTimeout(function () { if (__bgPending[id]) { delete __bgPending[id]; cb(null); } }, 30000);
  }
  function retrySendMessage(msg, tries, cb) {
    // 经 content 转发（chrome.runtime.sendMessage 在 MAIN world 不可用 → 全部静默失败）
    bgSend(msg, function (r) {
      if (!r && tries > 0) { setTimeout(function () { retrySendMessage(msg, tries - 1, cb); }, 400); return; }
      cb(r);
    });
  }

  // ---- content ↔ injected 导入协议（CustomEvent detail 只放数据字段）----
  window.addEventListener('mneme-ext:cmd', function (e) {
    var d = e.detail || {};
    if (d.type === 'sessions-list') {
      // L1：全量会话列表（content 弹勾选列表）
      fetchAllSessions(function (p) {
        window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'list-progress', done: p.done } }));
      }).then(function (list) {
        var slim = [];
        for (var i = 0; i < list.length; i++) {
          var s0 = list[i] || {};
          // 带上轮次（slim 只有 id/title/ts → 按轮次排序恒为 0，
          // 回退时间后与「按时间」结果完全一致）
          var msgCnt = Number(s0.current_message_id || s0.version || s0.message_count || s0.msg_count || 0) || 0;
          slim.push({
            id: String(s0.chat_session_id || s0.id || s0.session_id || ''),
            title: String(s0.title || s0.name || '(无标题)'),
            ts: normTs(s0.updated_at || s0.inserted_at || s0.create_time),
            rounds: msgCnt ? Math.ceil(msgCnt / 2) : 0,   // current_message_id 是消息数 → 轮次 ≈ 半数
            msgCount: msgCnt
          });
        }
        window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'sessions-list', sessions: slim } }));
      }).catch(function (er) {
        window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'sessions-list', sessions: [], error: String(er) } }));
      });
    } else if (d.type === 'summarize') {
      // 入口诊断——确认命令到达、会话数与首项结构
      console.log('[mneme/inj] 收到 summarize 命令', {
        n: (d.sessions || []).length,
        mode: d.mode || 'card',
        first: (d.sessions && d.sessions[0]) ? { id: String(d.sessions[0].id).slice(0, 20), fromFile: !!d.sessions[0].fromFile, hasRaw: Array.isArray(d.sessions[0].raw) } : null,
        busy: __importBusy
      });
      // full 模式 = 全文蒸馏（重要会话），走 extractPairs 非摘要管线
      var funnelMode = d.mode === 'full' ? false : true;
      // L2 + L3 前半：白名单 → 摘要卡/全文 → estimate
      runFunnel({ sessions: d.sessions, summarizeMode: funnelMode },
        function (p) {
          window.dispatchEvent(new CustomEvent('mneme-ext:event', {
            detail: { type: 'import-progress', phase: p.phase, done: p.done, total: p.total, items: p.items || 0, imported: p.imported || 0 }
          }));
        },
        function (res) {
          __importBusy = false;
          if (!res.ok) {
            window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'summaries-ready', ok: false, error: res.error || '' } }));
            return;
          }
          var batches = res.batchesData || [];
          // batches 留在 injected 侧全局持有（__pendingBatches），不再跨 world 传大数组；
          // content 只收统计与预估。确认后 send-confirm 不带数据，injected 直接用 __pendingBatches 发送。
          __pendingBatches = batches;
          var allItems = [];
          for (var b = 0; b < batches.length; b++) allItems = allItems.concat(batches[b]);
          var chars = 0;
          for (var q = 0; q < allItems.length; q++) chars += String(allItems[q].user || '').length + String(allItems[q].assistant || '').length;
          // estimate 采样直通（≤50 条样本 + 真实总字符）
          var sample = allItems.length > 50 ? allItems.slice(0, 50) : allItems;
          var body = JSON.stringify({ items: sample, totalChars: chars, totalItems: allItems.length });
          console.log('[P8] estimate 发出', { bodyLen: body.length, sample: sample.length, chars: chars });
          // 预览样本：content 只需要前 12 条渲染
          var preview = allItems.slice(0, 12);
          estimateBatch(body, function (est) {
            console.log('[P10] summaries-ready 派发', { cards: allItems.length, mode: res.mode });
            window.dispatchEvent(new CustomEvent('mneme-ext:event', {
              detail: {
                type: 'summaries-ready', ok: true, sessions: res.sessions, cards: allItems.length,
                chars: chars, preview: preview, estimate: est, mode: res.mode
              }
            }));
          });
        }
      );
    } else if (d.type === 'send-confirm') {
      // 确认后直接用 injected 持有的 __pendingBatches（不再从事件回传大数组）
      sendBatches(__pendingBatches || [], function (p) {
        window.dispatchEvent(new CustomEvent('mneme-ext:event', {
          detail: { type: 'import-progress', phase: p.phase, done: p.done, total: p.total, imported: p.imported || 0 }
        }));
      }, function (res) {
        window.dispatchEvent(new CustomEvent('mneme-ext:event', {
          detail: { type: 'funnel-done', ok: !!res.ok, error: res.error || '', imported: res.imported || 0, batches: res.batches || 0 }
        }));
      });
    } else if (d.type === 'import-start') {
      runImport(
        { maxSessions: d.maxSessions },
        function (p) {
          window.dispatchEvent(new CustomEvent('mneme-ext:event', {
            detail: { type: 'import-progress', phase: p.phase, done: p.done, total: p.total, items: p.items || 0, imported: p.imported || 0 }
          }));
        },
        function (res) {
          __importBusy = false;
          window.dispatchEvent(new CustomEvent('mneme-ext:event', {
            detail: {
              type: 'import-done', ok: !!res.ok, error: res.error || '', sessions: res.sessions || 0,
              imported: res.imported || 0, batches: res.batches || 0, probed: (res.probed || []).slice(0, 10)
            }
          }));
        }
      );
    }
  });

  // debug 探针：不打 bridge，只打印两步接口真实形态（首火校准用）
  // 分页参数探测——逐一尝试候选参数，报告「返回条数 + 首条 id」是否变化，
  // 用于确定 DS fetch_page 的真实分页口径（Console 执行 __MNEME_PAGE_PROBE__()）。
  window.__MNEME_PAGE_PROBE__ = async function () {
    var out = { baseline: null, trials: [] };
    async function get(u) {
      try {
        var r = await importFetch(u, { method: 'GET' });
        var j = safeJson(await r.text());
        var ok = r.ok && j && (j.code === 0 || j.code === undefined || j.code === '0');
        var lst = ok ? (pickSessionList(unwrapJsonEnvelope(j)) || []) : [];
        return { url: u, status: r.status, ok: !!ok, n: lst.length, first: lst[0] ? (lst[0].id || lst[0].chat_session_id || '') : '', code: j && j.code };
      } catch (e) { return { url: u, error: String(e) }; }
    }
    out.baseline = await get('/api/v0/chat_session/fetch_page?count=100');
    var baseFirst = out.baseline.first;
    var cands = [
      '/api/v0/chat_session/fetch_page?count=100&offset=100',
      '/api/v0/chat_session/fetch_page?count=100&limit=100',
      '/api/v0/chat_session/fetch_page?count=100&page=2',
      '/api/v0/chat_session/fetch_page?count=100&cursor=' + encodeURIComponent(baseFirst || ''),
      '/api/v0/chat_session/fetch_page?count=200',
      '/api/v0/chat_session/fetch_page?count=500',
      '/api/v0/chat_session/fetch_page?count=100&before_seq_id=0',
      '/api/v0/chat_session/fetch_page?count=100&last_id=' + encodeURIComponent(baseFirst || '')
    ];
    for (var i = 0; i < cands.length; i++) {
      var t = await get(cands[i]);
      t.changed = t.first && baseFirst ? (t.first !== baseFirst) : null;
      out.trials.push(t);
      await new Promise(function (res) { setTimeout(res, 250); });
    }
    window.__MNEME_PAGE_PROBE_LAST__ = JSON.stringify(out, null, 1);
    console.log('[mneme/inj] 分页探测结果:', window.__MNEME_PAGE_PROBE_LAST__.slice(0, 3500));
    return out;
  };
  if (debug) console.log('[mneme/inj] 分页探测就绪：__MNEME_PAGE_PROBE__()');

  window.__MNEME_IMPORT_PROBE__ = async function () {
    var out = { list: [], historySample: null };
    try {
      var r = await importFetch('/api/v0/chat_session/fetch_page?count=3', { method: 'GET' });
      var t = await r.text();
      out._full1 = t; // v0.3.3：完整文本供解析（展示仍截断 600）
      out.list.push({ url: '/api/v0/chat_session/fetch_page?count=3', status: r.status, body: String(t).slice(0, 600) });
    } catch (e) { out.list.push({ url: 'fetch_page', error: String(e) }); }
    try {
      var r2 = await importFetch('https://chat.deepseek.com/api/v0/chat_session/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ self_circular: true, offset: 0, limit: 3 })
      });
      var t2 = await r2.text();
      out._full2 = t2;
      out.list.push({ url: '/api/v0/chat_session/list', status: r2.status, body: String(t2).slice(0, 600) });
    } catch (e2) { out.list.push({ url: 'list', error: String(e2) }); }
    for (var i = 0; i < out.list.length; i++) {
      var sid = null;
      try {
        var fullText = i === 0 ? out._full1 : out._full2;
        var biz = unwrapJsonEnvelope(safeJson(fullText || out.list[i].body)); // v0.3.3：用完整文本解析（截断 600 字符的 body 解析必败，这是首轮 probe historySample=null 的根因）
        var lst = pickSessionList(biz);
        if (lst && lst.length) sid = lst[0].chat_session_id || lst[0].id || lst[0].session_id;
      } catch (e3) {}
      if (sid) {
        try {
          var r3 = await importFetch('/api/v0/chat/history_messages?cache_version=0&chat_session_id=' + encodeURIComponent(sid), { method: 'GET' });
          var t3 = await r3.text();
          out.historySample = { url: '/api/v0/chat/history_messages?chat_session_id=' + sid, status: r3.status, body: String(t3).slice(0, 800) };
        } catch (e4) { out.historySample = { error: String(e4) }; }
        break;
      }
    }
    window.__MNEME_IMPORT_PROBE_LAST__ = JSON.stringify(out, null, 1);
    console.log('[mneme/inj] 导入探测结果:', window.__MNEME_IMPORT_PROBE_LAST__.slice(0, 3000));
    return out;
  };
  if (debug) console.log('[mneme/inj] 导入器就绪：__MNEME_IMPORT_PROBE__() 可探测历史接口形态');





  // ====================================================================
  // 系统设置弹层样式探测（MAIN world：Console 默认在此 world，
  // isolated world 的 window 与页面互不可见，放 content.js 调不到）。
  // 用法：点开「系统设置」弹层后执行 __MNEME_SETTINGS_PROBE__()，
  // 输出存 __MNEME_SETTINGS_PROBE_LAST__。
  window.__MNEME_SETTINGS_PROBE__ = function () {
    var out = { found: false, candidates: [], container: null, sections: [], rows: [], toggles: [], buttons: [] };
    function grab(el) {
      var cs = getComputedStyle(el);
      return { tag: el.tagName, cls: String(el.className).slice(0, 100),
        display: cs.display, position: cs.position, inset: [cs.top, cs.left], transform: cs.transform !== 'none' ? cs.transform.slice(0, 40) : 'none',
        w: cs.width, h: cs.maxHeight, bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius,
        border: cs.border, shadow: cs.boxShadow.slice(0, 80), font: cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontFamily.slice(0, 30),
        padding: cs.padding, gap: cs.gap, zIndex: cs.zIndex };
    }
    // 不用「fixed+宽度窗」硬条件（DS 弹层可能 absolute/尺寸出窗），
    // 改为「含『系统设置』文本的元素向上找最大可见容器」——从命中文本节点逐级上爬，
    // 取到 body 之前体积最大（宽>250 且高>200）的祖先作为弹层容器。
    var marker = null;
    var walker = document.querySelectorAll('div, span, p, h1, h2, h3, li');
    for (var i = 0; i < walker.length; i++) {
      var t = (walker[i].childNodes.length === 1 && walker[i].innerText || '').trim();
      if (t === '系统设置') { marker = walker[i]; break; }
    }
    if (!marker) {
      out.hint = '页面上没找到「系统设置」文本——确认弹层已打开且标题可见';
      window.__MNEME_SETTINGS_PROBE_LAST__ = JSON.stringify(out, null, 1);
      console.log('[mneme/inj] 设置弹层探测结果:', window.__MNEME_SETTINGS_PROBE_LAST__);
      return out;
    }
    // 上爬收集候选：体积达标的祖先里取最大者
    var best = null, bestArea = 0, chain = [];
    var cur = marker.parentElement;
    while (cur && cur !== document.body) {
      var r = cur.getBoundingClientRect();
      if (r.width > 250 && r.height > 200) {
        chain.push({ tag: cur.tagName, cls: String(cur.className).slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) });
        var area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = cur; }
      }
      cur = cur.parentElement;
    }
    out.candidates = chain.slice(0, 8);
    if (!best) {
      out.hint = '找到了「系统设置」文本但无达标容器祖先（chain 已列出）';
      window.__MNEME_SETTINGS_PROBE_LAST__ = JSON.stringify(out, null, 1);
      console.log('[mneme/inj] 设置弹层探测结果:', window.__MNEME_SETTINGS_PROBE_LAST__);
      return out;
    }
    out.found = true;
    out.container = grab(best);
    var cards = best.querySelectorAll('[class*="card"], [class*="section"], [class*="group"]');
    for (var c = 0; c < Math.min(cards.length, 6); c++) out.sections.push(grab(cards[c]));
    var rows = best.querySelectorAll('[class*="item"], [class*="row"], li, [class*="option"]');
    for (var r2 = 0; r2 < Math.min(rows.length, 8); r2++) out.rows.push(grab(rows[r2]));
    var tgs = best.querySelectorAll('[class*="switch"], [class*="toggle"], [role="switch"]');
    for (var t3 = 0; t3 < Math.min(tgs.length, 4); t3++) {
      var tg = grab(tgs[t3]);
      var knob = tgs[t3].querySelector('span, div, [class*="knob"], [class*="slider"]');
      tg.knob = knob ? grab(knob) : null;
      out.toggles.push(tg);
    }
    var btns = best.querySelectorAll('button, [class*="button"], [class*="btn"]');
    for (var b = 0; b < Math.min(btns.length, 6); b++) out.buttons.push(grab(btns[b]));
    window.__MNEME_SETTINGS_PROBE_LAST__ = JSON.stringify(out, null, 1);
    console.log('[mneme/inj] 设置弹层探测结果:', window.__MNEME_SETTINGS_PROBE_LAST__.slice(0, 3000));
    return out;
  };


  // ====================================================================
  // 旧会话导入·三层漏斗：
  //   L1 会话勾选列表（UI 在 content；此处 fetchAllSessions 全量分页拉列表）
  //   L2 摘要卡（buildSummaryCard：本地截取）
  //   L3 estimate 预估确认（estimateBatch → background importEstimate →
  //      POST /memory/import/estimate；bridge-dev 并行实现，先按
  //      {estimateChars, estimateTokens, sessions} 桩位对接；404 → ok:false，
  //      content 侧降级为本地字数估算）
  // summarizeMode=true 时 items 用摘要卡（user=卡文本，assistant=''），不发全文
  // ——LLM 只花在蒸馏摘要（三层漏斗核心：省 API）。
  // ====================================================================
  function clip(s, n) { return String(s || '').trim().slice(0, n); }
  function firstSentence(s, n) {
    var t = String(s || '').trim();
    var m = t.match(/^[^。！？!?\.\n]{1,120}[。！？!?]/);
    return clip(m ? m[0] : t, n);
  }
  function buildSummaryCard(sess, msgs) {
    // 摘要卡：按「信息价值」选材而非按轮次流水。
    // 调研结论：有效摘要提取 durable 信息（决策/偏好/事实/结局），过程性轮次是噪声。
    var users = [], assts = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      var role = String(m.role || '').toLowerCase();
      if (!role && Array.isArray(m.fragments)) {
        for (var rf = 0; rf < m.fragments.length; rf++) {
          var rft = String((m.fragments[rf] || {}).type || '').toUpperCase();
          if (rft === 'REQUEST') { role = 'user'; break; }
          if (rft === 'RESPONSE') { role = 'assistant'; break; }
        }
      }
      var txt = firstText(m).replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      if (role === 'user') users.push({ txt: txt, at: i });
      else if (role === 'assistant' || role === 'ai') assts.push({ txt: txt, at: i });
    }
    var turns = users.length;
    var firstUser = users.length ? users[0].txt : '';
    var lastUser = users.length ? users[users.length - 1].txt : '';
    var firstAsst = assts.length ? firstSentence(assts[0].txt, 150) : '';
    var lastAsst = assts.length ? clip(assts[assts.length - 1].txt, 300) : '';
    // 决策/转折信号：修正、否定、更换、取舍类措辞（本地启发式）
    var SIGNAL = /(不要|不行|不对|改成|换|重新|放弃|算了|转向|最终|决定|还是用|改成用|改为|总结|综上|记住|以后|下次|偏好|喜欢|以后都)/;
    var signals = [];
    for (var si = 0; si < users.length && signals.length < 8; si++) {
      if (SIGNAL.test(users[si].txt)) {
        var line = '· ' + clip(users[si].txt, 110);
        if (signals.indexOf(line) < 0) signals.push(line);
      }
    }
    // 长会话（轮数多）补中位轮，避免只看到首尾
    if (turns > 12 && users.length > 4) {
      var mid = users[Math.floor(users.length / 2)];
      var midLine = '· ' + clip(mid.txt, 110);
      if (signals.indexOf(midLine) < 0) signals.splice(Math.min(4, signals.length), 0, midLine);
    }
    var CARD_CAP = 1800;
    var card = [
      '主题：' + clip(String(sess && sess.title) || '(无标题)', 80),
      '任务：' + clip(firstUser, 260),
      (signals.length ? '关键转折与要求：\n' + signals.join('\n') : ''),
      '结局：' + (lastAsst ? clip(lastAsst, 320) : clip(lastUser, 320)),
      '轮数：' + turns,
      '跨度：' + clip(isoTime(sess && sess.ts) || '?', 10) + '~' + clip(isoTime(tN(msgs)) || '?', 10)
    ].filter(function (s) { return s; }).join('\n');
    if (card.length > CARD_CAP) card = card.slice(0, CARD_CAP - 1) + '…';
    return card;
  }
  // 最后一条消息时间（ISO 或秒/毫秒归一）
  function tN(msgs) {
    for (var j = msgs.length - 1; j >= 0; j--) {
      var v = msgs[j] && (msgs[j].inserted_at || msgs[j].create_time || msgs[j].at);
      if (v) return v;
    }
    return null;
  }
  // 全量拉会话列表（L1 数据源；去重分页，上限 200 防失控）
  async function fetchAllSessions(onProg) {
    var all = [];
    // 拉全部会话（limit=N 参数无效 → 永远只有首页 100 条，需翻页拉全）。
    // 分页参数多策略轮换：offset=N → page=N（DS 各版本口径不一，命中即续拉）。
    for (var pg = 0; pg < 60 && all.length < 3000; pg++) {
      var u;
      if (pg === 0) u = '/api/v0/chat_session/fetch_page?count=100';
      else if (pg <= 20) u = '/api/v0/chat_session/fetch_page?count=100&offset=' + all.length;
      else u = '/api/v0/chat_session/fetch_page?count=100&page=' + pg;
      try {
        var r = await importFetch(u, { method: 'GET' });
        var j = safeJson(await r.text());
        if (!(r.ok && j && (j.code === 0 || j.code === undefined || j.code === '0'))) break;
        var lst = pickSessionList(unwrapJsonEnvelope(j)) || [];
        var fresh = 0;
        for (var i = 0; i < lst.length; i++) {
          var s0 = lst[i] || {};
          var sid = s0.chat_session_id || s0.id || s0.session_id;
          var seen = false;
          for (var w = 0; w < all.length; w++) {
            var wid = all[w] && (all[w].chat_session_id || all[w].id || all[w].session_id);
            if (String(wid) === String(sid)) { seen = true; break; }
          }
          if (!seen && sid) { all.push(s0); fresh++; }
        }
        if (onProg) onProg({ phase: 'list', done: all.length });
        if (!fresh || !lst.length) break;
        await new Promise(function (res) { setTimeout(res, 200); });
      } catch (e) { break; }
    }
    return all;   // v0.3.18：不截断（拉多少返回多少，上限由循环控制）
  }
  // L3：estimate 桩位对接（background importEstimate → POST /memory/import/estimate）
  function estimateBatch(body, cb) {
    // 重试 4 次（SW 冷启动竞态下次数太少常失败 → 误降级本地估算），失败打日志
    console.log('[P9a] estimate sendMessage 发出');
    retrySendMessage({ type: 'importEstimate', body: body }, 4, function (r) {
      console.log('[P9b] estimate 返回', { ok: !!(r && r.ok), hasR: !!r });
      if (r && r.ok) cb({ ok: true, estimate: r.r });
      else { console.warn('[mneme/inj] estimate 失败，降级本地估算', r); cb({ ok: false }); }
    });
  }
  // 漏斗编排：summarizeMode=true 时 items 用摘要卡（不发全文），batchesData 交回 content
  // fetchSessionList 提升到 IIFE 顶层（多处调用）。
  async function fetchSessionList() {
    var result = { probed: [] };
    try {
      var listCap = 2000;
      var u1 = '/api/v0/chat_session/fetch_page?count=' + listCap;
      var r1 = await importFetch(u1, { method: 'GET' });
      var j1 = safeJson(await r1.text());
      var ok1 = r1.ok && j1 && (j1.code === 0 || j1.code === undefined || j1.code === '0');
      result.probed.push({ name: 'fetch_page', url: u1, status: r1.status, ok: !!ok1 });
      if (ok1) {
        var list1 = pickSessionList(unwrapJsonEnvelope(j1));
        if (list1 && list1.length) {
          var all1 = list1.slice();
          for (var pg = 0; pg < 60 && all1.length < listCap; pg++) {
            var uN = '/api/v0/chat_session/fetch_page?count=100&offset=' + all1.length;
            await new Promise(function (res) { setTimeout(res, 200); });
            var rN = await importFetch(uN, { method: 'GET' });
            var jN = safeJson(await rN.text());
            if (!(rN.ok && jN && (jN.code === 0 || jN.code === undefined || jN.code === '0'))) break;
            var lN = pickSessionList(unwrapJsonEnvelope(jN)) || [];
            var fresh = 0;
            for (var q = 0; q < lN.length; q++) {
              var qid = lN[q] && (lN[q].chat_session_id || lN[q].id || lN[q].session_id);
              var seen = false;
              for (var w = 0; w < all1.length; w++) {
                var wid = all1[w] && (all1[w].chat_session_id || all1[w].id || all1[w].session_id);
                if (String(wid) === String(qid)) { seen = true; break; }
              }
              if (!seen && qid) { all1.push(lN[q]); fresh++; }
            }
            if (!fresh || !lN.length) break;
          }
          return all1;
        }
      }
    } catch (e) { result.probed.push({ name: 'fetch_page', error: String(e) }); }
    return null;
  }

  // ====================================================================
  // fetchMessages 提升到 IIFE 顶层（跨作用域调用在函数内部会抛 ReferenceError 被吞）。
  // 表现为「点下一步后无任何日志、摘要卡恒为空」。
  // ====================================================================
  async function fetchMessages(sessionId) {
    var u = '/api/v0/chat/history_messages?cache_version=0&chat_session_id=' + encodeURIComponent(sessionId);
    var r = await importFetch(u, { method: 'GET' });
    var j = safeJson(await r.text());
    var okFlag = r.ok && j && (j.code === 0 || j.code === undefined || j.code === '0');
    if (!okFlag) {
      console.warn('[mneme/inj] 历史拉取失败', { sessionId: String(sessionId).slice(0, 20), status: r.status, code: j && j.code, msg: j && j.msg });
      return [];
    }
    var msgs = pickMessages(unwrapJsonEnvelope(j));
    if (!msgs || !msgs.length) {
      var biz = unwrapJsonEnvelope(j);
      console.warn('[mneme/inj] 历史为空', {
        sessionId: String(sessionId).slice(0, 20),
        bizKeys: biz && typeof biz === 'object' ? Object.keys(biz).slice(0, 12) : [],
        sample: JSON.stringify(biz).slice(0, 300)
      });
      return [];
    }
    console.log('[mneme/inj] 历史拉取成功', { sessionId: String(sessionId).slice(0, 20), n: msgs.length, firstRole: msgs[0] && msgs[0].role, hasFrag: !!(msgs[0] && msgs[0].fragments) });
    return msgs;
  }


  function runFunnel(opts, onProgress, onDone) {
    if (__importBusy) { onDone({ ok: false, error: 'import-busy' }); return; }
    __importBusy = true;
    var result = { ok: false, sessions: 0, imported: 0, batches: 0, probed: [] };
    var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
    var summarizeMode = !!opts.summarizeMode;
    (async function () {
      try {
        var ids = opts.sessions || [];
        result.sessions = ids.length;
        console.log('[mneme/inj] runFunnel 入口', { n: ids.length, mode: summarizeMode });
        var items = [], batches = [];
        function pushItem(it) { items.push(it); if (items.length >= 200) { batches.push(items); items = []; } }
        console.log('[mneme/inj] runFunnel 开始', { mode: summarizeMode ? 'summary-card' : 'full', sessions: ids.length });
        for (var k = 0; k < ids.length; k++) {
          var msgs = [];
          // card 模式下文件会话走精简 raw；full 模式下精简 raw 不够 → 回退 API 拉全文
          //（若该会话不在最近 100 条内会拉空 → 自动降级为 raw 精简版摘要卡并在 probed 记录）。
          if (summarizeMode && ids[k] && ids[k].fromFile && Array.isArray(ids[k].raw) && ids[k].raw.length) {
            msgs = ids[k].raw;
            if (k === 0) console.log('[mneme/inj] 首会话走文件通道(card)', { id: String(ids[k].id).slice(0, 20), rawLen: msgs.length });
          } else {
            if (k === 0) console.log('[mneme/inj] 首会话走 API 通道', { id: String(ids[k].id).slice(0, 20) });
            try { msgs = await fetchMessages(ids[k].id); } catch (e) { result.probed.push({ name: 'history', id: ids[k].id, error: String(e) }); }
          }
          if (summarizeMode) {
            // L2：摘要卡形态（蒸馏只看卡）
            var sessForCard = ids[k];
            // 会话自带 rounds（API 由 current_message_id 推导 / 文件按 REQUEST 计数）
            // 比"消息条数/2"更准确，优先采用。
            if (sessForCard && Number(sessForCard.rounds) > 0) {
              sessForCard = { id: sessForCard.id, title: sessForCard.title, ts: sessForCard.ts, rounds: Number(sessForCard.rounds) };
            }
            var card = buildSummaryCard(sessForCard, msgs);
            // 只有真正提取到内容（含"任务："非空）才算有效卡，否则丢弃并记录
            var cardOk = /任务：[^\n]{2,}/.test(card) || /轮数：[1-9]/.test(card);
            if (!cardOk) { result.probed.push({ name: 'card-empty', id: String(ids[k].id).slice(0, 20), msgs: msgs.length }); }
            if (cardOk) {
              items.push({ user: card, assistant: '', url: 'https://chat.deepseek.com/', sessionId: ids[k].id ? String(ids[k].id) : null, kind: 'summary-card', occurred_at: isoTime(ids[k].ts) });
            }
          } else {
            var pairs = extractPairs(msgs, ids[k]);
            console.log('[P6] extractPairs 完成', { k: k, msgs: msgs.length, pairs: pairs.length });
            for (var p = 0; p < pairs.length; p++) pushItem(pairs[p]);
          }
          onProgress({ phase: 'sessions', done: k + 1, total: ids.length, items: items.length + batches.length * 200 });
          await sleep(320); // 风控限速
        }
        console.log('[P7] 会话循环全部结束', { items: items.length, batches: batches.length });
        if (items.length) batches.push(items);
        window.dispatchEvent(new CustomEvent('mneme-ext:event', { detail: { type: 'import-progress', phase: 'estimate' } }));
        result.batches = batches.length;
        result.batchesData = batches; // 交给 onDone：真正发送由用户确认步骤触发
        result.mode = summarizeMode ? 'card' : 'full';   // v0.4.5：mode 经 result 传出（回调里拿不到局部 summarizeMode）
        result.ok = true;
        onDone(result);
      } catch (e) { result.error = String(e && e.message || e); onDone(result); }
    })();
  }
  // 真发（L3 确认后）：逐批 importBatch
  function sendBatches(batches, onProgress, onAllDone) {
    (async function () {
      var imported = 0;
      for (var b = 0; b < batches.length; b++) {
        var body = JSON.stringify({ items: batches[b] });
        var okFlag = await new Promise(function (res) {
          retrySendMessage({ type: 'importBatch', body: body }, 2, function (r) { res(!!(r && r.ok)); });
        });
        if (!okFlag) { onAllDone({ ok: false, error: 'bridge-batch-' + b, imported: imported }); return; }
        imported += batches[b].length;
        onProgress({ phase: 'import', done: b + 1, total: batches.length, imported: imported });
        await new Promise(function (res) { setTimeout(res, 200); });
      }
      onAllDone({ ok: true, imported: imported, batches: batches.length });
    })();
  }

  // ---- 剪贴板出口剥离：DS 复制按钮从内部 state 取文本（含注入块），
  //      在最终 API 层剥掉 HEADER..FOOTER，所有复制路径（writeText / execCommand /
  //      copy 事件）都经过这两个出口。剥离对不含块的无害（无命中原样返回）。
  function stripBlockText(t) {
    const s = String(t || '');
    let out = s, did = false;
    let h;
    while ((h = out.indexOf(HEADER)) >= 0) {
      const f = out.indexOf(FOOTER, h + HEADER.length);
      if (f < 0) break; // 有头无尾：不剥，避免误删正文
      out = out.slice(0, h) + out.slice(f + FOOTER.length);
      did = true;
    }
    if (!did) return s;
    // 顺带清掉剥离点留下的多余空行
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  }
  // 复制剥离门控：visible 模式块本来就可见，复制应保留全文；仅隐式模式才剥
  function clipStrip(t) { return injectMode === 'visible' ? t : stripBlockText(t); }
  function patchClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function (t) {
          try { return origWrite(clipStrip(t)); } catch (e) { return origWrite(t); }
        };
      }
    } catch (e) { /* clipboarboard 只读环境：静默 */ }
    try {
      // execCommand('copy') 与部分按钮走 DataTransfer：包 getData 没用（写入侧），
      // 覆盖 DataTransfer.prototype.setData，写入时即剥
      const DT = window.DataTransfer && window.DataTransfer.prototype;
      if (DT && DT.setData) {
        const origSet = DT.setData;
        DT.setData = function (type, t) {
          try { return origSet.call(this, type, clipStrip(t)); } catch (e) { return origSet.call(this, type, t); }
        };
      }
    } catch (e) { /* 静默 */ }
    try {
      // copy 事件兜底：页面若直接构造 ClipboardEvent，事件对象上的 setData 同样
      // 落到被覆写的 DataTransfer.prototype.setData；这里再拦一层 clipboardData
      // 的 writeText（部分实现走 async Clipboard API 的事件路径）
      document.addEventListener('copy', function (ev) {
        try {
          const cd = ev.clipboardData;
          if (!cd) return;
          const orig = cd.setData ? cd.setData.bind(cd) : null;
          if (orig && !cd.__mnemePatched) {
            cd.__mnemePatched = true;
            cd.setData = function (type, t) { return orig(type, clipStrip(t)); };
          }
        } catch (e) { /* 静默 */ }
      }, true);
    } catch (e) { /* 静默 */ }
  }
  patchClipboard();

    // sendBeacon 也打出 URL（beacon 完全静默，debug 时显形）
    if (navigator.sendBeacon && !navigator.sendBeacon.__mnemePatched) {
      const origBeacon = navigator.sendBeacon.bind(navigator);
      const patchedBeacon = function (url, data) {
        if (debug) dbg('sendBeacon', String(url));
        return origBeacon(url, data);
      };
      patchedBeacon.__mnemePatched = true;
      navigator.sendBeacon = patchedBeacon;
    }
  dbg('fetch/XHR 覆写完成 (v0.2.1, MAIN world document_start)');
})();
