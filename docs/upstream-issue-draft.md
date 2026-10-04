# 上游 mneme 发帖草稿

> **去向**：https://github.com/slow-stack/mneme/discussions/new

---

**标题**

```
Mneme Bridge — 将 DeepSeek 网页端接入 mneme 记忆库（平台适配项目，愿长期维护）
```

已阅读 CONTRIBUTING 的 Scope 部分。本项目属于平台适配类，按其中说明，此类项目不在优先范围，
需先通过 Discussion 对齐范围，故在此说明情况。

## 项目

https://github.com/SternChiri/Mneme-Bridge

## 功能

DSH 与 DeepSeek 网页版的记忆目前互不相通。本项目将网页端的对话接入 mneme 的记忆库，
使两侧共享同一份记忆：网页中产生的内容可在 DSH 中检索到，DSH 中形成的记忆也会按话题注入网页对话。

实现分为两个部分：负责网页侧的浏览器扩展（MV3），以及负责与 mneme 交互的本地 Node 服务。

## 与 mneme 的关系

本项目不是 fork，也不是 DSH 插件，不新建任何存储。embedded 模式下，桥接服务直接挂载 mneme 的
lib（`createStore` / `createMirror` / `createService`），检索与写入分别通过 `searchMemories` 与
`saveWithDedupe` 完成；remote 模式下则使用 mneme 的 standalone API。去重、合并、冲突裁决与检索
均由 mneme 承担，本项目只负责调度与传输。

## 一个设计问题

DSH 关闭时 mneme 随之停止，桥接服务失去上游（remote 模式返回 502）。目前的做法是探测 8790
端口，不可用时回落到 embedded 直接访问库文件。希望确认是否有更合适的方案：

- 官方是否建议 mneme 独立常驻（如 daemon 模式），或使用自带的 stdio MCP server，以便被第三方服务长期挂载？
- 若有推荐方式，本项目愿意将其作为默认实现。

## 维护

Scope 部分提到，wrapper 类项目需要贡献者承诺长期维护，这一点本项目可以承担：上游接口变更
引发的兼容问题，将跟进修复。

若这个方向不合适，或对 mneme 的引用方式有要求，请直接指出。
