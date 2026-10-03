// 设置页逻辑：读写 chrome.storage.local + 连通性测试（经 background）
'use strict';
const $ = (id) => document.getElementById(id);

function load() {
  chrome.storage.local.get(
    { bridgeUrl: 'http://127.0.0.1:8760', token: '', injectEnabled: true, injectMode: 'implicit', collectEnabled: true, debug: false, maxImportSessions: 20, maxImportChars: 1500000 },
    (c) => {
      $('bridgeUrl').value = c.bridgeUrl;
      $('token').value = c.token;
      $('injectEnabled').checked = c.injectEnabled;
      $('collectEnabled').checked = c.collectEnabled;
      $('debug').checked = c.debug;
      $('maxImportSessions').value = String(c.maxImportSessions || 20);
      $('maxImportChars').value = String(c.maxImportChars || 1500000);
      const radio = document.querySelector('input[name="injectMode"][value="' + (c.injectMode || 'implicit') + '"]');
      if (radio) radio.checked = true;
    }
  );
}

function save() {
  const modeEl = document.querySelector('input[name="injectMode"]:checked');
  chrome.storage.local.set(
    {
      bridgeUrl: $('bridgeUrl').value.trim() || 'http://127.0.0.1:8760',
      token: $('token').value.trim(),
      injectEnabled: $('injectEnabled').checked,
      injectMode: modeEl ? modeEl.value : 'implicit',
      collectEnabled: $('collectEnabled').checked,
      maxImportSessions: Math.max(1, Math.min(parseInt($('maxImportSessions').value, 10) || 20, 200)),
      maxImportChars: Math.max(10000, Math.min(parseInt($('maxImportChars').value, 10) || 5000000, 50000000)),
      debug: $('debug').checked
    },
    () => { $('status').textContent = '已保存 ✓（如改动过注入方式，刷新 chat.deepseek.com 生效）'; }
  );
}

function ping() {
  save();
  $('status').textContent = '正在测试…';
  chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
    if (chrome.runtime.lastError) { $('status').textContent = '连通失败 ✗ ' + chrome.runtime.lastError.message; return; }
    if (r && r.ok) $('status').textContent = '连通成功 ✓ ' + JSON.stringify(r.r);
    else $('status').textContent = '连通失败 ✗ ' + ((r && r.error) || '无响应');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('ping').addEventListener('click', ping);
});
