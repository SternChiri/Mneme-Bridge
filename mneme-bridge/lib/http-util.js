// lib/http-util.js —— HTTP 基础件：统一响应、鉴权、CORS、body 读取
// 鉴权实现抄 mneme api-standalone.js L73-79（Bearer/x-dsh-mneme-token 双头 +
// 长度先比 + timingSafeEqual 常量时间比较），语义与上游一致。
import { timingSafeEqual } from "node:crypto";

/** JSON 响应。统一带 CORS 全放开头（设计文档 §2：有 token 兜底，简化放行）。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // CORS：bridge 的消费方是浏览器扩展与手机 Web 页面，Origin 不可枚举，
    // 所以直接 *；真正的门是 Authorization token，不是 Origin。
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  });
  res.end(body);
}

/** 204 空响应（OPTIONS 预检用）。同样带 CORS 头。 */
export function sendNoContent(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  });
  res.end();
}

/**
 * Bearer 鉴权（常量时间比较）。
 * 抄自 mneme isAuthorized：先比长度是 timingSafeEqual 的前置条件（两者字节长度
 * 不等会直接抛异常），同时长度差本身不构成时序泄漏——短路在比较之前。
 */
export function isAuthorized(req, bridgeToken) {
  const raw = req.headers?.authorization ?? req.headers?.["x-dsh-mneme-token"] ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token === "" || token.length !== bridgeToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(bridgeToken));
  } catch {
    // 极端情况下（非 UTF8 头）比较失败按未授权处理
    return false;
  }
}

/** 读取请求体并 JSON.parse。限制 1MB——防呆不防恶意（token 是第一道门）。 */
export const MAX_BODY_BYTES = 1024 * 1024;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(Object.assign(new Error("payload-too-large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("invalid-json"), { code: "INVALID_JSON" }));
      }
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** URL 查询参数小工具：取 name 为十进制正整数，非法回退 fallback。 */
export function intParam(url, name, fallback, { min = 1, max = 1000 } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}
