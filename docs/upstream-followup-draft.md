# 上游 mneme 追帖草稿

> **去向**：https://github.com/slow-stack/mneme/discussions/363

---

**标题**

```
Mneme Bridge 追加：请求 standalone API 开放蒸馏端点
```

## 功能请求

Mneme Bridge 的蒸馏器负责把网页端缓冲的对话交给 LLM 提炼成原子记忆，这条链路目前完全自建，约 300 行——prompt 构造、输出解析、失败容错。我们已尽量向官方管线对齐（七型白名单、importance 1-5、JSON 数组输出），但自建副本终究会随上游迭代而漂移。

希望 standalone API（8790 端口）开放一个蒸馏端点，例如 POST /summarize，入参 turns 数组，复用 lib/summarize.js 的既有管线。这样桥接侧只剩一次 HTTP 调用，自建蒸馏器大部分可删，产出条目也与 DSH 内蒸馏完全一致。

已核对的现状：standalone API 的路由面是 memories 的读写与检索维护，CONTRIBUTING 的 External API 一节也写明保持不变。开放蒸馏端点超出了这条约束，所以先在 Discussion 讨论，不直接提 PR。

期望行为（不预设实现）：给定对话轮次，返回与 autoSummarize 相同形态的条目；是否直接入库由上游定——若只返回候选、由调用方走 saveWithDedupe，与现有语义更贴合。

若方向可以接受，我们按 CONTRIBUTING 流程开 Issue 认领，并在 test/standalone-api.test.js 补用例。
