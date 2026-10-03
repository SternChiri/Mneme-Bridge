// lib/distiller.js —— 对话蒸馏器（v0.3；v0.4 会话级断点续跑 + 摘要卡提示词）
// 职责：把缓冲的网页对话按会话分组，交给 DSH headless 批量蒸馏成 mneme 记忆条目
// （JSON 数组），经 backend.save 入库并把原始对话标记为已蒸馏。
// LLM 来源：DSH headless（dsh --profile headless，stdin 传任务，stdout 出答案）。
// 全自动触发：dsh-probe.js 探测到 DSH (3080) 就绪后调用 runIfPending()；
// DSH 没开就静默缓冲，什么都不发生（用户需求：完全自动化）。
// v0.4（task-9）：
//   ①会话级断点续跑——蒸馏前查会话标记（tags 的 imp-sess:<sid>distilled），
//     已完成会话整组跳过；中断重跑不重复烧 API。
//   ②摘要卡输入形态识别——条目带 distill_kind:"summary-card" 时换用「提炼跨
//     会话持久偏好/项目脉络/重要决定，单会话细节丢弃」提示词（三层漏斗 L3）。
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loggerFor } from "./log.js";

const log = loggerFor("distiller");

/** 创建蒸馏器。opts: {config, backend, loadPending, loadAllPending?, markDistilled, isSessionDone, markSessionDone} */
export function createDistiller(opts) {
  const config = opts.config;
  const backend = opts.backend;
  const loadPending = opts.loadPending;
  const loadAllPending = opts.loadAllPending;   // v0.5.11：手动「立即蒸馏」强制全量
  const markDistilled = opts.markDistilled;
  // v0.4 会话级断点续跑 API（server.js 从 pendingStore 注入；未注入时退化为
  // 无会话记忆——行为与 v0.3 一致，不影响单测直连构造）
  const isSessionDone = opts.isSessionDone || null;
  const markSessionDone = opts.markSessionDone || null;
  let running = false;

  /** DSH headless 一次调用：task 走 stdin，resolve(stdout)。 */
  function runHeadless(task, timeoutMs) {
    return new Promise((resolve, reject) => {
      const dc = config.distill || {};
      // Windows 坑（实测两次）：①spawn 解析到 .CMD shim（dsh.CMD）必须 shell:true
      // 否则 EINVAL；②shell:true 时 args 数组只做字符串拼接、不转义——含空格的
      // 路径（node 在 C:\Program Files\nodejs）会被截断。对策：win32 下把命令与
      // 参数拼成单字符串（含空格的段手工加引号），以 window 原生语义执行。
      const useShell = process.platform === "win32";
      const extraArgs = Array.isArray(dc.dshArgs) ? dc.dshArgs : [];
      const quote = (s) => (/s/.test(s) ? '"' + s + '"' : s);
      let child;
      // v0.5.9e：task 经临时文件送达（headless agent 有 Read 工具，实测可读）。
      // argv 直传 5.5 万字符会 ENAMETOOLONG（Windows 32K 上限）；CLI 0.1.x 又不支持 stdin task。
      const taskFile = join(tmpdir(), "mneme-distill-" + Date.now() + ".txt");
      writeFileSync(taskFile, task, "utf8");
      const argvTask = "读取文件 " + taskFile + " ，严格按文件内容中的指示完成蒸馏任务，只输出指示要求的 JSON。";
      if (useShell) {
        const cmdParts = [dc.dshCommand || "dsh", ...extraArgs, "--profile", "headless", quote(argvTask)].map(quote);
        child = spawn(cmdParts.join(" "), {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: true
        });
      } else {
        // v0.5.9d：task 走 stdin + "-" 参数（0.1.x CLI 支持；argv 直传 5.5 万字符会 ENAMETOOLONG）
        const args = extraArgs.concat(["--profile", "headless", "-"]);
        child = spawn(dc.dshCommand || "dsh", args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* noop */ }
        reject(new Error("dsh headless timeout " + timeoutMs + "ms"));
      }, timeoutMs);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        try { unlinkSync(taskFile); } catch (e) { /* 清理失败无所谓 */ }
        if (code === 0) resolve(out);
        else reject(new Error("dsh headless exit " + code + ": " + err.slice(-400)));
      });
      // v0.5.9c：0.1.x headless CLI 的 task 是命令行参数（不是 stdin）——
      // stdin 喂法会报 "a task is required" 秒退（write EOF 根因）。task 直接进 argv。
      child.stdin.end();
    });
  }

  /** 从 headless 输出抠 JSON 数组（容忍 markdown 围栏与前后杂文本）。 */
  function extractJsonArray(text) {
    const fence = String.fromCharCode(96).repeat(3); // 三连反引号，运行时构造避免源码字面量
    let body = text;
    const fs2 = body.indexOf(fence + "json");
    if (fs2 >= 0) {
      const fe = body.indexOf(fence, fs2 + fence.length + 4);
      if (fe > fs2) body = body.slice(fs2 + fence.length + 4, fe);
    }
    const start = body.indexOf("[");
    const end = body.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(body.slice(start, end + 1)); } catch (e) { return null; }
  }

  /**
   * 组蒸馏任务（记忆类型标准对齐 mneme 七型）。
   * v0.4 双形态：
   * - isCard=false（全文对话，实时链路或旧导入）：逐轮编号，常规蒸馏。
   * - isCard=true（摘要卡，L2 产物）：提示词换成「提炼跨会话的持久偏好/项目
   *   脉络/重要决定；单会话细节一律丢弃」——卡片两端信息密度高，但单卡细节
   *   不值得进记忆库（设计文档「为什么不会丢有用信息」节）。
   */
  function buildTask(entries, isCard) {
    // v0.5：与 mneme 官方 summarize 管线对齐——
    //   prompt 逐字复用 mneme lang.js PROMPTS.summary/codingSummary（zh）；
    //   transcript 用官方格式（用户：/助手：全角冒号）；
    //   产出 = 官方原子记忆（type 白名单、importance 1-5、JSON 数组）。
    // 摘要卡形态（isCard）保留 bridge 侧跨会话卡专用词（官方管线无此输入形态）。
    const transcript = entries.map((e, i) =>
      "[" + (i + 1) + "] " + String(e.occurred_at || e.created_at || "").slice(0, 16) +
      "\n用户：" + String(e.user || "").slice(0, 2000) +
      "\n助手：" + String(e.assistant || "").slice(0, 2000)
    ).join("\n\n");
    if (isCard) {
      return [
        "你是记忆库提炼助手。下面是若干会话的摘要卡（编号条目），每张卡由该会话的",
        "首条用户消息、末条用户消息与助手首句压缩而成。",
        "请从中提炼【跨会话】的持久原子记忆：反复出现的偏好、延续的项目脉络、重要决定。",
        "单会话内部细节一律丢弃——摘要卡是提纯后的原料，不要还原成会话记录。",
        "原子记忆原则：每条只装一个独立事实，短小、自带完整上下文；宁可拆成多条也绝不合并丢细节。",
        "只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5}。",
        "无跨会话共性就输出 []；不要杜撰。不要输出任何其他文字。",
        "",
        "摘要卡：",
        transcript
      ].join("\n");
    }
    return [
      "你是记忆库提炼助手。根据下面的会话内容，提炼值得跨会话记住的原子记忆。",
      "原子记忆原则：每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（把数字、名字、路径、结论等原始细节保留在 content 里，不要抽象概括）；宁可拆成多条也绝不合并丢细节。信息量一般提 2-4 条，信息密集的对话可提 4-8 条。",
      "反复述防御：对话开头若出现 [记忆参考 | ...] 注入块（来自本机记忆库的历史记忆）或助手在寒暄中复述既有记忆（如『我记得你之前…』），这些内容是已入库记忆的重提，一律不得再次提炼入库；只提炼本对话中**新产生的**事实、决定与偏好。纯寒暄且无新信息的会话输出 []。",
      "只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history|rejected_solution|pitfall|constraint\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5}。",
      "若对话涉及编码/调试，可额外提取编码类记忆：",
      "- rejected_solution：被否决/废弃的实现方案（content 含方案简述 + 被否决原因 + 最终采用方案）",
      "- pitfall：调试踩坑记录（content 含现象/报错 + 根因 + 解决/规避方法）",
      "- constraint：项目工程约束（content 含约束描述 + 来源）",
      "普通闲聊、临时无关对话一律不提取编码类记忆。不要输出任何其他文字。",
      "",
      "会话内容：",
      transcript
    ].join("\n");
  }
  /** 主入口：有待蒸馏对话时执行一轮蒸馏（探测器触发或手动）。 */
  let runQueue = Promise.resolve();   // v0.5.11b：蒸馏请求串行排队（撞锁不再静默丢弃）
  async function runIfPending(force) {
    if (running) {
      log.info("distill-queued");   // 排队而非丢弃：上一轮结束后本请求自动执行
      const p = runQueue.then(() => runIfPendingInner(force));
      runQueue = p.catch(() => {});
      return p;
    }
    return runIfPendingInner(force);
  }
  async function runIfPendingInner(force) {
    running = true;
    try {
      const entries = force && typeof loadAllPending === 'function' ? await loadAllPending() : await loadPending();
      log.info("distill-load", { force: !!force, count: entries.length, via: force && typeof loadAllPending === 'function' ? 'all' : 'idle' });
      if (!entries.length) return { skipped: "empty" };

      // ---- 会话级断点续跑（v0.4）--------------------------------------------
      // 蒸馏前先剔掉已完成会话：中断（进程被杀/DSH 中途离线/断电）后重跑时，
      // 已蒸馏会话不再二次烧 API；同会话迟到批次（扩展分批上报 >MAX_BATCH 的
      // 大会话）同样跳过。跳过决策发生在 load 之后、任何 LLM 调用之前。
      let skippedSessions = 0;
      let pool = entries;
      if (isSessionDone) {
        const seenSids = new Set();
        const skippedSids = new Set();
        pool = entries.filter((e) => {
          if (!e.session_id) return true;      // 无会话标记的条目不参与会话级跳过
          // v0.5.23 修复：此前这里「同会话只保留首条」——配合下文的 markSessionDone(整会话排空)，
          // 导致一个 69 轮会话只蒸第 1 轮，其余 68 条被静默标 done（内容永久丢失）。
          // 正确语义：同一会话的全部待蒸条目都要进 pool（随后按会话分组一次蒸馏）。
          const __isd = isSessionDone(e.session_id);
          if (__isd) {
            skippedSessions++;
            skippedSids.add(e.session_id);
            return false;
          }
          return true;
        });
        if (skippedSids.size > 0) {
          // 被跳过会话的迟到条目也要标 distilled：会话已由此前批次蒸馏过，
          // 迟到批次不再烧 API（任务要求）；不标记则它们永久滞留 pending，
          // 每轮 load 都捞出来再跳一遍，状态机永远排不空。
          const skippedIds = entries
            .filter((e) => e.session_id && skippedSids.has(e.session_id))
            .map((e) => e.id);
          try { await markDistilled(skippedIds); } catch (e) { /* 标记失败下轮再试 */ }
          log.info("distill-resume-skip", { sessions: skippedSessions, marked: skippedIds.length, remain: pool.length, ids: skippedIds.slice(0, 3) });
        }
      }
      if (!pool.length) return { skipped: "all-sessions-done", skippedSessions };

      log.info("distill-run-start", { count: pool.length, skippedSessions });
      // 按会话分组：同 sessionId 一组一次 headless 调用（蒸馏输入去重的最小单元）
      const groups = new Map();
      for (const e of pool) {
        const key = e.session_id || "default";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      // v0.5.21：null-sid 的 historical 原料全部落到 "default" 桶（不是真实会话），
      // 大批量重蒸时会塞成一次巨型 headless 调用（易截断/超时）。按 24 条分块摊平。
      if (groups.has("default") && groups.get("default").length > 24) {
        const bucket = groups.get("default");
        groups.delete("default");
        for (let i = 0; i < bucket.length; i += 24) {
          groups.set("legacy#" + (i / 24 + 1), bucket.slice(i, i + 24));
        }
        log.info("distill-legacy-chunked", { total: bucket.length, chunks: Math.ceil(bucket.length / 24) });
      }
      let saved = 0;
      let failedGroups = 0;
      for (const [sid, group] of groups) {
        try {
          // 摘要卡形态：组内任一条目带 summary-card 即整组按卡片提示词蒸馏
          // （同会话的导入条目形态一致；混组时以卡片口径优先，提炼而非复述）
          const isCard = group.some((e) => e.distill_kind === "summary-card");
          const task = buildTask(group, isCard);
          const timeoutMs = (config.distill && config.distill.headlessTimeoutMs) || 240000;
          const out = await runHeadless(task, timeoutMs);
          const items = extractJsonArray(out);
          if (!items) { log.warn("distill-parse-fail", { sid: sid.slice(0, 8), head: out.slice(0, 160) }); failedGroups++; continue; }
          for (const it of items) {
            if (!it || typeof it !== "object") continue;
            const TYPES = ["preference", "project", "decision", "history", "pitfall", "constraint", "rejected_solution"];
            if (!TYPES.includes(it.type)) continue;
            if (typeof it.title !== "string" || !it.title.trim()) continue;
            if (typeof it.content !== "string" || !it.content.trim()) continue;
            // v0.3.37：正式记忆继承会话归属——
            //   ① tags 继承源条目的 imp-sess:<sid>（面板/检索可按会话过滤、溯源到原始会话）
            //   ② occurred_at 用源条目的会话时间（此前用蒸馏时刻，丢失了"这条记忆来自何时"）
            const sessTags = group
              .flatMap((e) => (Array.isArray(e.tags) ? e.tags : []))
              .filter((t) => typeof t === "string" && (t.startsWith("imp-sess:") || t === "summary-card" || t === "import" || t === "edge"));
            const sessTime = (() => {
              for (const e of group) {
                const v = e.occurred_at || e.created_at;
                if (!v) continue;
                // v0.3.38：统一 ISO（数字秒/毫秒 → ISO；字符串验证可解析）
                if (typeof v === "number" && isFinite(v) && v > 0) {
                  const ms = v >= 1e12 ? v : v > 1e9 ? v * 1000 : 0;
                  if (ms) return new Date(ms).toISOString();
                }
                const d = new Date(String(v));
                return isNaN(d.getTime()) ? null : d.toISOString();
              }
              return null;
            })();
            const memory = {
              type: it.type,
              title: it.title.trim().slice(0, 60),
              content: it.content.trim().slice(0, 1000) +
                "\n\n(蒸馏自 " + group.length + " 轮网页对话" + (sid !== "default" ? "，会话 " + sid.slice(0, 8) : "") + (isCard ? "，摘要卡形态" : "") + ")",
              importance: Math.min(5, Math.max(1, Math.round(Number(it.importance) || 3))),   // v0.3.38：整数化（schema INTEGER）
              tags: (Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === "string").slice(0, 4) : [])   // v0.3.38：LLM tags ≤4（会话标记另加，总量 ≤9）
                .concat(sessTags.filter((t) => !it.tags || !it.tags.includes(t)).slice(0, 4))
                .concat(["distilled"]),
              // v0.5.18：source 带会话短 id（对齐 DSH 内记忆的 source=会话id 形态——
              // mneme UI 来源列直接可读；无 sid 时保持 dsh-distiller）
              // v0.5.21：legacy#N 是 null-sid 原料的合成分块键（非真实会话）——不写入来源
              source: (sid !== "default" && !sid.startsWith("legacy#")) ? "dsh-distiller:web/" + sid.slice(0, 8) : "dsh-distiller",
              occurred_at: sessTime || new Date().toISOString()
            };
            const r = await backend.save(memory);
            if (r.status === 201 || r.status === 200) saved++;
          }
          await markDistilled(group.map((e) => e.id));
          // 会话级登记：即使该会话还有后续批次没上报，先到的条目已足以让
          // 下轮跳过（isSessionDone 查「任一完成」）。markSessionDone 幂等。
          if (markSessionDone && sid !== "default") {
            // v0.5.23：不再整会话排空——批量上限可能截断会话，排空会把未蒸馏条目一起标 done。
        // 只标本组已蒸馏的 id；会话是否完成由 buffer.isSessionDone（零 pending）判定。
          }
          log.info("distill-group-done", { sid: sid.slice(0, 8), entries: group.length, items: items.length, card: isCard });
        } catch (err) {
          failedGroups++;
          log.warn("distill-group-fail", { sid: sid.slice(0, 8), msg: String((err && err.message) || err).slice(0, 200) });
        }
      }
      const summary = { groups: groups.size, saved, failedGroups, skippedSessions };
      log.info("distill-run-done", summary);
      return summary;
    } finally {
      running = false;
    }
  }

  return { runIfPending };
}
