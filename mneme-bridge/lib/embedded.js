// lib/embedded.js —— embedded 模式后端：in-process 组装 mneme 0.8.9 service
// 组装链照抄 lib/index.js L191-286（apply）：
//   mkdir memoryDir → createStore(memory.db) → createSettings(store.db)
//   → createMirror(memoryDir, lang) → createService({store, mirror, config, logger})
//   → service.recoverMirror()
// 已核对签名（2026-09-28，lib 实测）：
//   createMirror(dir, language = "zh")              → { filePath, sync, readHumanEdits }
//   createService({store, mirror, config, logger, …}) —— documentIndex/writeAdmission
//     不传安全：内部全走 if-guard（service.js L1257/L1829）
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
  // v0.5.40（开源化）：配置留空时自动探测常见安装位置——
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
  // index.js L195：先 mkdir 再开库——目录不存在时 node:sqlite 直接抛。
  // dataDir 自动探测指向 $DSH_HOME/memory（或 ~/.dsh/memory），junction 上 mkdirSync 是幂等 no-op。
  mkdirSync(dataDir, { recursive: true });

  const store = mod.store.createStore(dbPath);
  // createSettings(db)：用户偏好（profile/rules/panel）与记忆表同库不同表。
  // v0.2 起捕获返回值：/memory/context 组合路由要读 getProfile()/getRules()
  // （settings.js L331/L339：profile 未设置时返回 ""，rules 容错解析返回 string[]）。
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
  // （service.js L1140），提前拦下给出友好 400 而不是内部错误。
  const SAVE_FIELDS = ["type", "title", "content", "importance", "tags", "source", "sensitivity", "occurred_at", "agent_scope", "workspace_scope"];
  const TYPE_RE = /^(preference|project|decision|history|rejected_solution|pitfall|constraint)$/;

  return {
    backend: "embedded",

    // v0.3：蒸馏器需要直查库（按 tags 读待蒸馏/写状态标记）。
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
     * 容错同构（api-standalone.js L515-528）。返回 {status, json:{items, mode}}。
     */
    async search(q, { mode = "auto", topK = 5 } = {}) {
      const query = String(q ?? "").trim();
      if (!query) return { status: 200, json: { items: [], mode: "keyword" } };
      try {
        const rows = await Promise.resolve(
          service.searchMemories(query, { mode, topK, useRerank: true })
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
     * 即 updated_at DESC（store.js L1448），用 toApiList 裁剪出 REST 同形 DTO。
     */
    async recent(limit) {
      const rows = service.list({ limit, order: "chrono" });
      return { status: 200, json: { items: service.toApiList(rows), total: rows.length } };
    },

    /**
     * v0.5（面板增强②）：按类型/分组列出记忆。
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
     * 组合上下文（v0.2 /memory/context）：一次请求返回
     * { profile, rules, pins, related }——画像 + 行为规则 + 高价值记忆 + 相关记忆。
     * 解决「网页端只有近期记忆、没有全局信息」：扩展首开页面时调本路由即可
     * 拿到完整上下文，不用自己拼四个请求。
     */
    async context(q, topK) {
      // profile：用户自述（settings.js L331，未设置返回 ""）
      const query = String(q ?? "").trim();   // v0.5.28：提前声明（pins 场景匹配也要用）
      let profile = "";
      try {
        profile = typeof settings.getProfile() === "string" ? settings.getProfile() : "";
      } catch { /* settings 表异常不阻断聚合，降级空串 */ }
      // rules：行为规则（settings.js L339，容错解析，恒 string[]）
      let rules = [];
      try {
        const raw = settings.getRules();
        rules = Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : [];
      } catch { /* 同上降级空数组 */ }

      // v0.5.12（用户裁决）：pins 语义改为「关于我」——新会话开场 DS 应知道的是
      // 用户画像级记忆（偏好/约束），不是最近在做的项目。两级取材：
      //   第一级：preference/constraint 且 importance>=4（身份记忆，按重要度+时间）
      //   第二级：不足 pinsLimit 再补 importance=5 的其他类型（项目里程碑等，排后）
      let pins = [];
      try {
        const seen = new Set();
        const push = (rows) => {
          for (const r of service.toApiList(rows)) {
            if (pins.length >= pinsLimit) break;
            if (seen.has(r.title)) continue;
            seen.add(r.title);
            pins.push(r);
          }
        };
        // 分类型直查（store.list 的 type 参数是单值）：preference/constraint 各取一批。
        // v0.5.24（用户裁决）：现在 profile 已承载"我是谁"，pins 改收「通用交互偏好」——
        // 即聊天/语气/输出格式类偏好（如"聊天要简短""不要AI腔"），排除项目协作类
        // （简历/设定/提示词工程/调试规矩——这些只在相关话题时经 related 出现）。
        // 判别：title 或 content 含交互词（聊天/语气/称呼/简短/格式/排版/说/答）且
        // 不含项目词（简历/设定/提示词/教案/论文/推演/调试/导入/UI/DSH）。
        // 白名单点名式（v0.5.24b）：黑名单总有漏网（发言稿/文献/讲课），反转为只认
        // 日常对话交互类关键词——宁缺毋滥，命中不足就少给几条，画廊由 profile 兜底。
        // v0.5.24d：title 命中即收（title 是蒸馏器起的主题句，最可靠）；content 不参与
        // 匹配——正文常提"论文/讲"等词导致误杀（如「聊天要求简短，不要长篇大论」正文含"论文"）。
        const INTERACT = /(聊天|简短|AI腔|AI 味|口语化|称呼|错别字|音近错字|纠错|歌词|波浪号|唱歌|说话|语气|长篇大论|音译|直译)/;
        const PROJECTISH = /(简历|设定|提示词|教案|跑团|人格|量表|检索|考古|推演|调试|导入|DSH|版本|发言稿|文献|论文|综述|答辩|课|改写|翻译)/;
        // v0.5.28：pins 场景匹配——交互偏好分「全场通用」与「场景专属」两类。
        // 通用（聊天简短/口语化/称呼/纠错）无条件注入；场景专属（文书语气→写文书时、
        // 唱歌歌词→点歌时）只在 query 触及对应场景才注入，否则是噪音（用户实测指出）。
        const SCENE = [
          { re: /文书|个人陈述|自我介绍|简历|求职信|申请|面试/, pin: /文书|AI味|AI 腔|陈述/ },
          { re: /唱歌|歌词|唱一|点歌|来一首|唱首/, pin: /歌词|波浪号|唱歌/ },
        ];
        for (const t of ["preference", "constraint"]) {
          try {
            const rows = service.list({ type: t, limit: 150, order: "importance", minImportance: 3 })
              .filter((r) => {
                const title = r.title || "";
                return INTERACT.test(title) && !PROJECTISH.test(title);
              })
              .sort((a, b) => (b.importance || 0) - (a.importance || 0));
            push(rows);
          } catch (e) { /* 单类失败不拖垮 */ }
        }
        // 场景过滤收口：query 未触及场景的专属 pin 移除
        for (const s of SCENE) {
          if (!s.re.test(query)) {
            pins = pins.filter((p) => !s.pin.test(p.title || ""));
          }
        }
        // v0.5.24c：第二级（其他类型 imp5 补位）整体移除——画像已承载身份信息，
        // 项目里程碑/医学案例塞进新会话开场只会重演"注入无关记忆"。宁缺毋滥，
        // 交互偏好命中几条给几条，不足就让 pins 为空（related 仍按话题检索）。
      } catch (err) {
        log.warn("context-pins-failed", { msg: String(err) });
      }

      // related：相关记忆。q 为空串直接跳过搜索（mneme /search 对空 q 也回空）；
      // searchMemories 任何失败（向量/重排链路）退化为空数组——聚合路由的子项
      // 失败不该拖垮整体响应。
      // v0.5.31：related 排除「元记忆」——mneme/DSH 开发过程记录（tags 含 meta/
      // self_referential，或 title 是版本号/修复报告形态）属于工具自身的演进日志，
      // 对网页端任何聊天都是噪音（"你好呀"召回 5 条开发记录的事故）。
      // 判别：tags 含 meta/self_referential，或 title 以 v0./0.5./bridge 等版本形态开头。
            const isMeta = (t, tagsField) => {
        // tags 兼容两种形态：数组（service 原始行）与 JSON 字符串（API DTO）
        let tags = tagsField;
        if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
        if (Array.isArray(tags) && (tags.includes("meta") || tags.includes("self_referential"))) return true;
        return /^(v?\d+\.\d+|bridge|mneme[- ]?(bridge|edge)|扩展\s?0|0\.5\.\d)/i.test(String(t || ""));
      };
      const relatedFilter = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => !isMeta(r.title, r.tags));

      let related = [];
      if (query) {
        try {
          const rows = await Promise.resolve(
            service.searchMemories(query, { mode: "auto", topK: topK * 2, useRerank: true })
          );
          related = relatedFilter(service.toApiList(rows)).slice(0, topK);   // v0.5.31：先扩招再滤元记忆
        } catch {
          try {
            // 关键词兜底再失败才真给 []：与 search 路由的两级容错同构
            related = relatedFilter(service.toApiList(service.search(query, { limit: topK * 2 }))).slice(0, topK);
          } catch { related = []; }
        }
      }

      // v0.5.27：关键词直查补路——语义检索对自然语言问句（"…是一个什么样的朝代？"）打分
      // 失焦，专名命中（如"凉朝"22 条）被通用偏好挤出 topK。做法：query 按 2-4 字滑窗抽词，
      // 每个词用 keyword 检索计命中数，选命中最多的词补一轮检索并入 related（去重）。
      try {
        // 停用词只做「整词相等」判断（此前用前缀 test，把"你觉得凉朝…"整句丢掉了）
        const STOPW = new Set(["什么是", "一个", "什么样", "怎么样", "还是", "然后", "可以", "我们",
          "你们", "我觉得", "你觉得", "请问", "帮我", "继续", "以及", "而且", "但是", "如果",
          "现在", "这个", "那个", "到底", "究竟", "关于", "为什么", "怎么", "如何", "应该",
          "没有", "有的", "是不是", "有没有", "一下", "一些", "什么", "怎么", "思考", "感觉",
          "时候", "空间", "地方", "方面", "问题", "其实", "确实", "可能", "就是", "不是"]);
        // v0.5.31：寒暄检测——纯问候（你好/嗨/hello/在吗…，≤6 字）没有话题，
        // 不做关键词补路（此前「你好呀」boost 命中"你好"字样，召回的全是 mneme 开发元记忆）。
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
          // v0.5.30（用户裁决：>25 硬排除一刀切，话题记忆涨多后会永久失明）：
          // 改为「全库占比」判别 + 多词投票。命中数占全库 >15% 的是万能词（"没有"）排除；
          // 其余按 (命中数 × 词长) 打分（长词信息量高），取前 3 词各自召回后合并。
          if (totalMems > 0 && n / totalMems > 0.15) continue;
          if (n >= 3) {
            const sc = n * w.length;
            if (!best || sc > bestN) { bestN = sc; best = w; }
            top.push({ w, n, sc });
          }
        }
        log.info("context-kw-tally", { top: tally.sort((a, b) => Number(b.split("=")[1]) - Number(a.split("=")[1])).slice(0, 6) });
        // v0.5.30：多词投票——top 前置词各召回一轮合并置顶（凉朝 22 条 + 科举 13 条都能进），
        // 每词配额 ceil(topK/词数) 防止首个词独占。
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