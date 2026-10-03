#!/usr/bin/env node
// smoke 用的假 dsh headless：读 stdin，输出固定 JSON 数组（带围栏），exit 0
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const F = String.fromCharCode(96).repeat(3);
  const item1 = { type: "preference", title: "偏好浅色主题", content: "用户在网页端明确表示偏好浅色主题（多次强调）", importance: 4, tags: ["web"] };
  const item2 = { type: "pitfall", title: "子串匹配协议枚举值会静默失效", content: "thought 不含 think 子串，凭语义直觉写 /think/i 匹配 fragment type 静默漏判；必须先样本 dump 确认真实值", importance: 4, tags: ["web"] };
  process.stdout.write(F + "json\n" + JSON.stringify([item1, item2], null, 2) + "\n" + F);
  process.exit(0);
});
