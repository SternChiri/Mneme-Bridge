// lib/embedded.js —— embedded 模式后端：in-process 组装 mneme service
// 组装链对齐上游 lib/index.js 的 apply 流程：
//   mkdir memoryDir → createStore(memory.db) → createSettings(store.db)
//   → createMirror(memoryDir, lang) → createService({store, mirror, config, logger})
//   → service.recoverMirror()
// 已核对签名（lib 实测）：
//   createMirror(dir, language = "zh")              → { filePath, sync, readHumanEdits }
//   createService({store, mirror, config, logger, …}) —— documentIndex/writeAdmission
//     不传安全：内部全走 if-guard
//   saveWithDedupe(memory) → { action: "created"|"merged", memory }（拒绝 type:"document"）
//   service.search(q, {limit})   同步关键词（store.search 透传）
//   service.searchMemories(q, {mode, topK, useRerank}) 异步混合检索
//   service.list({limit, order:"chrono"})、service.count(type?)、service.toApiList(rows)
import fs from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loggerFor } from "./log.js";
import { pathToFileURL } from "node:url";

const log = loggerFor("embedded");

/** embedded 模式的错误：4xx 语义（参数/type 非法）用 McBadRequest 承载。 */
export class McBadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = "McBadRequest";
  }
}

/**
 * 创建 embedded 后端。
 * @param {{ libPath: string, dataDir: string, contextPinsLimit?: number }} mnemeCfg
 *   config.mneme 切片（contextPinsLimit：/memory/context 的 pins 条数上限）
 */
