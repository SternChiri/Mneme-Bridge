# mneme memory bridge（Edge 扩展，原生 MV3）

把 chat.deepseek.com 接入本机 mneme 记忆池。

**v0.2 变更**（对照 v0.1）：
- **修复 MAIN world 注入被页面 CSP 拦截**：v0.1 用 script 标签 + web_accessible_resources，被 DeepSeek CSP 静默拦截（症状：无 [mneme/inj] 日志、对话不收集）。v0.2 改为 manifest 原生声明 \`"world": "MAIN"\` + \`document_start\`，不受 CSP 限制且先于页面脚本覆写 fetch。
- **隐式注入（默认）**：记忆不再进输入框——fetch 覆写层直接把记忆块拼进 chat/completion 请求体的最后一条 user 消息前，输入框无感。可在设置切回「可见注入」。
- **全局记忆**：检索升级为组合式（用户画像 + 行为规则 + importance=5 高价值记忆 + 相关记忆），需 bridge v0.2 的 GET /memory/context；旧 bridge 自动降级为 search/recent。
- **port closed 加固**：MV3 service worker 冷启动竞态（"The message port closed"）统一 retry 包装（3 次，200/500ms 退避）。

## v0.2.9 变更（悬浮面板）

页面右下角新增可拖动悬浮圆钮「M」（Shadow DOM 隔离样式，深浅色自适应）：

- **状态区**：bridge 连通状态（经 background `ping` → GET /health）
- **开关**：记忆注入 / 对话收集，与 options 页共用 `chrome.storage.local` 同名键，双向实时同步
- **最近记忆**：刷新按钮拉取 `getRecent` → bridge GET /memory/recent?limit=10，展示 title + type 徽章 + content 前 80 字
- **立即蒸馏**：发 `triggerDistill` → bridge POST /memory/distill（桩位：bridge 侧路由由蒸馏链路提供，404 时仅提示不重试）
- **设置**：经 background 打开扩展选项页
- **圆钮位置**记忆在 `mnemePanelPos`（storage），刷新保持；面板挂载失败静默退出，不影响注入/收集主链路

面板验证：刷新 chat.deepseek.com → 右下角出现圆钮 → 拖动后刷新位置保持 → 点开核对状态/开关/最近记忆/蒸馏提示。

## v0.3.0 变更（面板并入 DS 侧栏）

按用户要求，**悬浮球已删除**，唯一入口为 DS 左侧栏底部「记忆面板」菜单项（与「系统设置/帮助与反馈」并列）：

- **入口**：浅克隆原生侧栏行壳（tagName/class 自动继承 DS 样式），hover 反馈；SPA 路由切换导致侧栏重建时由 MutationObserver 防抖自动重挂
- **弹层**：点击后居中弹层，模拟「系统设置」风格（遮罩 + 圆角卡片分组 + iOS 式开关），深浅色自适应；Esc / ✕ / 点遮罩关闭
- **锚点策略**：文本命中「系统设置/帮助与反馈」→ 向上爬取 28~56px 高的「行」级祖先，不依赖具体 class（改版韧性高）；找不到时持续观察并在 debug 日志节流告警
- **结构探测**：Console 执行 `__MNEME_SIDEBAR_PROBE__()` → 打印侧栏行结构（tag/class/rowHtml/rect）与当前弹层视觉 token；锚点失效时把输出发回来即可校准阈值

（v0.2.9 的悬浮球与 mnemePanelPos 位置遗留值不再使用，留在 storage 无副作用。）

## v0.3.1 变更（旧会话批量导入）

面板新增「导入旧会话」入口，把 DeepSeek 历史对话批量写入 mneme（自动进入蒸馏缓冲，DSH 启动时蒸馏为正式记忆）。

### 观察到的 DeepSeek 历史接口形态（多策略基线）

> 首次使用前建议先核对：Console 执行 `__MNEME_IMPORT_PROBE__()`（不打 bridge，只打印两步接口 URL/状态/样本）。DS 改版时把输出贴回来校准。

- **会话列表候选（按序尝试）**
  1. `GET /api/v0/chat_session/fetch_page?count=N` —— iOS 客户端取证（Cache.db 实证）
  2. `POST /api/v0/chat_session/list`，body `{self_circular:true,offset:0,limit:N}` —— 社区逆向基线
- **单会话历史**：`GET /api/v0/chat/history_messages?cache_version=0&chat_session_id=<uuid>`
- **响应包**：`{code:0,data:{biz_data:...}}`；解析全容错（递归找含 `chat_session_id` 的数组 / 含 `role` 的数组，字段名变化不崩，只是命中率下降）
- **请求方式**：MAIN world 页面态原生 fetch（带 cookie 登录态），带 `mneme-no-capture: 1` 头且覆写层已透传——不误伤 chat/completion 拦截

### 使用说明

1. 面板 →「导入旧会话」→ 确认弹层（默认拉最近 **20** 个会话，options 页「最大导入会话数」可调 1~200）
2. 进度弹层：已拉取会话数 / 已导入条数；完成后提示「已进入蒸馏队列…」
3. 限速：每会话间隔 ≥320ms、每批导入间隔 ≥200ms，避免触发 DeepSeek 风控
4. bridge 写入（/memory/import）一律走 background；拉取历史（DeepSeek 侧）是唯一页面态例外（host_permissions 不含该域）
5. 数据核对：bridge 日志出现 `POST /memory/import {accepted,deduped,rejected}`；DSH 启动后 `memory_search` 应命中旧会话蒸馏出的记忆

## v0.3.4 变更（task-7：视觉对齐「系统设置」+ 导入段修复）

**结构修复（v0.3.1 残留）**：导入段（imOpen/openImportFlow/imStart/imHandlers）曾被误拼进 buildSideItem 函数 try 块中间——语法闭合但运行时序错乱、且「导入旧会话」按钮绑定丢失。已手术搬回面板 try 块正确位置（closePanel 区之后），按钮绑定补回，导入弹层恢复正常。

**侧栏入口项**（用户反馈：偏右/字小/图标风格不符）：
- `buildSideItem` 从相邻原生行（ds-dropdown-menu-option）及其文本子元素的 `getComputedStyle` **同源复制**关键样式（padding/margin/字号/字重/行高/颜色/圆角/minHeight/height/列间距），手写值仅作兜底——原生改版自动跟随
- 图标重绘为 DS 原生简洁线条 SVG（书签形，1.5px stroke + currentColor，尺寸取原生行内 svg 实测宽）

**弹层视窗 token 化（为「系统设置」复刻做准备）**：
- 弹层容器/头部/分组卡片/行/状态区/开关/按钮/遮罩的全部关键视觉值抽成 `--mn-*` CSS 自定义属性（默认值=当前实现），集中管理
- 深浅色 dark 块同步 token 化；`__MNEME_SETTINGS_PROBE__()` 已挂 window——用户点开「系统设置」后 Console 执行，dump 弹层容器/卡片/行/开关/按钮的 computedStyle 关键值（存 `__MNEME_SETTINGS_PROBE_LAST__`），照数据单点替换 token 即完成一比一复刻（复制视觉参数，不复制页面 class，防改版）

**验证步骤**：
1. 重载 0.3.4 → 侧栏项与「系统设置/帮助与反馈」行视觉一致（对齐/字号/线条图标）
2. 面板 →「导入旧会话」→ 确认弹层可打开、开始/取消可用（导入段修复回归）
3. 点开「系统设置」→ Console 跑 `__MNEME_SETTINGS_PROBE__()` → 把输出贴回来 → 按 --mn-* token 复刻弹层视觉（下一版）
4. 主链路回归：隐式注入/收集 debug 日志无异常

## v0.3.10 变更（task-7 复刻落地：DS 设计系统对齐）

依据 SETTINGS_PROBE 实测（ds-modal-content 760x500、ds-button 胶囊 radius 4096px、xs 13/20、quote-cjk-patch/Inter 14px/22px）：

- **容器**：`--mn-dialog-w` 440px→760px、`--mn-dialog-maxh` 76vh→500px
- **按钮**：radius 8px→**4096px 胶囊**（ds-button --capsule），补 `--mn-btn-lh` 20px、pad 7px 16px
- **开关**：xs 量级（轨道 38x21→34x20、滑块 17→16、位移 17→14）
- **字体栈**：全局 `--mn-font` token 化，默认对齐 quote-cjk-patch/Inter 14px/22px；head 补 22px 行高、linklike 13px
- **顺带清理**：v0.3.4 起被数组后段覆盖生效的重复旧样式块（.btns/.btn/.list… 硬编码段）删除，统一走 token

验证：重载 0.3.10 → 面板弹层容器宽度/按钮胶囊形/开关尺寸应与「系统设置」弹层一致；微调仍走 `--mn-*` token 单点替换。

## v0.3.14 变更（task-8：导入三层漏斗）

「导入旧会话」升级为三层漏斗——LLM 只花在摘要蒸馏，不再吃全文（28.9MB 全量 ≈ 数百元 → 摘要 ≈ 几分钱）：

- **L1 勾选列表**：点「导入旧会话」先拉全量会话列表（fetch_page 分页续拉+去重，上限 200），标题+日期+复选框，支持关键词过滤/全选/反选；默认全不勾，白名单上限 = 设置页「最大导入会话数」
- **L2 本地摘要卡**：勾选确认后 injected MAIN world 逐会话拉历史（320ms 限速），纯 JS 提取摘要卡——首条用户消息 200 字 + 末条用户消息 200 字 + 助手首句 100 字 + 轮数 + 时间跨度，单卡硬上限 500 字符，零 LLM
- **L3 预算确认**：摘要卡打包 → POST /memory/import/estimate（bridge-dev 并行实现；未上线自动降级本地字数估算）→ 显示预估字符/token → 预览摘要卡 → 点「确认导入」才真发（items=摘要卡，assistant 留空）
- **双闸**：maxImportSessions + maxImportChars（设置页新增，默认 5 万）
- 旧「全文直接导入」协议（import-start）保留未删，漏斗为默认入口

验证：重载 0.3.14 → 面板「导入旧会话」→ 勾选 → 下一步 → 摘要卡预估确认 → 导入 → bridge 日志 POST /memory/import（items 为摘要卡形态）→ DSH 启动蒸馏。

## v0.3.15 变更（wouldExceed 防御性 UX）

bridge estimate 已上线（实弹验证通过），L3 确认弹层透出其字符闸判定：

- `est.estimate.wouldExceed === true` 时：确认按钮置灰（disabled + capture 兜底防误点）+ 红字「⚠ 超出字符闸（X / Y），请减少勾选会话或调大设置页『导入总字符量闸』」
- false 时行为不变；bridge 未上线（404 降级本地估算）时无闸提示，闸由 bridge 侧 task-9 执行

## 安装 / 升级

1. Edge → edge://extensions → 开发人员模式
2. 新装：加载解压缩的扩展，选本目录；升级：点本扩展的「重新加载」↻
3. 扩展选项 → Bridge 地址 + Token（mneme-bridge/config.json 的 bridgeToken）→ 保存 → 测试连通
4. 刷新 chat.deepseek.com

## 首次接火（debug 模式）

1. 设置页勾选「调试模式」保存，刷新页面
2. Console 过滤 mneme，应看到：
   - [mneme/cs] content script 就绪 (v0.2, mode=implicit)
   - 输入文字后：[mneme/cs] 预取 context 完成 related=N [有画像]
   - 发送后：[mneme/inj] 拦截 <url> user_len=N injected=true（implicit 模式的成功标志）
   - 回答结束：[mneme/inj] 结束( xxx ) assistant_len=N → [mneme/cs] 上报对话 …
3. bridge 日志应出现 POST /memory/context 与 POST /memory/conversation；DSH memory_search("深色主题") 应命中刚说的内容
4. 输入框全程应保持干净（只有你打的字）——这就是隐式注入生效

## v0.2.7 变更

- **注入降级**：打字快于预取（query 不匹配）时，注入自动降级为全局块（画像+规则+高价值记忆），不再整体跳过
- **DOM 终审**：thinking 回退的对话，上报前等 800ms 取页面上渲染好的答案文本覆盖——思考散文混合问题在展示层根治
- **结构信号日志**：debug 下每种未知的 SSE 事件形态只记录一次（正在抓 THINK→正文切换信号的精确形态）
- **索引切换启发**：绝对索引 >=1 的 content patch 判定为已切到正文 fragment

## v0.2.9a 修复（面板作用域）

- **根因**：mountPanel 是独立的第二个 IIFE，拿不到主 IIFE 的 cfgCache/retrySend——表现为面板卡在「检测中/加载中」、点击报 ReferenceError
- **修复**：主 IIFE 闭合前挂 window.__MNEME_CS_SHARED__={cfgCache,retrySend,dbg}，面板经它取用；retrySend 兜底行闭合补齐
- **附带**：window.__MNEME_SIDEBAR_PROBE__() 侧栏结构探测函数已挂（debug 模式 Console 执行，为侧栏移植取真实 DOM）

## 故障排查

| 现象 | 处置 |
|---|---|
| 无 [mneme/inj] 日志 | edge://extensions 看版本是否 0.2.0 并重新加载；v0.1 的 CSP 拦截即此症状 |
| injected=true 但模型没引用记忆 | debug 看注入块内容；bridge /memory/context 是否返回 profile/pins（需 bridge v0.2） |
| 请求 4xx/不回包 | 请求体改写可能破坏了新字段结构——debug dump 拦截样本发回来，我在 rewriteBody 补形态 |
| 预取一直失败 | 看 [mneme/bg] 日志；curl bridge /health 排查 bridge 本身 |
| 导入接口探测全失败 | Console 跑 __MNEME_IMPORT_PROBE__()，把 list/historySample JSON 发回来（DS 改版时校准 endpoint）；确认网页已登录且能手动翻到旧会话 |
| 侧栏无「记忆面板」项 | edge://extensions 重载扩展并确认版本 0.3.4；Console 跑 __MNEME_SIDEBAR_PROBE__() 把 sidebarItems 输出发回来（DS 改版时校准锚点阈值）；弹层打不开看 [mneme/panel] debug 日志 |
| 重复入库 | 扩展(sha256 LRU200)+bridge(LRU500) 双层去重，仍重复看 [mneme/bg] deduped 标记 |

## 设计要点

- background.js 唯一网络出口；content/injected 不直接 fetch
- injected 经 manifest 原生 MAIN world（document_start），先于页面脚本
- SSE 解析容错：delta.content / v / content / text，失败退化递归收集字符串
- 重试队列 chrome.alarms（1/2/4/8/16 分钟×5）；context 结果 bg 缓存 60s
