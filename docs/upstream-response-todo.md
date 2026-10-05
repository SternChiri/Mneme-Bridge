# 上游回复落地实施笔记（2026-10-05）

## 任务清单
1. 安全①：'bg' 转发一次性握手 nonce（inject.js / content.js）
2. 安全②：/memory/context 默认排除 sensitivity 条目（embedded.js + remote.js + config）
3. README 文档：dream 归属 / 三条已知限制（实体表、质量闸、scope 不对称）/ session-cleaner 实验性标注 / 数据流向 / CustomEvent 风险说明
4. embedded.js 版本门控：读 mneme 安装包 package.json，config 键 mneme.allowedLibRange
5. 验收：node --check + smoke 隔离（TEMP=F:\TEMP），攒本地，推送前问用户

## 勘察结论（已核实，未改码）
### nonce
- 链路：inject.js:745-751 bgSend dispatch mneme-ext:cmd {type:'bg',id,msg} → content.js:1608-1620 校验 d.type==='bg' 后 chrome.runtime.sendMessage(d.msg)，回发 mneme-ext:event {type:'bg-result',id,r} → inject.js:737-744 回调。
- 攻击面：页面脚本伪造 mneme-ext:cmd type:'bg' 经 content 代发（getList/getContext 读全库，无需 bridgeToken）。
- 方案：content 启动生成随机 nonce（crypto.getRandomValues，存闭包）；经注入时机传给 inject.js（inject 由 content 注入或先于 content？→ inject 在 MAIN world 先注册，content 后到——用 storage.local 写 nonce + inject 经 bg 'getNonce'？更简单：content 在收到首个 type:'bg' 请求时丢弃并主动广播 nonce，inject 无从获得 → 采用「content 生成 nonce 后写入 chrome.storage.session，注入 inject.js 时经 CustomEvent 带下行 nonce」，inject 每次 bgSend 带 nonce，content 校验。页面脚本读不到 storage.session（isolated）也无法伪造注入时机的 CustomEvent（注入先于页面脚本可能加载完成？不可靠）→ 最稳：nonce 单向校验只防「随机页面脚本」， acknowledges 局限写 README。
- 简化定案：content.js 生成 nonce（每次页面加载随机），通过 window.dispatchEvent mneme-ext:event {type:'nonce',nonce} 广播一次；inject.js:25 监听器捕获并存变量；bgSend（inject.js:745-751）detail 加 nonce 字段；content.js:1610 校验 d.nonce===本会话 nonce 才转发。页面脚本若在广播前监听可截获——文档注明这是「提高门槛」非强隔离（强隔离需 externally_connectable/子框架隔离，超出扩展能力）。上游建议原文即「一次性握手 nonce」，照做。
### sensitivity
- mneme service.toApiList 条件透出 sensitivity；8790 /memories、/search 均带出。
- embedded.js context()：pins 取自 service.list(...) 行（:306），related 取自 searchMemories/search 行（:348/:354），关键词补路行（:414-416）。过滤函数加在 relatedFilter 处 + pins push 处：r.sensitivity 非空即排除。config 键 mneme.contextExcludeSensitive 默认 true（config.js:28-50 段 + config.example.json）。
- remote.js slim()（:125-130）加过滤：m.sensitivity 非空跳过。
### 版本门控
- 插入点 embedded.js:48 libPath 解析后：读 join(libPath,'..','package.json')，version 校验 semver 区间（不引依赖，手写 ^x.y 判定：major===allowMajor && minor>=allowMinor）。config 键 mneme.allowedLibRange 默认 "^0.8"（当前 lib 0.8.12）。校验失败 throw 明确错误提示升级/改 allowedLibRange。
- config.js:28-50 mneme 段加默认值；config.example.json 同步。
### 验收
- node --check server.js lib/*.js；smoke：TEMP=F:\TEMP TMP=F:\TEMP node mneme-bridge/scripts/smoke.mjs（96/96 基线，新增用例待补或先跑通基线）。
- 扩展：node --check content.js inject.js background.js options.js。
