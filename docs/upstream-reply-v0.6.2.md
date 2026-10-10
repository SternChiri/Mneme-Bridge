# Discussion #363 回帖草稿（v0.6.2 通知）

> **去向**：https://github.com/slow-stack/mneme/discussions/363

---

[v0.6.2](https://github.com/SternChiri/Mneme-Bridge/releases/tag/v0.6.2) 已发布，主要改动是接入了 v0.8.14 的注入管线，感谢及时开放 `GET /context`：

- `/memory/context` 的候选来源切换到上游：remote 模式优先调用 `GET /context`，embedded 模式直接调用 `service.injectCandidates`。桥接侧保留 sensitivity 过滤、元记忆过滤与字段瘦身，响应形状不变。新增 `contextSource` 配置（默认 `auto`，端点不可用时回落到原有拼装路径）。
- 按此前的建议，自建的 pins 启发式（INTERACT/SCENE 两级正则白名单）已整体移除，降级路径改为朴素的 preference/constraint 直查。此前在桥接侧维护的一套选材逻辑不再需要，这也是当初希望上游开放注入端点的原因之一。
- `/memory/search` 补齐了 `agentScope` / `workspaceScope` 的透传（embedded 经 `searchMemories` 的 scope 选项，remote 经 query 参数），此前桥接没有暴露这个入口。

如有实现上与上游预期不符的地方，请直接指出。