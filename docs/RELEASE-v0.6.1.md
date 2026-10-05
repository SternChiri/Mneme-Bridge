# Release v0.6.1 — 安全加固（上游代码审查落地）

> 上游 mneme 维护者在 [Discussion #363](https://github.com/slow-stack/mneme/discussions/363) 对本项目做了逐项代码审查。本版把审查中点名的安全与健壮性建议全部落地。

## 🔐 安全

**页面脚本伪造防护（扩展 0.6.1）**
注入层与面板层之间的 `bg` 命令转发新增一次性握手 nonce。此前 chat.deepseek.com 上任何页面脚本都可以伪造扩展事件、经面板层代发 bridge 命令读出记忆库（无需 bridgeToken）。现在不携带正确 nonce 的命令直接丢弃。这是缓解措施而非强隔离。**只在你信任的站点开启采集**。

**敏感记忆不出境（桥接 0.6.1）**
`/memory/context` 组装端默认排除带 `sensitivity` 标注的记忆——此前 sensitivity 在 mneme 侧只是标签、不参与过滤，敏感条目会随每轮对话发往 DeepSeek 服务器。现在 embedded / remote 两种模式同口径默认排除。新配置 `mneme.contextExcludeSensitive`（默认 `true`）。

## 🛡️ 健壮性

**mneme lib 版本门控（桥接 0.6.1）**
embedded 模式装载 mneme lib 前校验版本（`mneme.allowedLibRange`，默认 `^0.8`）。mneme 的 `lib/` 是内部构建产物、签名无稳定性契约，此前上游发版可能静默炸断桥接；现在超出区间明确报错并提示处理方式。

## 📖 文档

- README 补记注入数据流向（每轮发往 DeepSeek 服务器的具体内容）
- 已知边界新增六条：巩固（dream）归属 DSH 侧、网页记忆不进实体表、绕过宿主质量闸、「网页进全局、只读全局」的 scope 不对称、saveWithDedupe 并发重复概率、会话清理器实验性标注
- CHANGELOG 将 headless 会话清理功能并入本版

## 📦 附件

| 包 | 内容 |
|---|---|
| `mneme-bridge-v0.6.1-windows-x64.zip` | 完整项目（含 deploy 与托盘启动器） |
| `mneme-bridge-v0.6.1-cross-platform.zip` | 仅桥接目录（macOS/Linux `node server.js`） |
| `mneme-bridge-ext-v0.6.1.zip` | 仅扩展（Edge 商店上架用） |

**升级**：覆盖扩展目录重载即可；桥接侧替换 `lib/` 后重启。无破坏性变更，配置向后兼容（新键有默认值）。

**Full Changelog**: https://github.com/SternChiri/Mneme-Bridge/compare/v0.6.0...v0.6.1
