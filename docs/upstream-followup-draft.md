# 上游 mneme 追帖草稿

> **去向**：https://github.com/slow-stack/mneme/discussions（原报备帖下追加回复）

---

**标题**

```
Mneme Bridge 追加：请求 standalone API 开放蒸馏端点，并确认 headless 会话的保留策略
```

报备帖之后项目持续运行，embedded 与 remote 两种模式均工作正常。不复制、不新建存储的边界没有变化，愿意长期维护的承诺也不变。两件事想请维护者确认。

## 一个功能请求

Mneme Bridge 的蒸馏器负责把网页端缓冲的对话交给 LLM 提炼成原子记忆。这条链路目前完全自建，prompt 构造、输出解析与解析失败的容错合计约 300 行。我们已经尽量向官方管线对齐——七型记忆白名单、importance 1-5、JSON 数组输出——但这终究是一份手抄副本：上游迭代 prompt 或解析逻辑时，副本会跟着漂移。

已经发生的例子是解析失败路径的括号配对抢救（#339）：上游已修复，我们的副本没有，同类差异以后还会出现。

因此希望 standalone API（8790 端口，lib/api-standalone.js）开放一个蒸馏能力端点，例如 POST /summarize，入参为 turns 数组，复用 lib/summarize.js 的既有管线。这样桥接侧剩下的只是一次 HTTP 调用，自建蒸馏器的大部分可以删除，产出的记忆条目也与 DSH 内的蒸馏完全一致。

已核对的现状：standalone API 的路由面是 memories 的读写、检索与维护类操作，CONTRIBUTING 的 External API 一节也写明路由面保持在 memories 读写。开放蒸馏端点意味着超出这条约束，所以先在 Discussion 讨论，不直接提 PR。

对期望行为的描述（不预设实现）：给定一段对话轮次，得到与 autoSummarize 相同形态的原子记忆条目。是否直接入库由上游定。若端点只返回候选条目、由调用方再走 saveWithDedupe，与「路由面只读写 memories」的现有语义更贴合，也不会让第三方借端点绕过写准入。

若方向可以接受，我们愿意按 CONTRIBUTING 的流程先开 Issue 认领，并在 test/standalone-api.test.js 补路由用例。

## 一个使用问题

桥接的蒸馏通过 dsh --profile headless 发起，每个待蒸馏会话对应一次单轮 headless 调用，日常使用中数量不少。想确认这些单轮会话是否会留在 DSH 的工作区或会话列表里；如果有官方的隐藏或不保留选项（比如一次性会话的开关），希望了解具体用法。

如果没有现成选项，得到一个明确答案也好，桥接侧按现状处理即可。

## 维护

以上两项无论结论如何，长期维护的承诺不变：上游接口变更引发的兼容问题，会持续跟进修复。
