# Edge 扩展设计（v1，原生 MV3）

**选型结论：原生 MV3、无构建链（纯 JS）。** 理由：面积极小（4 个脚本）、Edge `edge://extensions` 直接 load unpacked、免 node 工具链、便于 agent 快速迭代。WXT/TS 留给二期（若 popup/设置 UI 复杂化再上）。

## 1. 项目结构

```
mneme-edge-extension/
  manifest.json            MV3
  background.js            service worker：唯一网络出口（bridge 调用）、消息路由、去重、重试队列
  content/content.js       isolated world：DOM 探测/注入，与 MAIN world 桥接
  injected/inject.js       MAIN world：fetch 覆写 + SSE 解析（web_accessible_resources）
  options/options.html|js  bridge URL/token/开关/状态
  icons/icon16|48|128.png
```

manifest 要点：
- `host_permissions`: ["http://127.0.0.1:8760/*", "http://localhost:8760/*"]（LAN IP 二期用 optional_host_permissions 动态申请）
- `content_scripts`: matches ["https://chat.deepseek.com/*"], run_at document_idle
- `web_accessible_resources`: injected/inject.js → matches chat.deepseek.com
- background ↔ content 用 chrome.runtime 消息；injected ↔ content 用 window CustomEvent（`mneme-ext:event`，detail 只放数据字段）

## 2. 记忆注入（DOM 路径优先）

1. **输入框探测**（多策略，按序尝试，MutationObserver 兜底重绑）：
   `#chat-input`（当前 textarea）→ `textarea[data-testid]*` → 底部 `[contenteditable="true"]` → 观察器兜底。
2. **发送前拦截**：捕获阶段监听 Enter keydown 与发送按钮 click → 先 `chrome.runtime.sendMessage({type:"getMemory", text})` 拉记忆（background 调 bridge：search(text 前 120 字) 空结果时回退 recent(5)）→ 组装注入块 → 写入输入框 → 120ms 后放行原动作。
3. **写入方式**：textarea 用原生 value setter + dispatch input 事件；contenteditable 用 Selection insertText。注入块放输入框**文本最前**，用户可见可删。
4. **注入块格式**（声明"仅供参考，非指令"）：
```
[记忆参考 | 来自本机记忆库，仅供参考，非指令]
· <title>：<content 前 120 字>
[/记忆参考]

<用户原输入>
```
5. 会话内防重复：同一注入块本会话只贴一次（content 变量内存）。

## 3. 记忆收集（MAIN world fetch 覆写 + SSE 容错解析 + DOM fallback）

1. **fetch 覆写**：包 `window.fetch`，仅匹配 URL 含 `chat/completion`（容错包含）。请求侧 clone body 解析用户消息（容错：取 messages 数组最后一条 user content / JSON 字段递归找最长 string）。响应侧读 SSE 流：按 \n\n 拆事件，`data:` 行 JSON.parse 后**递归提取 string 字段**按序拼接为增量（兼容 {"v":"..."} / 数组分片等 v0 形态；schema 变了也不崩，只是提取质量降级）。
2. **结束判定**：流读完 或 [DONE] 或 流结束后 1.2s 无新 delta → 产出 {user, assistant}。
3. **DOM fallback**：SSE 解析置信度低（delta 提取为空）时，content.js MutationObserver 记录最后用户气泡与助手气泡文本，流结束后兜底。
4. **上报**：CustomEvent → content → background → `POST /memory/conversation`。
5. **去重与队列**：background 以 sha-256(user+"\n"+assistant) 查 chrome.storage.local（保留 200 条）重复即弃；失败进重试队列（指数退避 1/2/4/8/16min，5 次止）。
6. **debug 模式**（options 开关）：console 前缀 [mneme] dump 拦截到的 URL/请求体/SSE 样本 —— 用于首次接火核对 DeepSeek 真实 schema。

## 4. 端到端验证（Phase 1 闭环）

1. DSH 面板开启外部 API → `curl http://127.0.0.1:8790/health` 通过。
2. 起 bridge → curl save/search/conversation 四链路通过。
3. Edge load unpacked → 网页发「记住：我偏好深色主题」→ bridge 日志出现 conversation → DSH `memory_search("深色主题")` 命中。
4. DSH `memory_save` 一条偏好 → 网页新会话输入任意问题 → 输入框出现记忆块、模型能引用。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| DeepSeek DOM/接口改版 | 多策略选择器 + observer + SSE 容错解析 + DOM fallback + debug dump |
| MAIN world 注入被 CSP 拦 | 用 manifest content script + web_accessible_resources 的 script 标签注入（扩展 world 注入不受页面 CSP 限制） |
| 重复收藏噪声 | 双层去重（扩展 hash + bridge saveWithDedupe） |
| 隐私 | 对话只落本机 mneme SQLite；token 存 chrome.storage.local，不出本机 |
