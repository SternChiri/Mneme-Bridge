// lib/config.js —— 配置加载与首次生成
// 设计文档 §5：config.json 首次启动自动生成；bridgeToken 用随机 32 字节 base64url。
// 该文件在生成时就把上游 mneme token 写进去（查证结论 §4：8790 的 Bearer token 存
// 于 memory.db user_settings kv，部署机上直接预填，README 说明可改）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 本目录 = mneme-bridge/，config.json 与 logs/ 都挂在这里，与进程 CWD 无关
// （Windows 下从任意目录 node F:/.../server.js 都能找到自己的配置）。
export const BRIDGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 配置路径默认在 mneme-bridge/ 下；MNEME_BRIDGE_CONFIG 环境变量可整体重定向——
// 多实例并行（不同端口/不同库）与测试都用它，测试因此可以完全不碰真实 config.json。
export const CONFIG_PATH = process.env.MNEME_BRIDGE_CONFIG
  ? process.env.MNEME_BRIDGE_CONFIG
  : join(BRIDGE_ROOT, "config.json");

/** 配置缺省值。字段含义见 README.md「配置」。 */
function defaults() {
  return {
    // 监听面：0.0.0.0 是为了手机/局域网设备可达。安全边界完全靠 bridgeToken
    // （timingSafeEqual 常量时间比较），README 明示：仅限家庭局域网，公网勿开。
    port: 8760,
    host: "0.0.0.0",
    // 首次生成随机 token：base64url(32 字节) = 43 字符，与 mneme token 同熵级
    bridgeToken: randomBytes(32).toString("base64url"),
    mneme: {
      // DSH standalone API（查证结论：DSH 进程内启动，面板「设置→外部访问」开启）
      url: "http://127.0.0.1:8790",
      // remote 模式上游 token：DSH 面板「设置→外部访问」开启后由 mneme 生成，
      // 存于 memory.db user_settings kv。首次部署：从 mneme 面板复制到这里（README「配置」）。
      // 留空 = remote 模式 401，auto 模式会自动落到 embedded（无需 token）。
      token: "",
      // auto = 启动时探测 8790/health：活着走 remote，否则 embedded。
      // remote / embedded = 强制指定（文档 §1：进程内粘滞，不做热切换）。
      mode: "auto",
      // embedded 模式 import 的 mneme lib 与数据目录。
      // 留空 = 自动探测常见安装位置（DSH 默认 ~/.dsh；找不到时看日志提示，
      // 或按 README「配置」手工填写）。
      libPath: "",
      dataDir: "",
      // 探测超时（ms）：1s 是设计文档 §1 的值——8790 在本机，环回探测足够
      probeTimeoutMs: 1000,
      // 上游请求超时（ms）：设计文档 §4 用 10s
      requestTimeoutMs: 10000,
      // GET /memory/context 组合路由（v0.2）：pins 取 importance>=5 的高价值
      // 记忆条数上限；related 搜索默认条数（query 未带 topK 时生效）。
      // loadOrCreateConfig 的浅合并保证老配置文件缺这两个键时自动补默认值。
      contextPinsLimit: 5,
      contextRelatedTopK: 6
    },
    // 对话链路的 bridge 侧去重（任务硬性要求）：sha256(user+\n+assistant) 的 LRU
    conversation: {
      capacity: 500
    },
    // v0.4 导入闸（task-9）：单批导入的字符预算。/memory/import/estimate 按同
    // 口径给预估数，/memory/import 落库前最后确认——超限返回 400 too-large 让
    // 扩展回 L1 减勾选，绝不静默截断（用户在 L3 确认过预算，数字必须真实）。
    import: {
      maxImportChars: 1500000
    },
    // v0.3 对话蒸馏器：缓冲的网页对话由 DSH headless 批量总结后入库（B 路线）。
    // 全自动触发：dsh-probe 每 probeIntervalMs 探测 DSH Web 端口，离线→在线跳变
    // 且有缓冲时执行一轮；DSH 不在时静默缓冲（用户需求：零人工）。
    distill: {
      // false = 完全关闭蒸馏器（探测也不跑）
      enabled: true,
      // DSH Web 探测目标（3080 = dsh web 默认端口）
      dshHost: "127.0.0.1",
      dshWebPort: 3080,
      probeIntervalMs: 60000,
      // dsh CLI 命令（PATH 里有 dsh 即可；装在全局或 npx 环境时可改全路径）
      dshCommand: "dsh",
      // 单次 headless 调用超时（批量蒸馏可能较慢，给足 4 分钟）
      headlessTimeoutMs: 240000,
      // 单轮最多取多少条待蒸馏对话（防止首轮积压过大）
      batchLimit: 60
    }
  };
}

/**
 * 读 config.json；不存在时生成（首次启动自举）。返回 { config, created }。
 * 生成文件从 defaults() 深拷贝——预填 token/路径，README 指引用户按需修改。
 */
export function loadOrCreateConfig() {
  if (existsSync(CONFIG_PATH)) {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // 浅合并顶层 + mneme：config.json 允许只写想覆盖的字段（向后兼容新增键）
    const base = defaults();
    const config = {
      ...base, ...parsed,
      mneme: { ...base.mneme, ...(parsed.mneme ?? {}) },
      import: { ...base.import, ...(parsed.import ?? {}) },
      distill: { ...base.distill, ...(parsed.distill ?? {}) }
    };
    return { config, created: false };
  }
  // 首次生成。JSON.stringify(…, null, 2) 带缩进，用户手工可读可改。
  const config = defaults();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { config, created: true };
}