export async function createEmbeddedBackend(mnemeCfg) {
  let { libPath, dataDir } = mnemeCfg;
  // /memory/context 组装端是否排除 sensitivity 标注条目（默认排除）
  const ctxExcludeSensitive = mnemeCfg.contextExcludeSensitive !== false;
  // 配置留空时自动探测常见安装位置——
  //   libPath：DSH 默认 $DSH_HOME 或 ~/.dsh 下的 profiles/web/node_modules/@modusensus/dsh-mneme/lib
  //   dataDir：同一 DSH_HOME 下的 memory 目录
  const os = await import("node:os");
  const candidates = [];
  const dshHome = process.env.DSH_HOME || join(os.homedir(), ".dsh");
  if (!libPath) {
    candidates.push(
      join(dshHome, "profiles", "web", "node_modules", "@modusensus", "dsh-mneme", "lib"),
      join(dshHome, "node_modules", "@modusensus", "dsh-mneme", "lib")
    );
    for (const c of candidates) { if (fs.existsSync(c)) { libPath = c; break; } }
  }
  if (!dataDir) {
    const dc = [join(dshHome, "memory"), join(os.homedir(), ".dsh", "memory")];
    for (const c of dc) { if (fs.existsSync(c)) { dataDir = c; break; } }
  }
  if (!libPath || !dataDir) {
    throw new Error("embedded 模式需要 mneme.libPath 与 mneme.dataDir：自动探测失败（DSH 未安装或装在非常规位置）。请在 config.json 的 mneme 段手工填写，或改用 remote 模式（README「配置」）。");
  }
  // 版本门控——lib/ 是 src 同步产物，内部签名无稳定性契约，
  // 行号级耦合每次发版都可能断。读安装包 package.json，超出已验证区间（allowedLibRange，
  // 默认 "^0.8"）明确拒绝启动，提示升级 bridge 或显式放宽区间。
  // 区间语法（自实现，不引依赖）：^MAJOR.MINOR = major 相同且 minor ≥ MINOR。
  {
    const range = mnemeCfg.allowedLibRange || "^0.8";
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(join(libPath, "..", "package.json"), "utf8"));
    } catch { /* package.json 读不到时跳过门控（非标准安装），日志提示 */ }
    if (pkg && typeof pkg.version === "string") {
      const m = pkg.version.match(/^(\d+)\.(\d+)(\.(\d+))?/);
      const r = range.match(/^\^(\d+)\.(\d+)$/);
      if (m && r) {
        const [vmaj, vmin] = [Number(m[1]), Number(m[2])];
        const [rmaj, rmin] = [Number(r[1]), Number(r[2])];
        const ok = vmaj === rmaj && vmin >= rmin;
        if (!ok) {
          throw new Error(
            "embedded: mneme lib 版本 " + pkg.version + " 超出已验证区间 " + range +
            "（内部签名无稳定性契约，强行为之可能炸库或静默错数据）。" +
            "请升级 mneme-bridge 到适配版本，或在 config.json mneme.allowedLibRange 显式放宽（自担风险）。"
          );
        }
        log.info("lib-version-check", { version: pkg.version, range });
      } else {
        log.warn("lib-version-unparseable", { version: pkg.version, range });
      }
    } else {
      log.warn("lib-version-unknown", { libPath });
    }
  }
  // 逐个动态 import：某一模块缺失时错误信息能精确指到是哪个文件，
  // 便于排查「libPath 指错版本」这类部署问题。
  // Windows 下动态 import 的路径必须是 file:// URL：裸盘符路径 "F:/..." 的
  // "F:" 会被 default ESM loader 当成未知 protocol 直接拒载。pathToFileURL 同时
  // 处理空格/中文路径的百分号编码；对已是 file:// 的配置值幂等。
  const libUrl = pathToFileURL(libPath.endsWith("/") ? libPath : libPath + "/").href;
  let mod;
  try {
    mod = {
      store: await import(new URL("store.js", libUrl).href),
      settings: await import(new URL("settings.js", libUrl).href),
      mirror: await import(new URL("mirror.js", libUrl).href),
      service: await import(new URL("service.js", libUrl).href)
    };
  } catch (err) {
    throw new Error(`embedded: cannot import mneme lib at ${libPath}: ${err?.message ?? err}`);
  }

  const dbPath = join(dataDir, "memory.db");
  // 先 mkdir 再开库——目录不存在时 node:sqlite 直接抛。
  // dataDir 自动探测指向 $DSH_HOME/memory（或 ~/.dsh/memory），junction 上 mkdirSync 是幂等 no-op。
  mkdirSync(dataDir, { recursive: true });

  const store = mod.store.createStore(dbPath);
  // createSettings(db)：用户偏好（profile/rules/panel）与记忆表同库不同表。
  // 捕获返回值：/memory/context 组合路由要读 getProfile()/getRules()
  // （profile 未设置时返回 ""，rules 容错解析返回 string[]）。
  const settings = mod.settings.createSettings(store.db);

  // mirror：设计文档 §3 与 index.js L255 一致，镜像目录 = memoryDir 本身——
  // createMirror 的 dir 就是数据目录，TYPE_FILE 映射的偏好.md/项目.md 等
  // 人可读镜像直接落在数据目录里（与 DSH 内运行时同布局），language 固定 zh。
  const mirror = mod.mirror.createMirror(dataDir, "zh");

  // config 传最小集：language 参与镜像渲染与去重标题；显式关掉 document 子系统
  // 与质量过滤这两个「bridge 场景不需要」的重功能（都受 config 门控，关 = 走默认
  // 轻路径）。不传 documentIndex/writeAdmission：service 内部 if-guard 安全。
  const service = mod.service.createService({
    store,
    mirror,
    config: { language: "zh", documentMemoryEnabled: false },
    logger: {
      // mneme 期待 console 风格 logger（info/warn/error）；转成单行 JSON 混流
      info: (...a) => log("info", "mneme", { msg: a.map(String).join(" ") }),
      warn: (...a) => log("warn", "mneme", { msg: a.map(String).join(" ") }),
      error: (...a) => log("error", "mneme", { msg: a.map(String).join(" ") })
    }
  });

  // index.js L286：上一次镜像同步失败留下的 dirty 状态，启动时安全重渲一次。
  // 永不抛错（内部自吞），失败则 dirty 留待下次。
  service.recoverMirror();

  log.info("embedded-assembled", { dbPath, libPath });

  // /memory/context 的 pins 条数上限（config.mneme.contextPinsLimit，默认 5）
  const pinsLimit = Number.isInteger(mnemeCfg.contextPinsLimit) && mnemeCfg.contextPinsLimit > 0
    ? mnemeCfg.contextPinsLimit
    : 5;

  // mneme save 允许的字段白名单：多余键（扩展侧手滑多传的）直接丢掉，
  // 不给 mneme 内部 schema 校验添乱。type:"document" 被 saveWithDedupe 硬拒
  // ，提前拦下给出友好 400 而不是内部错误。
  const SAVE_FIELDS = ["type", "title", "content", "importance", "tags", "source", "sensitivity", "occurred_at", "agent_scope", "workspace_scope"];
  const TYPE_RE = /^(preference|project|decision|history|rejected_solution|pitfall|constraint)$/;

  return {
    backend: "embedded",

    // 蒸馏器需要直查库（按 tags 读待蒸馏/写状态标记）。
    store,

    /** embedded 永远健康（服务就在本进程）；接口对齐 remote.health。 */
    async health() {
      return { ok: true, status: 200, json: { ok: true, backend: "embedded" } };
    },

    /**
     * 保存：service.saveWithDedupe。返回 {status, json} 形状与 remote 一致：
     * created → 201 / merged → 200（对齐 mneme REST 语义，查证结论 §4）。
     */
    async save(body) {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new McBadRequest("invalid-body");
      }
      if (body.type === "document") {
        throw new McBadRequest("type 'document' is minted only via registerDocument");
      }
      if (!TYPE_RE.test(String(body.type ?? ""))) {
        throw new McBadRequest(`invalid-type: ${String(body.type)}`);
      }
      if (typeof body.title !== "string" || !body.title.trim() || typeof body.content !== "string") {
        throw new McBadRequest("title and content are required strings");
      }
      const memory = {};
      for (const k of SAVE_FIELDS) {
        if (body[k] !== undefined) memory[k] = body[k];
      }
      let result;
      try {
        result = service.saveWithDedupe(memory);
      } catch (err) {
        // mneme 内部对必填字段有自己的校验（如 type 枚举、importance 范围），
        // 这里兜底转 400 语义——上游 REST 对非法参数也是 4xx 而非 5xx。
        throw new McBadRequest(`save failed: ${err?.message ?? err}`);
      }
      const status = result.action === "created" ? 201 : 200;
      return { status, json: { ...service.toApiList([result.memory])[0], action: result.action } };
    },

    /**
     * 搜索：优先 searchMemories（混合检索；无 embedder 时内部自动退化关键词），
     * 失败再退化到同步 service.search——与 mneme standalone /search 的两级
     * 容错同构。返回 {status, json:{items, mode}}。
     */
    async search(q, { mode = "auto", topK = 5, agentScope = undefined, workspaceScope = undefined } = {}) {
      const query = String(q ?? "").trim();
      if (!query) return { status: 200, json: { items: [], mode: "keyword" } };
      // scope 透传——searchMemories 的 scope 选项形状
      // {agent_scope, workspace_scope}，只在显式传入时生效（A2 软加权 / strictScope
      // 硬过滤均由 lib 内部处理）；不传与旧行为逐字节一致。
      const scope = (agentScope !== undefined || workspaceScope !== undefined)
        ? { agent_scope: agentScope ?? null, workspace_scope: workspaceScope ?? null }
        : null;
      try {
        const rows = await Promise.resolve(
          service.searchMemories(query, { mode, topK, useRerank: true, scope })
        );
        const used = rows.some((m) => m.vector === true) ? "vector" : "keyword";
        return { status: 200, json: { items: service.toApiList(rows), mode: used } };
      } catch {
        // 向量/重排链路任何失败都退化关键词：搜索绝不 5xx（mneme 同款语义）
        return { status: 200, json: { items: service.toApiList(service.search(query, { limit: topK })), mode: "keyword" } };
      }
    },

    /**
     * 最近列表：GET /memories?order=chrono 同语义——store.list 的 order:"chrono"
     * 即 updated_at DESC（store.js），用 toApiList 裁剪出 REST 同形 DTO。
     */
    async recent(limit) {
      const rows = service.list({ limit, order: "chrono" });
      return { status: 200, json: { items: service.toApiList(rows), total: rows.length } };
    },

    /**
     * 按类型/分组列出记忆（面板用）。
     * type=单类型；types=逗号分隔多类型；limit/order 透传 store.list。
     */
    listByType({ type = null, types = null, limit = 50, order = "chrono" } = {}) {
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      if (type) {
        const rows = service.list({ limit: lim, order, type });
        return { status: 200, json: { items: service.toApiList(rows), total: rows.length, type } };
      }
      if (types) {
        const list = String(types).split(",").map((s) => s.trim()).filter(Boolean);
        const per = Math.max(5, Math.ceil(lim / Math.max(list.length, 1)));
        const out = [];
        for (const t of list) {
          const rows = service.list({ limit: per, order, type: t });
          for (const r of rows) out.push(r);
        }
        return { status: 200, json: { items: service.toApiList(out), total: out.length, types: list } };
      }
      const rows = service.list({ limit: lim, order });
      return { status: 200, json: { items: service.toApiList(rows), total: rows.length } };
    },

    /**
     * 状态：对齐 mneme /status 的形状（version/memories.total/uptime_s），
     * 另加 backend:"embedded" 供扩展侧显示。version 从 package.json 读真值，
     * 读不到再落 api-standalone.js 里的硬编码兜底。
     */
    async status() {
      let version = "0.7.12";
      try {
        const pkgUrl = pathToFileURL(join(libPath, "../package.json")).href;
        const pkg = JSON.parse(await import(pkgUrl).then((m) => m.default ?? m));
        version = pkg.version;
      } catch { /* 读不到就保守给已知硬编码值 */ }
      const byType = {};
      for (const t of ["preference", "project", "decision", "history", "summary", "pattern", "rejected_solution", "pitfall", "constraint", "document"]) {
        try {
          byType[t] = service.count(t);
        } catch { byType[t] = 0; }
      }
      return {
        status: 200,
        json: {
          version,
          backend: "embedded",
          dataDir,
          memories: { total: service.count(), byType },
          uptime_s: Math.floor(process.uptime())
        }
      };
    },

    /**
     * 组合上下文（/memory/context）：一次请求返回
     * { profile, rules, pins, related }——画像 + 行为规则 + 高价值记忆 + 相关记忆。
     * 解决「网页端只有近期记忆、没有全局信息」：扩展首开页面时调本路由即可
     * 拿到完整上下文，不用自己拼四个请求。
     */
    async context(q, topK) {
      // 优先走宿主注入管线 service.injectCandidates——端点全语义（优先级分层 /
      // pin 前置 / 质量加权 / coding 门控）。降级路径（旧 lib / 端点失败 /
      // contextSource="heuristic"）为朴素身份记忆直查（preference/constraint 且 importance>=4）。
      // bridge 侧职责保留：sensitivity 过滤 + 元记忆过滤 + 4 字段瘦身 + pins/related
      // 兼容形状（前 pinsLimit 条 → pins，其余 → related，上游已排好序）。
      // config.mneme.contextSource: "auto"（默认）| "endpoint"（仅端点，失败即错）|
      // "heuristic"（跳过端点直接走降级直查）。injectCandidates 缺失（<0.8.14 的 lib）
      // 一律视为降级条件。
      const ctxSource = mnemeCfg.contextSource === "heuristic" ? "heuristic"
        : mnemeCfg.contextSource === "endpoint" ? "endpoint" : "auto";
      if (ctxSource !== "heuristic" && typeof service.injectCandidates === "function") {
        try {
          const query = String(q ?? "").trim();
          const pinnedStats = {};
          const items = service.toApiList(service.injectCandidates({
            query,
            maxItems: topK + pinsLimit,   // 上游一次给足；bridge 侧再切 pins/related
            threshold: 3                  // importance 阈值（injectCandidates 语义）
          }));
          if (Array.isArray(items)) {
            const exclSens = mnemeCfg.contextExcludeSensitive !== false;
            const isMeta = (t, tagsField) => {
              let tags = tagsField;
              if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
              if (Array.isArray(tags) && (tags.includes("meta") || tags.includes("self_referential"))) return true;
              return /^(v?\d+\.\d+|bridge|mneme[- ]?(bridge|edge)|扩展\s?0|0\.5\.\d)/i.test(String(t || ""));
            };
            const slimE = (arr) => (Array.isArray(arr) ? arr : [])
              .filter((m) => (!exclSens || m.sensitivity === undefined || m.sensitivity === null || m.sensitivity === "") && !isMeta(m.title, m.tags))
              .map((m) => ({
                title: m.title,
                content: m.content != null ? String(m.content).slice(0, 160) : "",
                importance: m.importance,
                type: m.type
              }));
            const all = slimE(items);
            let profileE = "";
            try { profileE = typeof settings.getProfile() === "string" ? settings.getProfile() : ""; } catch { /* 降级空串 */ }
            let rulesE = [];
            try {
              const raw = settings.getRules();
              rulesE = Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : [];
            } catch { /* 同上 */ }
            log.info("context-via-injectCandidates", { total: all.length, pins: Math.min(all.length, pinsLimit) });
            return {
              status: 200,
              json: {
                profile: profileE,
                rules: rulesE,
                pins: all.slice(0, pinsLimit),
                related: all.slice(pinsLimit)
              },
              via: "endpoint"
            };
          }
          if (ctxSource === "endpoint") throw new Error("injectCandidates returned non-array");
          log.warn("context-injectCandidates-degrade", { itemsType: typeof items });
        } catch (err) {
          if (ctxSource === "endpoint") throw err;
          log.warn("context-injectCandidates-error", { msg: String(err?.message ?? err) });
          // 落入下方降级主体
        }
      } else if (ctxSource === "endpoint") {
        throw new Error("contextSource=endpoint requires mneme lib >= 0.8.14 (service.injectCandidates missing)");
      }
      // profile：用户自述（settings.getProfile，未设置返回 ""）
      const query = String(q ?? "").trim();
      let profile = "";
      try {
        profile = typeof settings.getProfile() === "string" ? settings.getProfile() : "";
      } catch { /* settings 表异常不阻断聚合，降级空串 */ }
      // rules：行为规则（settings.getRules 容错解析，恒 string[]）
      let rules = [];
      try {
        const raw = settings.getRules();
        rules = Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : [];
      } catch { /* 同上降级空数组 */ }

      // 降级直查 pins：preference/constraint 且 importance>=4，按重要度排序，
      // 宁缺毋滥；profile 兜底「我是谁」，related 仍按话题检索。
      let pins = [];
      try {
        const seen = new Set();
        const push = (rows) => {
          for (const r of service.toApiList(rows)) {
            if (pins.length >= pinsLimit) break;
            if (seen.has(r.title)) continue;
            if (ctxExcludeSensitive && r.sensitivity !== undefined && r.sensitivity !== null && r.sensitivity !== "") continue;
            seen.add(r.title);
            pins.push(r);
          }
        };
        // 分类型直查（store.list 的 type 参数是单值）：preference/constraint 各取一批。
        for (const t of ["preference", "constraint"]) {
          try {
            const rows = service.list({ type: t, limit: 150, order: "importance", minImportance: 4 });
            push(rows);
          } catch (e) { /* 单类失败不拖垮 */ }
        }
      } catch (err) {
        log.warn("context-pins-failed", { msg: String(err) });
      }

      // related：相关记忆。q 为空串直接跳过搜索（mneme /search 对空 q 也回空）；
      // searchMemories 任何失败（向量/重排链路）退化为空数组——聚合路由的子项
      // 失败不该拖垮整体响应。
      // related 排除「元记忆」——mneme/DSH 开发过程记录（tags 含 meta/
      // self_referential，或 title 是版本号/修复报告形态）属于工具自身的演进日志，
      // 对网页端任何聊天都是噪音。
      // 判别：tags 含 meta/self_referential，或 title 以版本号/bridge 形态开头。
            const isMeta = (t, tagsField) => {
        // tags 兼容两种形态：数组（service 原始行）与 JSON 字符串（API DTO）
        let tags = tagsField;
        if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
        if (Array.isArray(tags) && (tags.includes("meta") || tags.includes("self_referential"))) return true;
        return /^(v?\d+\.\d+|bridge|mneme[- ]?(bridge|edge)|扩展\s?0|0\.5\.\d)/i.test(String(t || ""));
      };
      // sensitivity 标注的记忆不随注入出境（sensitivity 在
      // mneme 侧只是标签、不参与可见性；context 组装端默认排除，config.contextExcludeSensitive 可关）。
      const exclSens = ctxExcludeSensitive !== false;   // 默认 true
      const notSensitive = (r) => !exclSens || r.sensitivity === undefined || r.sensitivity === null || r.sensitivity === "";
      const relatedFilter = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => !isMeta(r.title, r.tags) && notSensitive(r));

      let related = [];
      if (query) {
        try {
          const rows = await Promise.resolve(
            service.searchMemories(query, { mode: "auto", topK: topK * 2, useRerank: true })
          );
          related = relatedFilter(service.toApiList(rows)).slice(0, topK);   // 先扩招再滤元记忆
        } catch {
          try {
            // 关键词兜底再失败才真给 []：与 search 路由的两级容错同构
            related = relatedFilter(service.toApiList(service.search(query, { limit: topK * 2 }))).slice(0, topK);
          } catch { related = []; }
        }
      }

      // 关键词直查补路——语义检索对自然语言问句打分失焦，专名命中会被通用偏好挤出 topK。
      // 做法：query 按 2-4 字滑窗抽词，
      // 每个词用 keyword 检索计命中数，选命中最多的词补一轮检索并入 related（去重）。
      try {
        // 停用词只做「整词相等」判断（前缀匹配会把整句误丢）
        const STOPW = new Set(["什么是", "一个", "什么样", "怎么样", "还是", "然后", "可以", "我们",
          "你们", "我觉得", "你觉得", "请问", "帮我", "继续", "以及", "而且", "但是", "如果",
          "现在", "这个", "那个", "到底", "究竟", "关于", "为什么", "怎么", "如何", "应该",
          "没有", "有的", "是不是", "有没有", "一下", "一些", "什么", "怎么", "思考", "感觉",
          "时候", "空间", "地方", "方面", "问题", "其实", "确实", "可能", "就是", "不是"]);
        // 寒暄检测——纯问候（你好/嗨/hello/在吗…，≤6 字）没有话题，不做关键词补路。
        const GREETING = /^(你好|您好|哈喽|嗨|hello|hi|hiya|在吗|早上好|下午好|晚上好|早安|晚安|你好呀|大家好|喂)[呀啊哈呗呢～~！!。.？?]*/i;
        const isGreeting = query.length <= 6 && GREETING.test(query.trim());
        const segs = isGreeting ? [] : String(query || "").replace(/[？?！!，,。.、\s]+/g, " ").split(" ").filter((s) => s.length >= 2);
        const cand = new Map();
        for (const seg of segs) {
          for (let L = 2; L <= Math.min(4, seg.length); L++) {
            for (let i = 0; i + L <= seg.length; i++) {
              const w = seg.slice(i, i + L);
              if (STOPW.has(w) || cand.has(w)) continue;
              cand.set(w, 0);
            }
          }
        }
        let best = null, bestN = 0;
        const top = [];
        let totalMems = 0;
        try { totalMems = service.list({ limit: 5000 }).length; } catch { totalMems = 0; }
        const tally = [];
        for (const w of cand.keys()) {
          let n = 0;
          try { n = (service.search(w, { limit: 30 }) || []).length; } catch { n = 0; }
          tally.push(w + "=" + n);
          // 「全库占比」判别：命中数占全库 >15% 的是万能词（如"没有"）排除；
          // 其余按 (命中数 × 词长) 打分（长词信息量高），取前 3 词各自召回后合并。
          if (totalMems > 0 && n / totalMems > 0.15) continue;
          if (n >= 3) {
            const sc = n * w.length;
            if (!best || sc > bestN) { bestN = sc; best = w; }
            top.push({ w, n, sc });
          }
        }
        log.info("context-kw-tally", { top: tally.sort((a, b) => Number(b.split("=")[1]) - Number(a.split("=")[1])).slice(0, 6) });
        // 多词投票——top 前置词各召回一轮合并置顶，每词配额 ceil(topK/词数) 防止首个词独占。
        top.sort((a, b) => b.sc - a.sc);
        const words = top.slice(0, 3);
        if (words.length) {
          const perWord = Math.max(2, Math.ceil(topK / words.length));
          const seenKw = new Set();
          const kwList = [];
          for (const { w } of words) {
            let rows = [];
            try { rows = await Promise.resolve(service.searchMemories(w, { mode: "keyword", topK: perWord })); }
            catch { try { rows = service.search(w, { limit: perWord }); } catch { rows = []; } }
            for (const r of relatedFilter(service.toApiList(rows))) {
              if (kwList.length >= topK) break;
              if (seenKw.has(r.title)) continue;
              seenKw.add(r.title);
              kwList.push(r);
            }
            if (kwList.length >= topK) break;
          }
          const oldTitles = new Set(kwList.map((m) => m.title));
          const rest = related.filter((m) => !oldTitles.has(m.title));
          related.splice(0, related.length, ...kwList, ...rest);
          if (related.length > topK) related.length = topK;
          log.info("context-kw-boost", { words: words.map((x) => x.w + "=" + x.n), boosted: kwList.length, total: related.length });
        }
      } catch (e) { /* 关键词补路失败不影响主链 */ }

      // 每条只留 {title, content, importance, type} 且 content 截 160 字——
      // 注入 prompt 的场景不需要 id/tags/时间戳，瘦身能显著省 token。
      const slim = (items) => (Array.isArray(items) ? items : []).map((m) => ({
        title: m.title,
        content: m.content != null ? String(m.content).slice(0, 160) : "",
        importance: m.importance,
        type: m.type
      }));

      return { status: 200, json: { profile, rules, pins: slim(pins), related: slim(related) } };
    },

    /**
     * 收尾：关库。node:sqlite 的 close 会在未 finalize 的语句上抛，吞掉即可——
     * 进程马上退出，WAL 会在下次打开时回放，不丢已提交事务。
     */
    async close() {
      try {
        store.db.close();
        log.info("embedded-db-closed", { dbPath });
      } catch (err) {
        log.warn("embedded-db-close-failed", { msg: String(err) });
      }
    }
  };
}