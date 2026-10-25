/*
 * Codex++ user script: Codex Full Steward
 *
 * Watches the current Codex thread for the localized 429/server-overloaded
 * state. After the selected delay it clicks the explicit retry button once.
 * No screenshots, network calls, request bodies, or conversation content are
 * stored.
 */
(() => {
  "use strict";

  const VERSION = "2.1.0";
  const PRODUCT_NAME = "Codex Full Steward Plugin";
  const PRODUCT_TITLE = "Codex Full Steward";
  const PANEL_SECTION_ORDER = Object.freeze(["steward", "plan", "r429"]);
  const ATTRIBUTION = "Built By Yang YiZhu";
  // steward 解析重试上限（轮询次数）：超过后把「人工审核」条目写进计划板并复位，避免无限挂起
  const STEWARD_PARSE_MAX_RETRIES = 60;
  const SETTINGS_KEY = "codex429Guardian.settings.v1";
  const DELIVERY_STATE_KEY = "codex429Guardian.deliveryState.v1";
  const DELIVERY_REQUEST_KEY = "codex429Guardian.deliveryRequest.v1";
  const CREDENTIAL_REQUEST_KEY = "codex429Guardian.credentialRequest.v1";
  const PANEL_POS_KEY = "codex429Guardian.panel.pos.v1";
  const STATE_KEY = "__CODEX_429_GUARDIAN__";
  const STYLE_ID = "codex-429-guardian-style";
  const HOST_ATTR = "data-codex-429-guardian";
  const MAX_WAIT_AFTER_DUE_MS = 10 * 60 * 1000;
  // 后台守护：未打开的会话也能倒计时 + 切回前台触发；默认开
  const BACKGROUND_KEY = "codex429Guardian.background.v1";
  const STEWARD_BOOTSTRAP_KEY = "codex429Guardian.stewardBootstrap.v1";
  const BG_MAX_THREADS = 12;


  function normalizeSettings(raw) {
    const maxConsecutive =
      raw?.maxConsecutive === 3 || raw?.maxConsecutive === 5 || raw?.maxConsecutive === 8
        ? raw.maxConsecutive
        : 5;
    const stewardMode = ["review", "review-next", "review-fixes", "review-optimize", "review-develop", "review-accept", "review-perf", "review-docs", "off"].includes(raw?.stewardMode)
      ? raw.stewardMode
      : "review";
    const stewardTimeoutMs = [300000, 600000, 900000].includes(raw?.stewardTimeoutMs)
      ? raw.stewardTimeoutMs
      : 300000;
    const stewardWritePlan = raw?.stewardWritePlan !== false;
    const stewardAutoImport = raw?.stewardAutoImport !== false;
    // LLM 供应商（v1.8.38）：管家窗口直连模型做审核总结 + 下一步计划
    const llmProviders = ["openai", "anthropic", "dashscope", "deepseek", "openrouter", "ollama", "custom"];
    const llmProvider = llmProviders.includes(raw?.llmProvider)
      ? raw.llmProvider : "openai";
    const llmFallbackProvider = llmProviders.includes(raw?.llmFallbackProvider)
      ? raw.llmFallbackProvider : "";
    const llmProfiles = Array.isArray(raw?.llmProfiles)
      ? raw.llmProfiles.filter((profile) => profile && typeof profile === "object").slice(0, 4).map((profile, index) => ({
        id: typeof profile.id === "string" ? profile.id : (index === 0 ? "primary" : `backup-${index}`),
        provider: llmProviders.includes(profile.provider) ? profile.provider : "custom",
        baseUrl: typeof profile.baseUrl === "string" ? profile.baseUrl : "",
        model: typeof profile.model === "string" ? profile.model : "",
        enabled: profile.enabled !== false,
        priority: Number.isFinite(Number(profile.priority)) ? Number(profile.priority) : index + 1,
        credentialRef: typeof profile.credentialRef === "string" ? profile.credentialRef : (index === 0 ? "primary" : `backup-${index}`),
      }))
      : [];
    return {
      enabled: raw?.enabled !== false,
      delaySeconds: raw?.delaySeconds === 180 ? 180 : 60,
      maxConsecutive,
      background: raw?.background !== false,
      // 管家模式（steward）：主任务完成后审核并把结果写入计划板
      // v1.8.38 起走「LLM 直连」通道（不再依赖 Codex 侧边聊天）
      steward: raw?.steward === true,
      // 无人值守：开启后守护进程在每次任务完成时自动审核（无需点击）
      stewardAuto: raw?.stewardAuto === true,
      stewardMode,
      stewardTimeoutMs,
      stewardWritePlan,
      stewardAutoImport,
      llmProvider,
      llmBaseUrl: typeof raw?.llmBaseUrl === "string" ? raw.llmBaseUrl : "",
      llmApiKey: typeof raw?.llmApiKey === "string" ? raw.llmApiKey : "",
      llmModel: typeof raw?.llmModel === "string" ? raw.llmModel : "",
      llmProfiles,
      llmFallbackProvider,
      llmFallbackBaseUrl: typeof raw?.llmFallbackBaseUrl === "string" ? raw.llmFallbackBaseUrl : "",
      llmFallbackModel: typeof raw?.llmFallbackModel === "string" ? raw.llmFallbackModel : "",
      llmFallbackEnabled: raw?.llmFallbackEnabled === true,
      llmProxyPort: [0, 57321, 8443, 8000, 8791, 8792, 9000, 9090].includes(raw?.llmProxyPort) ? raw.llmProxyPort : 8443,
      // 项目根目录：守护进程据此读取目录结构 / README / HANDOFF.md 等，建立整体理解
      projectRoot: typeof raw?.projectRoot === "string" ? raw.projectRoot : "",
    };
  }

  function formatCountdown(seconds) {
    const value = Math.max(0, Math.ceil(Number(seconds) || 0));
    return value <= 0 ? "即将重试" : `${value} 秒后重试`;
  }

  function normalizeButtonText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isRetryButtonText(text) {
    const value = normalizeButtonText(text);
    return (
      /^\d+\s*秒后重试$/.test(value) ||
      /^重试$/.test(value) ||
      /^(?:继续|继续任务|开始|开始重试|发送|提交)$/.test(value) ||
      /^(?:Retry(?:\s+in\s+\d+s)?|Continue|Start|Resume|Send|Submit)$/i.test(value)
    );
  }

  function retryButtonPriority(button) {
    const values = [button?.text, button?.ariaLabel].map(normalizeButtonText);
    if (values.some((value) => /^(?:发送|提交|Send|Submit)$/i.test(value))) return 100;
    if (values.some((value) => /^\d+\s*秒后重试$|^重试$|^Retry(?:\s+in\s+\d+s)?$/i.test(value))) return 90;
    if (values.some((value) => /^(?:继续|继续任务|开始|开始重试|Continue|Start|Resume)$/i.test(value))) return 80;
    return 0;
  }

  function turnIdFromUnitKey(key) {
    const value = String(key || "");
    const separator = value.indexOf(":");
    return separator > 0 ? value.slice(0, separator) : value || null;
  }

  function visibleTurnContext(units) {
    const visible = (units || []).filter(
      (unit) => unit && unit.visible !== false && String(unit.text || "").trim(),
    );
    if (!visible.length) return { turnId: null, text: "", units: [] };

    const latest = visible.at(-1);
    const turnId = latest.turnId || turnIdFromUnitKey(latest.key);
    if (!turnId) return { turnId: null, text: latest.text || "", units: [latest] };

    const currentUnits = visible.filter(
      (unit) => (unit.turnId || turnIdFromUnitKey(unit.key)) === turnId,
    );
    return {
      turnId,
      text: currentUnits.map((unit) => unit.text || "").join("\n"),
      units: currentUnits,
    };
  }

  function classifyTaskStatus({
    is429,
    hasUnexpectedStop,
    hasStopButton,
    hasAssistantOutput,
  }) {
    if (is429) return "429";
    if (hasUnexpectedStop) return "unexpected";
    if (hasStopButton) return "running";
    if (hasAssistantOutput) return "completed";
    return "unknown";
  }

  function taskStatusLabel(status) {
    switch (status) {
      case "429":
        return "任务遇到 429";
      case "unexpected":
        return "任务意外停止";
      case "running":
        return "任务运行中";
      case "completed":
        return "任务已完成";
      default:
        return "等待任务";
    }
  }

  function isUnexpectedStopText(text) {
    return /(?:\b(?:error|failed|stopped|interrupted|cancelled|canceled|timed\s*out|timeout|disconnected)\b|任务(?:已)?(?:停止|中断|失败)|意外停止|连接失败|请求失败|超时|无法继续|重试次数)/i.test(
      String(text || ""),
    );
  }

  function nextTaskStatusState({
    currentStatus,
    candidateStatus,
    pendingStatus,
    pendingSinceMs,
    nowMs,
    debounceMs = 700,
  }) {
    if (candidateStatus === currentStatus) {
      return { status: candidateStatus, pendingStatus: null, pendingSinceMs: 0 };
    }
    if (candidateStatus === "429" || candidateStatus === "running") {
      return { status: candidateStatus, pendingStatus: null, pendingSinceMs: 0 };
    }
    if (pendingStatus !== candidateStatus) {
      return { status: currentStatus, pendingStatus: candidateStatus, pendingSinceMs: nowMs };
    }
    if (Number(nowMs) - Number(pendingSinceMs) >= debounceMs) {
      return { status: candidateStatus, pendingStatus: null, pendingSinceMs: 0 };
    }
    return { status: currentStatus, pendingStatus, pendingSinceMs };
  }

  function detectPageSignals({
    turnText,
    statusTexts,
    buttons,
    hasStopButton,
    threadId,
    turnId,
  }) {
    const texts = Array.isArray(statusTexts) ? statusTexts : [turnText];
    const is429 = texts.some((text) =>
      /服务器繁忙|Server is busy|HTTP\s*429|Too Many Requests|请求过多|速率限制/i.test(
        String(text || ""),
      ),
    );

    const retryButton =
      (buttons || [])
        .filter(
          (button) =>
            button &&
            !button.disabled &&
            (isRetryButtonText(button.text) || isRetryButtonText(button.ariaLabel)),
        )
        .sort((left, right) => retryButtonPriority(right) - retryButtonPriority(left))[0] ||
      null;

    return {
      is429,
      hasStopButton,
      retryButton,
      retryReady: Boolean(!hasStopButton && retryButton),
      eventKey: threadId && turnId ? `${threadId}:${turnId}` : null,
      threadId: threadId || null,
      turnId: turnId || null,
    };
  }

  function shouldClickRetry({
    enabled,
    nowMs,
    dueAtMs,
    state,
    currentThreadId,
    handledEventKey,
    capWindowExceeded = false,
  }) {
    // 时间窗内 429 次数已达上限：停止自动点击
    if (capWindowExceeded) return false;
    return Boolean(
      enabled &&
        Number.isFinite(dueAtMs) &&
        dueAtMs > 0 &&
        nowMs >= dueAtMs &&
        state &&
        state.retryReady &&
        state.retryButton &&
        state.eventKey &&
        state.threadId === currentThreadId &&
        handledEventKey !== state.eventKey,
    );
  }

  function shouldEnterWaitingRetry({
    activeEventMatches,
    hasRetryButton,
    phase,
    eventKey,
    handledEventKey,
  }) {
    return Boolean(
      activeEventMatches &&
        hasRetryButton &&
        phase !== "handled" &&
        (!eventKey || handledEventKey !== eventKey),
    );
  }

  function isRecoveryConfirmed({
    clickedEventKey,
    currentEventKey,
    hasStopButton,
    retryButtonVisible,
    is429,
  }) {
    if (hasStopButton) return true;
    if (clickedEventKey && currentEventKey && clickedEventKey !== currentEventKey) return true;
    return !retryButtonVisible && !is429;
  }


  // ===== 计划板（plan board）纯函数 =====
  // 任务显示「已完成」时，把下一段计划文本写入 composer 并发送，让 Codex 进入下一段计划。

  const PLAN_MAX_ENTRIES = 50;

  // 计划条目：{ text, done }。导入时发 text（不带序号、不带 done 标记）。
  function normalizePlanEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        if (typeof entry === "string") {
          const text = entry.replace(/\r\n/g, "\n").trim();
          return text ? { text, done: false } : null;
        }
        if (entry && typeof entry === "object") {
          const text = String(entry.text || "").replace(/\r\n/g, "\n").trim();
          return text ? { text, done: entry.done === true } : null;
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, PLAN_MAX_ENTRIES);
  }

  // 单线程计划态：{ enabled, entries, index, delaySeconds }
  // v1.9.11：默认 30 秒；只有用户显式点过 10 秒（delayUserChosen=true）才保留 10。
  // 之前的「一次性迁移标记」方案有缺陷——标记一旦置位，后续新桶的 10 秒就再也不修了。
  function migrateDelayTo30(threads) {
    const next = {};
    let changed = false;
    for (const k of Object.keys(threads || {})) {
      const v = threads[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (v.delayUserChosen !== true && v.delaySeconds !== 30) {
          next[k] = { ...v, delaySeconds: 30 };
          changed = true;
          continue;
        }
      }
      next[k] = v;
    }
    return changed ? next : threads;
  }

  function normalizePlanSettings(raw) {
    return {
      enabled: raw?.enabled === true,
      entries: normalizePlanEntries(raw?.entries),
      index: Number.isInteger(raw?.index) && raw.index >= 0 ? raw.index : 0,
      // v1.9.3：默认 30 秒（给用户留出阅读时间）
      delaySeconds: raw?.delaySeconds === 10 ? 10 : 30,
      // 倒计时开关：关掉后计划就绪也不自动导入，等手动点「立即导入」
      countdownEnabled: raw?.countdownEnabled !== false,
      delayUserChosen: raw?.delayUserChosen === true,
    };
  }

  // 当前应导入的条目（未 done 且 index 指向它）；越界/空返回 null。
  function planImportText(plan) {
    if (!plan || !plan.enabled) return null;
    if (plan.index < 0 || plan.index >= plan.entries.length) return null;
    const entry = plan.entries[plan.index];
    if (!entry) return null;
    return entry.text;
  }

  // 导入成功后：把当前条目标记 done，index 前进到下一条。
  function nextPlanIndex(plan) {
    if (!plan) return 0;
    const clamped = Math.min(Math.max(plan.index, 0), plan.entries.length - 1);
    return Math.min(clamped + 1, plan.entries.length);
  }

  // v1.9.14：依据只留在管家日志，写进计划板的必须是干净指令。
  // 去掉「【依据】…→」「【动作】」等标记，只保留可执行正文。
  function stripEvidenceForPlan(text) {
    const raw = String(text || "");
    const lines = raw.split("\n").map((line) => {
      let s = line;
      // 去掉 「N. 【依据】xxx → 」前缀，保留编号
      s = s.replace(/(\d+[.、)]\s*)【依据】[\s\S]*?→\s*/g, "$1");
      // 去掉残留的 【依据】… 段（没有箭头时）
      s = s.replace(/【依据】[^→\n]*/g, "");
      // 去掉「依据：xxx →」写法（无方括号）
      s = s.replace(/(\d+[.、)]\s*)?依据[:：][\s\S]*?→\s*/g, "$1");
      s = s.replace(/依据[:：][^→\n]*/g, "");
      // 去掉 【动作】/【验收】标签，保留内容
      s = s.replace(/【(?:动作|验收)】/g, "");
      return s.replace(/\s+$/, "");
    }).filter((l) => l.trim().length > 0 && !/^\s*【依据】/.test(l));
    return lines.join("\n").trim();
  }

  // v1.9.11：关闭倒计时 = 暂停计划板向主会话输出。自动导入必须同时满足：
  // 计划模式开 + 倒计时开 + 还有未完成段
  function canAutoImport(plan) {
    if (!plan || plan.enabled !== true) return false;
    if (plan.countdownEnabled === false) return false;
    if (!Array.isArray(plan.entries) || plan.entries.length === 0) return false;
    if (Number(plan.index) >= plan.entries.length) return false;
    return true;
  }

  // 判断 plan 是否「当前线程视角」可导入（线程由调用方传入对应线程的 plan 对象）。
  // v1.9.13：判断上一段任务的结果是否「完整可接班」。
  // 规则：有实际正文（去空白后 >= MIN_RESULT_CHARS）、不是只有占位/省略、且没有进行中标志。
  const MIN_RESULT_CHARS = 40;
  function isResultComplete({ text, hasStop, taskStatus }) {
    if (hasStop) return false;
    if (taskStatus !== "completed") return false;
    const body = String(text || "").replace(/\s+/g, " ").trim();
    if (body.length < MIN_RESULT_CHARS) return false;
    // 仅有占位/截断标记，视为不完整
    if (/^(?:\.{3}|…|无|暂无|待补充|TODO)$/i.test(body)) return false;
    return true;
  }

  function shouldImportPlan({
    plan,
    taskStatus,
    composerBusy,
    nowMs,
    lastImportAtMs = 0,
    importCooldownMs = 4000,
    planDueAtMs = 0,
    resultComplete = false,
  }) {
    if (!plan || !plan.enabled) return false;
    if (!plan.entries.length) return false;
    if (taskStatus !== "completed") return false;
    // v1.9.13：必须确认「上一段任务已完成且输出完整结果」才允许导入
    if (resultComplete !== true) return false;
    if (composerBusy) return false;
    if (plan.index >= plan.entries.length) return false;
    // 若该段已完成（用户标记或导入后），不应重复发同一文本：跳到第一条未完成
    // （运行时保证 index 已越过已 done 段，这里仅作防御）
    // 必须到达计划倒计时到期点（任务完成后等 delaySeconds 再导入）
    if (Number(planDueAtMs) > 0 && Number(nowMs) < Number(planDueAtMs)) return false;
    if (Number(nowMs) - Number(lastImportAtMs) < importCooldownMs) return false;
    return true;
  }

  // 取当前线程的计划态；不存在则返回一个干净的默认（不含 threadId）。
  function planForThread(threads, threadId) {
    const id = threadId || "default";
    if (threads && threads[id]) {
      const own = normalizePlanSettings(threads[id]);
      return own;
    }
    if (id === "default" && threads && threads["default"]) return normalizePlanSettings(threads["default"]);
    return normalizePlanSettings(null);
  }

  // 保留多个会话的独立计划桶（最多 20 个），避免切换会话时把其他计划丢掉。
  // 只保留「值是线程计划态」的键；v1 遗留的字段键(enabled/entries/index/threadId/delaySeconds)会被丢掉
  function prunePlanThreads(threads, activeThreadId) {
    if (!threads || typeof threads !== "object") return {};
    const keep = {};
    for (const key of Object.keys(threads)) {
      // v1.9.9：数字键是「数组被 spread 成对象」的产物，属于脏数据，直接丢弃
      if (/^\d+$/.test(key)) continue;
      const v = threads[key];
      // 线程计划态：对象且带 entries 数组；default 桶也接受
      const isThreadPlan = v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.entries);
      if (isThreadPlan) keep[key] = v;
    }
    const keys = Object.keys(keep);
    if (keys.length <= 20) return keep;
    const retained = new Set(keys.slice(-20));
    if (keep.default) retained.add("default");
    if (activeThreadId && keep[activeThreadId]) retained.add(activeThreadId);
    return Object.fromEntries([...retained].map((key) => [key, keep[key]]));
  }

  // 把线程计划态写回 threads 容器（深拷贝当前 plan 字段）。
  function upsertThreadPlan(threads, threadId, plan) {
    const next = threads && typeof threads === "object" ? { ...threads } : {};
    const id = threadId || "default";
    next[id] = {
      enabled: plan.enabled,
      entries: plan.entries,
      index: plan.index,
      delaySeconds: plan.delaySeconds,
      countdownEnabled: plan.countdownEnabled !== false,
      delayUserChosen: plan.delayUserChosen === true,
    };
    return next;
  }

  // 统计某线程已完成的段数（用于面板进度显示）。
  function planCompletedCount(plan) {
    if (!plan) return 0;
    return plan.entries.filter((e) => e && e.done === true).length;
  }

  // ===== 管家模式（steward）纯函数 =====
  // 主任务完成后：把「主任务输出 + 项目状态 + 页面渲染的 md 产物」喂给侧边聊天，
  // 让侧边 agent 做批判性审核（提炼 / 判断最终效果 / 指出短板 / 给修改步骤 / 给下一步计划），
  // 插件再把侧边产出的「修改步骤」「下一步计划」解析出来写回计划板，避免主任务数据污染与模型幻想。

  // 构建发给侧边聊天的审核指令。所有引用都来自插件已抓到的真实文本，绝不虚构。
  // ===== 长文本审核：摘要 + 分段 =====
  // 把主输出拆成 ≤ SEGMENT_SIZE 的段；超过 MAX_SEGMENTS 段时，
  // 先发一条「摘要指令」让侧边 agent 提炼，再发审核指令（引用摘要）。
  const STEWARD_SEGMENT_SIZE = 1500;
  const STEWARD_MAX_SEGMENTS = 6;
  const STEWARD_SUMMARY_THRESHOLD = 6000; // 超过此长度启用摘要模式

  function splitIntoSegments(text, size, maxSegs) {
    const t = String(text || "");
    if (t.length <= size) return [t];
    const segs = [];
    for (let i = 0; i < t.length && segs.length < maxSegs; i += size) {
      segs.push(t.slice(i, i + size));
    }
    // 超出 maxSegs 的尾部合并进最后一段（标注"后续内容略"）
    if (segs.length === maxSegs && t.length > maxSegs * size) {
      segs[maxSegs - 1] = segs[maxSegs - 1] + "\n[后续内容略]";
    }
    return segs;
  }

  // 管家模式提示词库：审核类型 → 侧边聊天指令模板
  // 每种类型有独立的 instruction（审核侧重）和 planLabel（写入计划板时前缀）
  const STEWARD_REVIEW_TYPES = [
    {
      id: "review",
      label: "全量",
      planLabel: "审核",
      focus: "",
      instruction: "1) 审核本轮输出质量；2) 把发现的问题转化为下一步推进指令。",
    },
    {
      id: "review-next",
      label: "下一步",
      planLabel: "下一步",
      focus: "\n\n【重点】只需输出「下一步计划」段，其它段落写「无」。",
      instruction: "只提炼本轮完成后最应继续推进的一条下一步计划，不展开全量审核。",
    },
    {
      id: "review-fixes",
      label: "修改",
      planLabel: "修改",
      focus: "\n\n【重点】只需输出「修改步骤」段，其它段落写「无」。",
      instruction: "只针对本轮输出中可执行的错误、遗漏或质量问题生成修改步骤。",
    },
    {
      id: "review-optimize",
      label: "优化",
      planLabel: "优化",
      focus: "\n\n【重点】下一步计划必须按「优化」类型给出：性能、可读性、复用性、测试、成本或可维护性。",
      instruction: "优先发现可优化项，并把优化动作写成可直接执行的下一步计划。",
    },
    {
      id: "review-develop",
      label: "进一步开发",
      planLabel: "开发",
      focus: "\n\n【重点】下一步计划必须按「进一步开发」类型给出：新功能、补全缺口、阶段目标或后续模块。",
      instruction: "优先规划下一轮可交付的功能或扩展，而不是修补当前实现。",
    },
    {
      id: "review-accept",
      label: "验收",
      planLabel: "验收",
      focus: "\n\n【重点】按「可交付验收」标准判断：功能是否真的可用、边界是否覆盖、能否交给用户。下一步计划只写补齐验收缺口的动作。",
      instruction: "以产品验收视角审查本轮产出，找出不能交付的点。",
    },
    {
      id: "review-perf",
      label: "性能",
      planLabel: "性能",
      focus: "\n\n【重点】只看性能与资源占用：耗时、内存、DOM 操作次数、重复计算、轮询频率、网络请求数。下一步计划必须是可量化的性能改进。",
      instruction: "从性能角度审查本轮实现在负载下是否可接受。",
    },
    {
      id: "review-docs",
      label: "文档",
      planLabel: "文档",
      focus: "\n\n【重点】只看可读性与可维护性：命名、注释、README/交接文档是否与实际实现一致、新人能否照着上手。",
      instruction: "从文档与可维护性角度审查本轮产出。",
    },
  ];

  function stewardReviewTypeById(id) {
    return STEWARD_REVIEW_TYPES.find((t) => t.id === id) || STEWARD_REVIEW_TYPES[0];
  }

  function buildStewardReviewPrompt({ mainOutput, projectStatus, renderedMd, planEntries, mode = "review" }) {
    const raw = String(mainOutput || "(未读到主任务输出)");
    const type = stewardReviewTypeById(mode);
    const focusHint = type.focus;
    const mdPart = renderedMd
      ? `\n\n【页面已渲染的 md 产物摘要】\n${String(renderedMd).slice(0, 1200)}`
      : "";
    const planPart = planEntries && planEntries.length
      ? `\n\n【计划板当前段落（仅供参考，勿改动原文）】\n${planEntries.map((e, i) => `${i + 1}. ${e.text}${e.done ? " [已完成]" : ""}`).join("\n")}`
      : "";
    const outputSpec = (
      "\n\n---\n" +
      "请严格按以下四段输出，标题原样保留，每段 1-3 行，无内容的段落写「无」。\n\n" +
      "## 审核结论\n" +
      "① 本轮实际完成了什么（只说材料里可见的，1 句话）。\n" +
      "② 离最终目标还差什么（若无明确目标可对照，写「无」）。\n" +
      "## 短板与风险\n" +
      "只写能从上方材料**直接引用**看出的问题。" +
      "每条格式：「依据：[原文片段] → 问题描述」。" +
      "材料里没有的就写「无」，**禁止**推测或假设。\n" +
      "## 修改步骤\n" +
      "针对上面每条短板，给出 1 条可执行的修复指令（编号列出，可直接粘贴进 Codex 执行）。" +
      "若无短板则写「无需修改」。\n" +
      "## 下一步计划\n" +
      "一到两行，可直接粘贴进 Codex 会话执行的推进指令。" +
      "若无可推进项则写「无」。\n\n" +
      "【输出硬约束】全文 ≤150 字；每段 1 行；禁止引用材料原文、禁止复述历史规划、只给本次新增结论。"
    );
    if (raw.length <= STEWARD_SUMMARY_THRESHOLD) {
      const segs = splitIntoSegments(raw, STEWARD_SEGMENT_SIZE, STEWARD_MAX_SEGMENTS);
      const segText = segs.length === 1 ? segs[0] : segs.map((s, i) => `--- 第 ${i + 1}/${segs.length} 段 ---\n${s}`).join("\n");
      return (
        "你是本项目的审核管家。主任务刚完成，" + type.instruction + "。" + focusHint + "\n\n" +
        "【主任务输出（" + segs.length + " 段）】\n" + segText + "\n\n" +
        "【项目当前状态】\n" + String(projectStatus || "(未提供)").slice(0, 800) +
        mdPart + planPart +
        outputSpec
      );
    }
    const segs = splitIntoSegments(raw, STEWARD_SEGMENT_SIZE, STEWARD_MAX_SEGMENTS);
    const segText = segs.map((s, i) => `--- 第 ${i + 1}/${segs.length} 段 ---\n${s}`).join("\n");
    return (
      "你是本项目的审核管家。主任务输出较长（" + raw.length + " 字符），" +
      "请先提炼摘要，再按审核侧重生成推进指令。" + focusHint + "\n\n" +
      "【主任务输出分段】\n" + segText + "\n\n" +
      "【项目当前状态】\n" + String(projectStatus || "(未提供)").slice(0, 800) +
      mdPart + planPart +
      "\n\n---\n" +
      "第一步：用不超过 300 字提炼核心完成项与遗留项（只写材料里可见的，禁止推测）。\n" +
      "第二步：基于提炼结果，" +
      outputSpec
    );
  }

  // 从侧边聊天输出里解析「修改步骤」与「下一步计划」两段文本（用于写回计划板）。
  // 返回 { fixes, nextPlan, has } —— 解析失败返回 has=false，调用方不写入，避免污染。
  function parseStewardControlDirective(text) {
    const value = String(text || "");
    const summary = value.match(/##\s*需要会话总结\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (summary) return { kind: "summary", text: summary[1].trim().slice(0, 600) };
    const probe = value.match(/##\s*需要探测\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (probe) return { kind: "probe", text: probe[1].trim().slice(0, 600) };
    return null;
  }

  function parseStewardSideOutput(text) {
    const value = String(text || "");
    // 段标题识别：允许 0~2 个 # 前缀或完全缺失；先精确标题匹配，失败再按关键词兜底。
    const grabExact = (title) => {
      const esc = title.replace(/[.*+?^${}()|]/g, String.raw`\$&`);
      const re = new RegExp("(?:^|\\n)\\s*(?:#{0,2})\\s*" + esc + "[^\\n]*\\n([\\s\\S]*?)(?=(?:^|\\n)\\s*(?:#{1,2})\\s|\\s*$)", "m");
      const m = value.match(re);
      if (!m) return null;
      const body = m[1].trim();
      if (!body || /^(?:-?\s*)?无[。.]?\s*$/.test(body) || /^无需修改/.test(body)) return null;
      return body;
    };
    const conclusion = grabExact("审核结论");
    const risks = grabExact("短板与风险");
    const fixes = grabExact("修改步骤");
    // 兜底：标题缺失时按关键词取「下一步计划」段（允许 0 个 # 或完全裸标题行）
    const grabNext = () => {
      const direct = grabExact("下一步计划");
      if (direct) return direct;
      const esc = "下一步计划".replace(/[.*+?^${}()|]/g, String.raw`\$&`);
      const re = new RegExp("(?:^|\\n)\\s*(?:#{0,2})\\s*" + esc + "[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{1,2})\\s|\\s*$)", "m");
      const m = value.match(re);
      if (m) {
        const body = m[1].trim();
        if (body && !/^(?:-?\s*)?无[。.]?\s*$/.test(body) && !/^无需修改/.test(body)) return body;
      }
      // 行兜底仅在标题完全缺失时使用：排除标题行与「无」行，取含关键词的最后一行正文
      if (!/下一步计划/.test(value)) {
        const lines = value.split(/\n/)
          .filter((l) => l.trim() && !/下一步计划/.test(l) && !/^(?:-?\s*)?无/.test(l.trim()) && /开发|扩展|推进|新功能|补全|模块/.test(l));
        if (lines.length) return lines[lines.length - 1].trim().slice(0, 300);
      }
      return null;
    };
    const nextPlan = grabNext();
    return {
      conclusion,
      risks,
      fixes,
      nextPlan,
      has: Boolean(fixes || nextPlan),
    };
  }

  // 判断 steward 待解析输出是否应放弃（超时）；纯函数，可单测。
  // 返回 { giveUp: boolean, reason: "ok" | "timeout" }。
  function stewardParseDecision({ nowMs, sentAtMs, timeoutMs }) {
    const elapsed = Number(nowMs) - Number(sentAtMs || 0);
    if (elapsed > Number(timeoutMs || 0)) return { giveUp: true, reason: "timeout" };
    return { giveUp: false, reason: "ok" };
  }

  // 把审核解析结果追加到计划板 entries（去重 + 截断到 PLAN_MAX_ENTRIES）。
  function appendStewardPlan(plan, { fixes, nextPlan }, planLabel = "") {
    const entries = [...(plan.entries || [])];
    // 去重 key：「标签 + 正文前 80 字」，命中则跳过，避免重复规划循环打转
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const dedupeKey = (text, label) => label + "|" + norm(text).slice(0, 80);
    const seen = new Set(entries.map((e) => e.dedupeKey || dedupeKey(e.text, "")));
    const push = (text, label) => {
      const clean = String(text || "").trim();
      const tagged = label ? `【${label}】` + clean : clean;
      const key = dedupeKey(tagged, label);
      if (!clean || seen.has(key)) return;
      seen.add(key);
      entries.push({ text: tagged, done: false, source: "steward", dedupeKey: key });
    };
    // 修改步骤 = 对本轮结果的修正，应最先执行
    if (fixes) push(fixes, planLabel || "修改");
    if (nextPlan) push(nextPlan, planLabel || "下一步");
    return { ...plan, entries: entries.slice(0, PLAN_MAX_ENTRIES) };
  }
  // 只从「明确的待修复/未完成语句」提取可核对锚点，供计划质量闸门使用。
  // 锚点限定为路径、命令参数、文件名和代码标识符，避免把普通叙述词当作验收目标。
  function extractPendingPlanAnchors(text) {
    const chunks = String(text || "")
      .split(/\n|(?<=[。！？；!?;])/)
      .map((line) => line.trim())
      .filter((line) => /未实现|尚未|没有|未完成|未创建|缺失|失效|错误|失败|阻断|TODO|待补|不存在|断开|不支持|\bmissing\b|\bno implementation\b|\bnot implemented\b|\bfails?\b|\bbroken\b|\bblocked\b/i.test(line));
    const found = new Set();
    const add = (value) => {
      const token = String(value || "").trim().replace(/[，。；：、,.!?;:)\]}>]+$/, "");
      if (token.length >= 3 && token.length <= 160) found.add(token);
    };
    for (const line of chunks) {
      for (const match of line.matchAll(/--[a-z][a-z0-9-]*/gi)) add(match[0]);
      for (const match of line.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g)) add(match[0]);
      for (const match of line.matchAll(/\b[A-Za-z0-9_.-]+\.(?:rs|js|mjs|cjs|ts|tsx|jsx|json|md|py|go|java|sql|ya?ml|toml)\b/gi)) add(match[0]);
      for (const match of line.matchAll(/`([^`\n]{2,120})`/g)) {
        const inner = match[1].trim();
        if (/^(?:--?[\w-]+|[A-Za-z0-9_./-]+|[A-Za-z_$][\w$]*(?:\(\))?)$/.test(inner)) add(inner);
      }
      for (const match of line.matchAll(/\b(?:[a-z]+_[a-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g)) add(match[0]);
    }
    return [...found].slice(0, 12);
  }

  // 写回前质量闸门：防止「只装依赖没做功能」、缺验收、追最新版等低质量计划。
  function assessStewardPlanQuality(planText, sourceText, supportingText = "") {
    const plan = String(planText || "").replace(/^\s*【[^】]+】/, "").trim();
    const anchors = extractPendingPlanAnchors(sourceText);
    const planLower = plan.toLowerCase();
    const coveredAnchors = anchors.filter((anchor) => planLower.includes(anchor.toLowerCase()));
    const reasons = [];
    if (!plan) reasons.push({ code: "empty", message: "计划为空" });
    if (anchors.length && !coveredAnchors.length) {
      reasons.push({ code: "anchor", message: "未直接命中本轮明确待修复的路径、参数或标识符" });
    }
    if (plan && !/(?:验收|完成标准|期望(?:结果|输出)|通过条件)\s*[:：]/i.test(plan)) {
      reasons.push({ code: "acceptance", message: "缺少可观察的验收判据" });
    }
    if (/(?:升级|更新).{0,16}(?:最新|latest)|(?:最新版|latest\s+version)/i.test(plan)) {
      reasons.push({ code: "unsafe-upgrade", message: "未经材料要求追最新版本" });
    }
    const sourceFlags = anchors.filter((anchor) => /^--[a-z]/i.test(anchor));
    const acceptanceBody = (plan.match(/(?:验收|完成标准|期望(?:结果|输出)|通过条件)\s*[:：]([\s\S]*)$/i) || [])[1] || "";
    const hasBehaviorAcceptance = sourceFlags.length === 0 || sourceFlags.some((flag) => acceptanceBody.includes(flag)) || /(?:输出|打印|不写|不修改|跳过|写入|删除|返回|生成|保留|退出码|错误码)/i.test(acceptanceBody);
    if (plan && sourceFlags.length && !hasBehaviorAcceptance) {
      reasons.push({ code: "behavior", message: "验收只证明参数存在或能编译，未证明功能行为生效" });
    }
    const onlyDependencyPrep = Boolean(
      plan &&
      !coveredAnchors.length &&
      /(?:引入|安装|添加|升级|更新).{0,24}(?:依赖|版本|库|框架)|(?:初始化|搭建).{0,12}(?:脚手架|环境|项目)/i.test(plan)
    );
    if (onlyDependencyPrep) {
      reasons.push({ code: "prep-only", message: "只规划依赖或脚手架准备，没有交付功能闭环" });
    }
    return { ok: reasons.length === 0, reasons, anchors, coveredAnchors };
  }
  // ===== SELECTORS（v1.9.4）=====
  function clampPanelPosition({ x = 0, y = 0, width = 0, height = 0, viewportWidth = 0, viewportHeight = 0, margin = 8 } = {}) {
    const safeMargin = Math.max(0, Number(margin) || 0);
    const maxX = Math.max(safeMargin, Number(viewportWidth) - Number(width) - safeMargin);
    const maxY = Math.max(safeMargin, Number(viewportHeight) - Number(height) - safeMargin);
    return {
      x: Math.min(maxX, Math.max(safeMargin, Math.round(Number(x) || 0))),
      y: Math.min(maxY, Math.max(safeMargin, Math.round(Number(y) || 0))),
    };
  }

  function defaultPanelPosition({ width = 0, height = 0, viewportWidth = 0, viewportHeight = 0, margin = 8 } = {}) {
    return clampPanelPosition({
      x: Number(viewportWidth) - Number(width) - Number(margin),
      y: Number(viewportHeight) - Number(height) - Number(margin),
      width, height, viewportWidth, viewportHeight, margin,
    });
  }

  function canStartPanelDrag({ tagName = "", isContentEditable = false, noDrag = false, disabled = false } = {}) {
    const blockedTags = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A", "OPTION", "LABEL"]);
    return !blockedTags.has(String(tagName || "").toUpperCase()) && !isContentEditable && !noDrag && !disabled;
  }

  const DELIVERY_STATES = Object.freeze({
    "in-progress": true,
    "needs-work": true,
    "ready-for-confirmation": true,
    delivered: true,
  });

  function normalizeDeliveryState(raw) {
    if (!raw || typeof raw !== "object" || !DELIVERY_STATES[raw.state]) return { state: "in-progress" };
    return { ...raw, state: raw.state };
  }

  function buildDeliveryRequest({ op, confirmed = false, executeToken = "" } = {}) {
    if (op === "preview" || op === "cancel") return { op, ts: Date.now() };
    if (op !== "execute") throw new Error("Unsupported delivery operation");
    if (!executeToken) throw new Error("A delivery preview token is required");
    if (confirmed !== true) throw new Error("Explicit delivery confirmation is required");
    return { op, executeToken, confirmed: true, ts: Date.now() };
  }

  function buildCredentialRequest({ op, ref = "primary", secret = "" } = {}) {
    if (op === "set") {
      const value = String(secret || "").trim();
      if (!value) throw new Error("Credential secret is required");
      return { op, ref: String(ref || "primary"), secret: value, ts: Date.now() };
    }
    if (op === "remove") return { op, ref: String(ref || "primary"), ts: Date.now() };
    throw new Error("Unsupported credential operation");
  }

  // 所有 DOM 选择器集中在这里。Codex UI 改版时只改本表，业务逻辑无需改动。
  // 用法：document.querySelector(SELECTORS.page.main) / host.querySelector(SELECTORS.ui.pill)
  const SELECTORS = Object.freeze({
    // ---- Codex 页面（外部 UI，最易变）----
    page: Object.freeze({
      main: "main",
      composer: '[data-codex-composer="true"]',
      composerBody: "[data-composer-body]",
      composerLayout: "[data-composer-layout]",
      conversation: '[data-thread-find-target="conversation"]',
      annotationConversation: "[data-response-annotation-conversation]",
      markdownBlock: "[data-markdown-text-style]",
      markdownCopy: "[data-markdown-copy]",
      markdownFileLink: 'a[href$=".md"]',
      assistantMsg: '[data-markdown-text-style="assistant-message"], [data-response-annotation-target]',
      annotationTarget: "[data-response-annotation-target]",
      contentUnit: "[data-content-search-unit-key]",
      statusSpan: '[role="alert"], [aria-live], p, span, [data-markdown-copy="inline-code"]',
      ariaButton: "button[aria-label]",
      buttonLike: 'button, [role="button"]',
      buttonLikeWithState: 'button, [role="button"], [data-state="closed"]',
      sidebarThread: "[data-app-action-sidebar-thread-id]",
      sidebarSelected: '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-selected="true"]',
      sidebarActive: '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]',
      sidebarThreadById: (id) => '[data-app-action-sidebar-thread-id="' + id + '"]',
    }),
    // ---- 本插件面板（内部 UI）----
    ui: Object.freeze({
      pill: ".g429-pill",
      panel: ".g429-panel",
      panelResetPosition: ".g429-panel-reset-position",
      attribution: ".g429-attribution",
      enabled: ".g429-enabled",
      switch429: ".g429-switch-429",
      switchBg: ".g429-switch-bg",
      switchPlan: ".g429-switch-plan",
      switchSteward: ".g429-switch-steward",
      switchCountdown: ".g429-switch-countdown",
      taskText: ".g429-task-text",
      status: ".g429-status",
      label: ".g429-label",
      action: ".g429-action",
      close: ".g429-close",
      delayBtn: "[data-delay]",
      maxConsecBtn: "[data-max-consecutive]",
      background: ".g429-background",
      planEnabled: ".g429-plan-enabled",
      planSection: '[data-section="plan"]',
      planBody: ".g429-plan-body",
      planText: ".g429-plan-text",
      planAdd: ".g429-plan-add",
      planReset: ".g429-plan-reset",
      planUp: ".g429-plan-up",
      planDown: ".g429-plan-down",
      planDelayBtn: "[data-plan-delay]",
      planProgress: ".g429-plan-progress",
      planCountdownRow: "[data-plan-countdown-row]",
      planCountdown: ".g429-plan-countdown",
      planCancel: ".g429-plan-cancel",
      planCountdownEnabled: ".g429-plan-countdown-enabled",
      planManualRow: "[data-plan-manual-row]",
      planImportNow: ".g429-plan-import-now",
      planBadge: "[data-plan-badge]",
      planThread: ".g429-plan-thread",
      planBadge2: "[data-plan-badge2]",
      deliveryStrip: ".g429-delivery-strip",
      deliveryStateText: ".g429-delivery-state-text",
      deliveryPreview: ".g429-delivery-preview-btn",
      deliveryModal: ".g429-delivery-modal",
      deliverySummary: ".g429-delivery-summary",
      deliveryContinue: ".g429-delivery-continue",
      deliveryExecute: ".g429-delivery-execute",
      deliveryCancel: ".g429-delivery-cancel",
      steward: ".g429-steward",
      stewardSection: '[data-section="steward"]',
      stewardBody: ".g429-steward-body",
      stewardMode: ".g429-steward-mode",
      stewardTimeout: ".g429-steward-timeout",
      stewardWritePlan: ".g429-steward-writeplan",
      stewardAutoImport: ".g429-steward-autoimport",
      stewardChannel: ".g429-steward-channel",
      stewardPending: ".g429-steward-pending",
      stewardBadge: "[data-steward-badge]",
      badge429: "[data-429-badge]",
      llmBadge: "[data-llm-badge]",
      llmProvider: ".g429-llm-provider",
      llmBaseUrl: ".g429-llm-baseurl",
      llmModel: ".g429-llm-model",
      llmFallbackProvider: ".g429-llm-fallback-provider",
      llmFallbackBaseUrl: ".g429-llm-fallback-baseurl",
      llmFallbackModel: ".g429-llm-fallback-model",
      llmFallbackEnabled: ".g429-llm-fallback-enabled",
      llmKeySave: ".g429-llm-key-save",
      llmKeychainStatus: ".g429-llm-keychain-status",
      llmKey: ".g429-llm-key",
      llmProxy: ".g429-llm-proxy",
      projectRoot: ".g429-project-root",
      onboard: "[data-onboard]",
      collapseBtn: "[data-collapse]",
      collapseGroupBody: (name) => '[data-body="' + name + '"]',
      chev: ".g429-chev",
      logList: ".g429-log-list",
      logCount: "[data-log-count]",
      logClear: ".g429-log-clear",
      selfCheck: ".g429-selfcheck",
      selfCheckResult: ".g429-selfcheck-result",
      traceBody: '[data-body="trace"]',
      traceCount: "[data-trace-count]",
      schat: ".g429-schat",
      schatHead: ".g429-schat-head",
      schatTitle: ".g429-schat-title",
      schatStatus: ".g429-schat-status",
      schatBody: ".g429-schat-body",
      schatInput: ".g429-schat-input",
      schatSend: ".g429-schat-send",
      schatClose: ".g429-schat-close",
      stewardLauncher: ".g429-steward-launcher",
      schatActBtn: "[data-schat-act]",
      schatAutoBtn: '[data-schat-act="auto"]',
    }),
  });

  // ===== v1.9.1 折叠状态纯函数（供单测）=====
  // 默认折叠状态：计划板/管家常驻展开，日志/LLM/429 默认折叠
  const COLLAPSE_DEFAULTS = Object.freeze({ plan: false, planinput: false, steward: false, log: true, llm: true, r429: true, trace: true });

  // 合并已保存状态与默认值；未知键忽略，非法值按默认处理
  function resolveCollapseState(saved) {
    const out = { ...COLLAPSE_DEFAULTS };
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return out;
    for (const key of Object.keys(COLLAPSE_DEFAULTS)) {
      if (typeof saved[key] === "boolean") out[key] = saved[key];
    }
    return out;
  }

  // 切换某个区块；未知区块返回原状态副本（不新增键）
  function toggleCollapse(state, name) {
    const base = resolveCollapseState(state);
    if (!(name in COLLAPSE_DEFAULTS)) return base;
    return { ...base, [name]: !base[name] };
  }

  // 折叠态 -> DOM 三个属性的期望值（hidden / aria-expanded / chevron）
  function collapseUi(collapsed) {
    const isCollapsed = collapsed === true;
    return {
      hidden: isCollapsed,
      ariaExpanded: isCollapsed ? "false" : "true",
      chevron: isCollapsed ? "\u25B8" : "\u25BE",
    };
  }

  function panelBranding() {
    return {
      title: PRODUCT_TITLE,
      panelAriaLabel: `${PRODUCT_TITLE} 管家面板`,
      pillLabel: "管家",
      pillTitle: "打开管家面板",
    };
  }

  const core = {
    isLegacyV1,
    prunePlanThreads,
    canAutoImport,
    stripEvidenceForPlan,
    isResultComplete,
    computeSessionKey,
    MIN_RESULT_CHARS,
    PRODUCT_NAME,
    PRODUCT_TITLE,
    PANEL_SECTION_ORDER,
    panelBranding,
    SELECTORS,
    fingerprintThreadId,
    preferredPlanThreadId,
    normalizeSessionIdentity,
    buildStewardSessionBootstrap,
    COLLAPSE_DEFAULTS,
    resolveCollapseState,
    toggleCollapse,
    collapseUi,
    normalizeSettings,
    normalizeDeliveryState,
    clampPanelPosition,
    defaultPanelPosition,
    canStartPanelDrag,
    buildDeliveryRequest,
    buildCredentialRequest,
    normalizePlanSettings,
    normalizePlanEntries,
    shouldImportPlan,
    nextPlanIndex,
    planImportText,
    planForThread,
    upsertThreadPlan,
    planCompletedCount,
    buildStewardReviewPrompt,
    STEWARD_REVIEW_TYPES,
    stewardReviewTypeById,
    parseStewardSideOutput,
    parseStewardControlDirective,
    appendStewardPlan,
    extractPendingPlanAnchors,
    assessStewardPlanQuality,
    stewardParseDecision,
    splitIntoSegments,
    threadsNeeding429Guard,
    formatCountdown,
    visibleTurnContext,
    classifyTaskStatus,
    taskStatusLabel,
    isUnexpectedStopText,
    nextTaskStatusState,
    shouldEnterWaitingRetry,
    isRecoveryConfirmed,
    detectPageSignals,
    shouldClickRetry,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = core;
    return;
  }

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const previous = window[STATE_KEY];
  if (previous?.version === VERSION && previous.alive) return;
  try {
    previous?.cleanup?.();
  } catch (_) {}

  function readSettings() {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    } catch (_) {
      raw = null;
    }
    let bg = true;
    try {
      const bgRaw = JSON.parse(localStorage.getItem(BACKGROUND_KEY));
      if (bgRaw && typeof bgRaw === "object" && "background" in bgRaw) bg = bgRaw.background !== false;
    } catch (_) {}
    return normalizeSettings({ ...raw, background: bg });
  }

  function writeSettings(settings) {
    try {
      const { background, ...rest } = settings;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
      localStorage.setItem(BACKGROUND_KEY, JSON.stringify({ background }));
      try { runtime._settingsRaw = localStorage.getItem(SETTINGS_KEY) || ""; } catch (_) {}
    } catch (_) {}
  }

  const PLAN_KEY = "codex429Guardian.plan.v2";

  // 计划板按线程独立：PLAN_KEY 存一个 { [threadId]: {enabled,entries,index,delaySeconds} } 容器
  // 读取遗留 v1 单线程 plan 并迁移到 v2 容器
  function migrateLegacyPlanV1() {
    try {
      const legacy = JSON.parse(localStorage.getItem("codex429Guardian.plan.v1"));
      if (legacy && typeof legacy === "object" && !Array.isArray(legacy) &&
        (legacy.entries || legacy.enabled !== undefined)) {
        const migrated = { default: normalizePlanSettings(legacy) };
        // v1 只迁移一次，迁移后删键，防止每次读取都复活旧条目
        try { localStorage.removeItem("codex429Guardian.plan.v1"); } catch (_) {}
        return migrated;
      }
    } catch (_) {}
    return null;
  }

  // 识别 v1 旧格式：带 threadId 字段 / 值是 plan 对象的容器（不是 {threadId:plan} 映射）
  function isLegacyV1(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    // 单 plan 对象（v1）：顶层直接带 threadId / entries
    if ("threadId" in raw) return true;
    if (Array.isArray(raw.entries)) {
      // v1 entries 是字符串数组；v2 entries 是 {text,done} 对象数组
      return raw.entries.length === 0 || typeof raw.entries[0] === "string";
    }
    // 容器形态：用 entries[0] 的类型区分 v1/v2——v1 是字符串，v2 是对象
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.entries)) {
        if (v.entries.length > 0 && typeof v.entries[0] === "string") return true;
        // v2 特征：带 delaySeconds 或 entries 是对象 → 不是 legacy
        if ("delaySeconds" in v) return false;
        if (v.entries.length > 0 && typeof v.entries[0] === "object") return false;
      }
    }
    return false;
  }

  function readPlanThreads() {
    try {
      let raw = JSON.parse(localStorage.getItem(PLAN_KEY));
      // v1.9.19：防御「双重 JSON 编码」——某些写入路径可能把对象再 stringify 一次
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch (_) {}
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && !isLegacyV1(raw)) {
        return migrateDelayTo30(raw);
      }
    } catch (_) {}
    // 脏数据（数组/非对象）直接重置为空容器，避免把数字键一路传下去
    try {
      const rawStr = localStorage.getItem(PLAN_KEY);
      if (rawStr) {
        const parsed = JSON.parse(rawStr);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          localStorage.setItem(PLAN_KEY, "{}");
        }
      }
    } catch (_) {}
    // v2 缺失或仍是 v1 旧格式：从 v1 key 迁移
    const legacy = migrateLegacyPlanV1();
    if (legacy) { writePlanThreads(legacy); return legacy; }
    return {};
  }

  function writePlanThreads(threads) {
    try {
      const tid = runtime ? runtime.planActiveThreadId : null;
      const pruned = prunePlanThreads(threads, tid);
      localStorage.setItem(PLAN_KEY, JSON.stringify(pruned));
      return pruned;
    } catch (_) { return threads; }
  }

  function toast(message) {
    try {
      if (window.codexPlus && typeof window.codexPlus.toast === "function") {
        window.codexPlus.toast(message);
        return;
      }
    } catch (_) {}
    console.info("[Codex Full Steward]", message);
  }

  function selectedThreadId() {
    const selected = document.querySelector(
      SELECTORS.page.sidebarSelected,
    );
    const active = document.querySelector(
      SELECTORS.page.sidebarActive,
    );
    const row = selected || active;
    return row?.getAttribute("data-app-action-sidebar-thread-id") || null;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function conversationRoot() {
    return (
      document.querySelector(SELECTORS.page.conversation) ||
      document.querySelector(SELECTORS.page.main) ||
      document.body
    );
  }

  function conversationThreadId() {
    const annotations = [
      ...document.querySelectorAll(SELECTORS.page.annotationConversation),
    ].filter(isVisible);
    return (
      annotations
        .at(-1)
        ?.getAttribute("data-response-annotation-conversation") || null
    );
  }

  function currentSessionTitle() {
    const pageTitle = String(document.title || "").replace(/\s+/g, " ").trim();
    if (pageTitle && !/^(?:codex|chatgpt|codex desktop)$/i.test(pageTitle)) return pageTitle.slice(0, 120);
    const id = selectedThreadId();
    const row = id ? document.querySelector(SELECTORS.page.sidebarThreadById(id)) : null;
    const text = String(row?.innerText || "").split("\n").map((s) => s.trim()).find(Boolean);
    return (text || "未命名会话").replace(/\s+/g, " ").slice(0, 120);
  }

  // v1.9.1：会话内容指纹兜底——当前 UI 不再给 sidebar 行打 selected/active，
  // 用「首条用户消息前 N 字 + 消息条数」做一个稳定 key，避免所有计划落进 default 桶。
  // v1.9.5：多段信号拼接，降低「同标题/同开头」会话的串号概率
  function fingerprintThreadId(text) {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const raw = norm(text);
    if (!raw) return null;
    // 取「开头 + 结尾 + 长度」三段特征，而不是只看前 200 字
    const head = raw.slice(0, 120);
    const tail = raw.length > 120 ? raw.slice(-120) : "";
    const sig = head + "|" + tail + "|" + raw.length;
    let h = 5381;
    for (let i = 0; i < sig.length; i += 1) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
    let h2 = 52711;
    for (let i = sig.length - 1; i >= 0; i -= 1) h2 = ((h2 << 5) + h2 + sig.charCodeAt(i)) | 0;
    return "fp:" + (h >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  // v1.9.16：会话隔离 key——用「首条消息」指纹，保证同一项目下不同对话互不串台。
  function computeSessionKey() {
    try {
      const main = document.querySelector(SELECTORS.page.main);
      if (!main) return null;
      const blocks = [...main.querySelectorAll(SELECTORS.page.markdownBlock)];
      const first = blocks[0] ? (blocks[0].innerText || "") : (main.innerText || "");
      return fingerprintThreadId(first);
    } catch (_) { return null; }
  }

  // 计划桶优先跟随稳定的会话内容指纹；显式 sidebar id 仅在已有独立计划桶时使用。
  function preferredPlanThreadId(threadId, sessionKey, planThreads) {
    void sessionKey;
    void planThreads;
    return threadId || null;
  }

  function currentThreadId() {
    const explicit = selectedThreadId() || conversationThreadId();
    if (explicit) return explicit;
    // 兜底：用会话内容指纹（首条用户消息 + 消息条数）
    try {
      const main = document.querySelector(SELECTORS.page.main);
      if (!main) return null;
      const blocks = [...main.querySelectorAll(SELECTORS.page.markdownBlock)];
      // v1.9.6：只用「首条消息」做指纹——会话增长时首条不变，key 才稳定。
      // （之前把 blocks.length 也算进去，每来一条消息 key 就变，导致倒计时被反复重置）
      const first = blocks[0] ? (blocks[0].innerText || "") : (main.innerText || "");
      if (!first) return null;
      return fingerprintThreadId(first);
    } catch (_) {
      return null;
    }
  }

  function normalizeSessionIdentity({ threadId, annotationId, title, fingerprint } = {}) {
    const candidates = [threadId, annotationId]
      .map((value) => String(value || "").trim().replace(/^local:/i, ""))
      .filter(Boolean);
    const rawId = candidates[0] || "";
    const sessionId = rawId ? `session:${rawId}` : null;
    const memoryKey = rawId ? `s_${rawId}` : (String(fingerprint || "").trim() || null);
    const sessionTitle = String(title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "未命名会话";
    return { sessionId, memoryKey, sessionTitle };
  }

  function currentSessionIdentity() {
    return normalizeSessionIdentity({
      threadId: selectedThreadId(),
      annotationId: conversationThreadId(),
      title: currentSessionTitle(),
      fingerprint: computeSessionKey(),
    });
  }

  function currentSessionSnapshot() {
    const planThreadId = currentThreadId();
    const identity = currentSessionIdentity();
    const turn = currentTurn();
    const signals = currentSignals(planThreadId);
    return {
      planThreadId,
      threadId: planThreadId,
      sessionId: identity.sessionId,
      sessionKey: identity.memoryKey,
      sessionTitle: identity.sessionTitle,
      turnId: turn.turnId,
      lastText: String(turn.turnText || ""),
      hasStop: Boolean(signals.hasStopButton),
      taskStatus: signals.taskStatus,
    };
  }

  function sessionRequestMeta() {
    const snapshot = currentSessionSnapshot();
    return {
      planThreadId: snapshot.planThreadId,
      sessionId: snapshot.sessionId,
      sessionKey: snapshot.sessionKey,
      sessionTitle: snapshot.sessionTitle,
    };
  }

  function buildStewardSessionBootstrap({ projectRoot, sessionTitle, sessionId, memoryKey } = {}) {
    const root = String(projectRoot || "").replace(/\/+$/, "");
    const key = String(memoryKey || sessionId || "default").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64);
    const dir = root ? `${root}/.guardian/sessions/${key}` : `.guardian/sessions/${key}`;
    return [
      `【管家】已绑定当前会话「${sessionTitle || "未命名会话"}」（编号 ${key}）。`,
      `请先建立并只使用这个会话专属记忆目录：${dir}`,
      `本会话的总结、关键决策、未完成项和下一步只写入该目录；需要管家总结时默认写 ${dir}/SESSION-STATE.md，最新上下文写 ${dir}/LATEST-CONTEXT.md。`,
      `不得读取或改写其他会话目录；如目录不存在先创建，已存在则复用。`,
      `验收：目录存在，且 ${dir}/SESSION-STATE.md 包含本会话目标、已完成、未完成、关键决策和下一步。`,
    ].join("\n");
  }

  // ===== 后台（non-foreground）会话探测 =====
  // 返回页内所有“可查”的会话 id：侧边栏里渲染出的会话 + 当前 conversation 的 annotation。
  // 这些会话即使没打开（非前台），只要侧边栏/虚拟化列表里还在 DOM，就能后台读它们的 429 与任务状态。
  function discoverThreadIds() {
    const ids = new Set();
    const side = document.querySelectorAll(SELECTORS.page.sidebarThread);
    for (const el of side) {
      const id = el.getAttribute("data-app-action-sidebar-thread-id");
      if (id) ids.add(id);
    }
    // 当前打开会话的 conversation annotation（可能没在侧边栏里）
    const convs = document.querySelectorAll(SELECTORS.page.annotationConversation);
    for (const el of convs) {
      const id = el.getAttribute("data-response-annotation-conversation");
      if (id) ids.add(id);
    }
    return [...ids];
  }

  // 后台判定：哪些会话“正在需要 429 守护 / 计划导入”。
  // 非前台会话没有 composer 可写、没有 send 按钮可点，因此后台只负责
  // “把该会话切到前台并倒计时到点触发”；真正点击仍在切回前台后由主 scan 完成。
  function threadsNeeding429Guard(activeThreadId) {
    const ids = discoverThreadIds();
    // 返回需要后台守护的会话：
    //  - pending429=true 的会话（真 429，需切回前台点恢复）
    //  - plan.enabled 的会话（计划模式开，任务完成后需切回导入下一段）
    // v1.8.14 修复：不再把所有会话无条件标记，只按实际状态筛选，
    // 配合 triggerBackgroundSwitch 的 30s 冷却防止乱跳
    return ids.filter((id) => {
      if (!id || id === activeThreadId) return false;
      const bg = runtime.background.get(id);
      const plan = planForThread(runtime.planThreads, id);
      return Boolean(bg?.pending429 || plan?.enabled);
    });
  }

  function hasVisibleStopButton() {
    // 只认主会话区域的停止按钮：排除侧边面板（left > 900 或 closest .csw-popover/侧边 section）
    return [...document.querySelectorAll(SELECTORS.page.ariaButton)].some((element) => {
      if (!isVisible(element)) return false;
      if (!/^(?:停止|stop)$/i.test(element.getAttribute("aria-label") || "")) return false;
      // 排除侧边面板里的停止按钮（csw-popover 或 侧边聊天 section 内）
      const inSidePanel = element.closest(".csw-popover,[class*=summary-panel],[aria-label*=侧边聊天]") !== null;
      if (inSidePanel) return false;
      // 排除 left > 900 的（侧边区域）
      const r = element.getBoundingClientRect();
      if (r.left > 900) return false;
      return true;
    });
  }

  function currentTurn() {
    const conversation = conversationRoot();
    const units = [
      ...conversation.querySelectorAll(SELECTORS.page.contentUnit),
    ]
      .filter(isVisible)
      .map((element) => ({
        element,
        key: element.getAttribute("data-content-search-unit-key") || "",
        text: element.innerText || element.textContent || "",
        visible: true,
      }));
    const context = visibleTurnContext(units);

    if (context.turnId) {
      return {
        element: conversation,
        conversation,
        turnId: context.turnId,
        turnText: context.text,
        units: context.units.map((unit) => unit.element),
        lastUnit: context.units.at(-1)?.element || null,
      };
    }

    const annotations = [
      ...conversation.querySelectorAll(SELECTORS.page.annotationTarget),
    ].filter(isVisible);
    const latest = annotations.at(-1) || null;
    return {
      element: latest || conversation,
      conversation,
      turnId: latest?.getAttribute("data-response-annotation-target") || null,
      turnText: latest?.innerText || "",
      units: latest ? [latest] : [],
      lastUnit: latest,
    };
  }

  function isErrorColor(value) {
    const channels = String(value || "").match(/\d+/g)?.map(Number) || [];
    if (channels.length < 3) return false;
    const [red, green, blue] = channels;
    return red > 145 && red > green * 1.3 && red > blue * 1.3;
  }

  function hasErrorPresentation(element) {
    let node = element;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const role = node.getAttribute("role");
      const live = node.getAttribute("aria-live");
      const className = String(node.className || "");
      if (
        role === "alert" ||
        live === "assertive" ||
        /(?:^|\b)(error|danger|destructive|text-red|border-red)(?:\b|$)/i.test(
          className,
        )
      ) {
        return true;
      }
      const style = window.getComputedStyle(node);
      if (
        isErrorColor(style.color) ||
        isErrorColor(style.borderTopColor) ||
        isErrorColor(style.borderLeftColor)
      ) {
        return true;
      }
    }
    return false;
  }

  function statusSnapshotForTurn(turn) {
    const candidates = [
      ...turn.conversation.querySelectorAll(
        SELECTORS.page.statusSpan,
      ),
    ];
    const texts429 = [];
    const unexpectedTexts = [];
    const seen = new Set();

    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const text = normalizeButtonText(element.innerText || element.textContent || "");
      if (!text || text.length > 360 || seen.has(text)) continue;
      const is429Text =
        /服务器繁忙|Server is busy|HTTP\s*429|429\s+Too Many Requests|Too Many Requests|请求过多|速率限制/i.test(
          text,
        );
      const isUnexpectedText = isUnexpectedStopText(text);
      if (!is429Text && !isUnexpectedText) continue;

      const unit = element.closest("[data-content-search-unit-key]");
      const unitTurnId = turnIdFromUnitKey(
        unit?.getAttribute("data-content-search-unit-key"),
      );
      if (unitTurnId && turn.turnId && unitTurnId !== turn.turnId) continue;
      if (
        !unit &&
        turn.lastUnit &&
        !(
          turn.lastUnit.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      ) {
        continue;
      }

      const inAssistantMarkdown = Boolean(
        element.closest(
          '[data-markdown-text-style="assistant-message"], [data-markdown-han-text="true"]',
        ),
      );
      const strongRetryLimitText =
        /exceeded retry limit,?\s*last status:\s*429\s+Too Many Requests/i.test(
          text,
        );
      const presentedAsError = hasErrorPresentation(element);
      if (inAssistantMarkdown && !presentedAsError) continue;
      if (is429Text && !strongRetryLimitText && !presentedAsError) continue;
      if (!is429Text && !presentedAsError) continue;

      seen.add(text);
      if (is429Text) texts429.push(text);
      if (isUnexpectedText) unexpectedTexts.push(text);
    }

    // 优先从当前 units 找 assistant 输出；units 为空（虚拟化列表未渲染）时，
    // 回退到 conversation 容器里所有可见的 assistant 节点，避免状态灯永远落不到 completed。
    // 不再跨 conversation 做全局回退，避免其他会话残留节点污染当前状态。
    const unitHasAssistant = turn.units.some((unit) =>
      Boolean(
        unit.matches('[data-markdown-text-style="assistant-message"]') ||
          unit.querySelector(
            SELECTORS.page.assistantMsg,
          ),
      ),
    );
    const conversationHasAssistant = turn.conversation
      ? Boolean(
          turn.conversation.querySelector(
            SELECTORS.page.assistantMsg,
          ),
        )
      : false;
    const hasAssistantOutput = unitHasAssistant || conversationHasAssistant;
    return { texts429, unexpectedTexts, hasAssistantOutput };
  }

  function currentSignals(threadId = currentThreadId()) {
    const turn = currentTurn();
    const statusSnapshot = statusSnapshotForTurn(turn);
    const composer = document.querySelector(SELECTORS.page.composerBody);
    const buttonRoots = [composer, turn.conversation, document.querySelector(SELECTORS.page.main)]
      .filter(Boolean);
    const buttonElements = [...new Set(
      buttonRoots.flatMap((root) => [
        ...root.querySelectorAll(SELECTORS.page.buttonLikeWithState),
      ]),
    )];
    const buttons = buttonElements
          .filter(
            (element) =>
              isVisible(element) &&
              !element.closest("[data-app-action-sidebar-thread-id]"),
          )
          .map((element) => ({
            element,
            text: element.innerText || element.textContent || "",
            ariaLabel: element.getAttribute("aria-label") || "",
            disabled:
              Boolean(element.disabled) ||
              element.getAttribute("aria-disabled") === "true",
          }));
    const hasStopButton = hasVisibleStopButton();

    const signals = detectPageSignals({
      turnText: turn.turnText,
      statusTexts: statusSnapshot.texts429,
      buttons,
      hasStopButton,
      threadId,
      turnId: turn.turnId,
    });
    const hasUnexpectedStop = statusSnapshot.unexpectedTexts.length > 0;
    return {
      ...signals,
      hasAssistantOutput: statusSnapshot.hasAssistantOutput,
      hasUnexpectedStop,
      taskStatus: classifyTaskStatus({
        is429: signals.is429,
        hasUnexpectedStop,
        hasStopButton,
        hasAssistantOutput: statusSnapshot.hasAssistantOutput,
      }),
    };
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${HOST_ATTR}] {
        position: fixed;
        right: 18px;
        bottom: 88px;
        z-index: 2147483645;
        color: #e9eef5;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }
      [${HOST_ATTR}] .g429-pill,
      [${HOST_ATTR}] .g429-panel {
        background: #18212b;
        border: 1px solid rgba(255,255,255,.13);
        box-shadow: 0 10px 34px rgba(0,0,0,.28);
      }
      [${HOST_ATTR}] .g429-pill {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 32px;
        padding: 0 11px;
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      [${HOST_ATTR}] .g429-dot,
      [${HOST_ATTR}] .g429-task-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #7d8b99;
        box-shadow: 0 0 0 3px rgba(125,139,153,.12);
        transition: background .16s ease, box-shadow .16s ease;
      }
      [${HOST_ATTR}] .g429-task-dot {
        width: 9px;
        height: 9px;
      }
      [${HOST_ATTR}][data-task-status="running"] .g429-dot,
      [${HOST_ATTR}][data-task-status="running"] .g429-task-dot {
        background: #6a9fd8;
        box-shadow: 0 0 0 3px rgba(106,159,216,.16);
      }
      [${HOST_ATTR}][data-task-status="completed"] .g429-dot,
      [${HOST_ATTR}][data-task-status="completed"] .g429-task-dot {
        background: #42b883;
        box-shadow: 0 0 0 3px rgba(66,184,131,.16);
      }
      [${HOST_ATTR}][data-task-status="unexpected"] .g429-dot,
      [${HOST_ATTR}][data-task-status="unexpected"] .g429-task-dot {
        background: #f0aa43;
        box-shadow: 0 0 0 3px rgba(240,170,67,.16);
      }
      [${HOST_ATTR}][data-task-status="429"] .g429-dot,
      [${HOST_ATTR}][data-task-status="429"] .g429-task-dot {
        background: #ff5d5d;
        box-shadow: 0 0 0 3px rgba(255,93,93,.18);
      }
      [${HOST_ATTR}][data-enabled="false"] .g429-pill {
        opacity: .68;
      }
      [${HOST_ATTR}] .g429-panel {
        position: fixed;
        left: 0;
        top: 0;
        right: auto;
        bottom: auto;
        width: 248px;
        max-height: calc(100vh - 16px);
        padding: 10px 12px;
        border-radius: 8px;
        display: none;
        overflow-x: hidden;
        overflow-y: auto;
        cursor: grab;
        touch-action: pan-y;
      }
      [${HOST_ATTR}][data-panel-dragging="true"] .g429-panel {
        cursor: grabbing;
        user-select: none;
      }
      [${HOST_ATTR}][data-open="true"] .g429-panel {
        display: block;
      }
      [${HOST_ATTR}] .g429-head,
      [${HOST_ATTR}] .g429-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      [${HOST_ATTR}] .g429-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 650;
        letter-spacing: 0;
      }
      [${HOST_ATTR}] .g429-version-tag {
        flex: 0 0 auto;
        color: #7f8b98;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      [${HOST_ATTR}] .g429-task {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 24px;
        margin-top: 8px;
        color: #c8d1db;
      }
      [${HOST_ATTR}] .g429-task-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [${HOST_ATTR}] .g429-status {
        min-height: 34px;
        margin: 10px 0;
        color: #aeb9c5;
        overflow-wrap: anywhere;
      }
      [${HOST_ATTR}] .g429-segment {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        padding: 3px;
        background: #10171f;
        border-radius: 7px;
      }
      [${HOST_ATTR}] .g429-segment button,
      [${HOST_ATTR}] .g429-close {
        appearance: none;
        border: 1px solid rgba(255,255,255,.07);
        color: #aeb9c5;
        background: linear-gradient(180deg, #1c2836 0%, #141d27 100%);
        border-radius: 5px;
        cursor: pointer;
        font: inherit;
        box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
        transition: background .12s ease, box-shadow .12s ease, transform .08s ease;
      }
      [${HOST_ATTR}] .g429-segment button:hover,
      [${HOST_ATTR}] .g429-close:hover {
        background: linear-gradient(180deg, #253244 0%, #1a2533 100%);
        box-shadow: 0 2px 4px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.09);
      }
      [${HOST_ATTR}] .g429-segment button:active,
      [${HOST_ATTR}] .g429-close:active {
        transform: translateY(1px);
        box-shadow: 0 0 1px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.04);
      }
      [${HOST_ATTR}] .g429-segment button {
        height: 28px;
      }
      [${HOST_ATTR}] .g429-segment button[aria-pressed="true"] {
        color: #f7fafc;
        background: linear-gradient(180deg, #3a5068 0%, #2a3d54 100%);
        border-color: rgba(76,154,255,.45);
        box-shadow: 0 1px 3px rgba(76,154,255,.25), inset 0 1px 0 rgba(255,255,255,.12);
      }
      [${HOST_ATTR}] .g429-close {
        width: 24px;
        height: 24px;
        font-size: 16px;
        line-height: 1;
      }
      [${HOST_ATTR}] input[type="checkbox"] {
        appearance: none;
        -webkit-appearance: none;
        accent-color: #4c9aff;
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        flex: 0 0 auto;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,.35);
        border-radius: 4px;
        background: #10171f;
        position: relative;
        box-sizing: border-box;
        transition: background .15s ease, border-color .15s ease;
      }
      [${HOST_ATTR}] input[type="checkbox"]:checked {
        background: #4c9aff;
        border-color: #4c9aff;
      }
      [${HOST_ATTR}] input[type="checkbox"]:checked::after {
        content: "";
        position: absolute;
        left: 4px;
        top: 1px;
        width: 5px;
        height: 9px;
        border: solid #0b1017;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      [${HOST_ATTR}] input[type="checkbox"]:focus {
        outline: 2px solid rgba(76,154,255,.55);
        outline-offset: 1px;
      }
      [${HOST_ATTR}] .g429-head label,
      [${HOST_ATTR}] .g429-row label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      [${HOST_ATTR}] .g429-group {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,.08);
      }
      [${HOST_ATTR}] .g429-group-head,
      [${HOST_ATTR}] .g429-subhead {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 4px 0;
        margin: 0;
        background: transparent;
        border: 0;
        color: #9fb0c2;
        font: inherit;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .04em;
        cursor: pointer;
        text-align: left;
      }
      [${HOST_ATTR}] .g429-group-head:hover,
      [${HOST_ATTR}] .g429-subhead:hover { color: #e9eef5; }
      [${HOST_ATTR}] .g429-subhead {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,.08);
        font-weight: 500;
        letter-spacing: 0;
        font-size: 11px;
      }
      [${HOST_ATTR}] .g429-chev {
        display: inline-block;
        width: 12px;
        flex: 0 0 auto;
        font-size: 10px;
        opacity: .75;
      }
      [${HOST_ATTR}] .g429-group-name { flex: 1; }
      [${HOST_ATTR}] .g429-group-badge,
      [${HOST_ATTR}] .g429-log-count,
      [${HOST_ATTR}] .g429-llm-badge {
        font-weight: 400;
        font-size: 10px;
        color: #6b7a8a;
        background: rgba(255,255,255,.05);
        border-radius: 999px;
        padding: 1px 7px;
        font-variant-numeric: tabular-nums;
      }
      [${HOST_ATTR}] .g429-group-primary > .g429-group-head > .g429-group-name {
        color: #dbe6f2;
        font-size: 12px;
      }
      [${HOST_ATTR}] .g429-group-primary {
        border-top: 0;
        padding-top: 0;
        margin-top: 10px;
      }
      [${HOST_ATTR}] .g429-group-hero {
        margin-top: 10px;
        padding: 8px;
        border: 1px solid rgba(106,159,216,.20);
        border-radius: 8px;
        background: rgba(58,95,138,.10);
      }
      [${HOST_ATTR}] .g429-group-hero > .g429-group-head > .g429-group-name {
        color: #f4f8fc;
        font-size: 13px;
      }
      [${HOST_ATTR}] .g429-log-list > div {
        padding: 3px 0;
        border-bottom: 1px dashed rgba(255,255,255,.06);
        overflow-wrap: anywhere;
      }
      [${HOST_ATTR}] .g429-log-tag {
        display: inline-block;
        font-size: 9px;
        padding: 0 5px;
        border-radius: 3px;
        margin-right: 5px;
        vertical-align: 1px;
      }
      [${HOST_ATTR}] .g429-log-tag[data-kind="ok"] { background: rgba(66,184,131,.18); color: #6fc99a; }
      [${HOST_ATTR}] .g429-log-tag[data-kind="err"] { background: rgba(255,93,93,.18); color: #ff8a8a; }
      [${HOST_ATTR}] .g429-log-tag[data-kind="dup"] { background: rgba(240,170,67,.18); color: #f0b86a; }
      [${HOST_ATTR}] .g429-log-tag[data-kind="info"] { background: rgba(106,159,216,.18); color: #8fbde8; }
      [${HOST_ATTR}] .g429-plan-cancel,
      [${HOST_ATTR}] .g429-log-clear {
        appearance: none;
        border: 1px solid rgba(255,255,255,.1);
        background: transparent;
        color: #aeb9c5;
        border-radius: 5px;
        font: inherit;
        font-size: 10px;
        padding: 2px 8px;
        cursor: pointer;
      }
      [${HOST_ATTR}] .g429-plan-cancel:hover,
      [${HOST_ATTR}] .g429-log-clear:hover { background: #1e2c3a; color: #e9eef5; }
      [${HOST_ATTR}] .g429-group-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #5a6775;
        margin-bottom: 6px;
      }
      [${HOST_ATTR}] .g429-row {
        flex-wrap: wrap;
      }
      [${HOST_ATTR}] .g429-row-label {
        min-width: 64px;
        flex: 0 0 auto;
        font-size: 11px;
        color: #7f8b98;
        line-height: 28px;
        text-align: left;
      }
      [${HOST_ATTR}] .g429-row .g429-switch {
        min-width: 30px;
      }
      [${HOST_ATTR}] .g429-chiprow {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        justify-content: flex-end;
        flex: 1;
        min-width: 0;
      }
      [${HOST_ATTR}] .g429-chip {
        appearance: none;
        border: 1px solid rgba(255,255,255,.10);
        background: transparent;
        color: #7f8b98;
        font: inherit;
        font-size: 11px;
        line-height: 1;
        padding: 3px 7px;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
        box-shadow: none;
      }
      [${HOST_ATTR}] .g429-chip:hover {
        background: #1e2c3a;
        color: #cfd9e4;
      }
      [${HOST_ATTR}] .g429-chip[aria-pressed="true"],
      [${HOST_ATTR}] .g429-chip.active {
        background: #2a5a3a;
        border-color: rgba(102,204,120,.5);
        color: #6fc;
      }
      [${HOST_ATTR}] .g429-checklabel {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        color: #7f8b98;
        cursor: pointer;
      }
      [${HOST_ATTR}] .g429-foot {
        margin-top: 12px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,.08);
      }
      [${HOST_ATTR}] .g429-status {
        font-size: 11px;
        color: #aeb9c5;
      }
      [${HOST_ATTR}] .g429-action {
        font-size: 11px;
        color: #7f8b98;
      }
      [${HOST_ATTR}] .g429-plan {
        display: none;
      }
      [${HOST_ATTR}] .g429-plan-text {
        width: 100%;
        box-sizing: border-box;
        margin-top: 6px;
        resize: vertical;
        min-height: 64px;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,.14);
        background: #10171f;
        color: #e9eef5;
        font: inherit;
      }
      [${HOST_ATTR}] .g429-plan-add,
      [${HOST_ATTR}] .g429-plan-reset,
      [${HOST_ATTR}] .g429-plan-up,
      [${HOST_ATTR}] .g429-plan-down {
        appearance: none;
        border: 1px solid rgba(255,255,255,.07);
        color: #aeb9c5;
        background: linear-gradient(180deg, #1c2836 0%, #141d27 100%);
        border-radius: 5px;
        padding: 3px 10px;
        cursor: pointer;
        font: inherit;
        box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
        transition: background .12s ease, box-shadow .12s ease, transform .08s ease;
      }
      [${HOST_ATTR}] .g429-plan-add:hover,
      [${HOST_ATTR}] .g429-plan-reset:hover,
      [${HOST_ATTR}] .g429-plan-up:hover,
      [${HOST_ATTR}] .g429-plan-down:hover {
        background: linear-gradient(180deg, #253244 0%, #1a2533 100%);
        box-shadow: 0 2px 4px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.09);
      }
      [${HOST_ATTR}] .g429-plan-add:active,
      [${HOST_ATTR}] .g429-plan-reset:active,
      [${HOST_ATTR}] .g429-plan-up:active,
      [${HOST_ATTR}] .g429-plan-down:active {
        transform: translateY(1px);
        box-shadow: 0 0 1px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.04);
      }
      [${HOST_ATTR}] .g429-steward-mode,
      [${HOST_ATTR}] .g429-steward-timeout {
        padding: 2px 8px;
        margin: 0 2px;
        border-radius: 4px;
        border: 1px solid rgba(255,255,255,.10);
        background: transparent;
        color: #7f8b98;
        font-size: 11px;
        cursor: pointer;
      }
      [${HOST_ATTR}] .g429-steward-mode:hover,
      [${HOST_ATTR}] .g429-steward-timeout:hover {
        background: #1e2c3a;
        color: #cfd9e4;
      }
      [${HOST_ATTR}] .g429-steward-body {
        border-radius: 4px;
      }
      [${HOST_ATTR}] .g429-plan-thread {
      [${HOST_ATTR}] .g429-plan-thread {
        margin-left: auto;
      }
      [${HOST_ATTR}] .g429-switch {
        display: inline-block;
        min-width: 26px;
        padding: 2px 8px;
        border-radius: 5px;
        font-size: 11px;
        line-height: 1.4;
        text-align: center;
        user-select: none;
        border: 1px solid rgba(255,255,255,.12);
        background: linear-gradient(180deg, #1a2533 0%, #10171f 100%);
        color: #8b98a8;
        box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05);
        transition: background .15s ease, box-shadow .15s ease, transform .08s ease;
      }
      [${HOST_ATTR}] .g429-switch:active {
        transform: translateY(1px);
      }
      [${HOST_ATTR}] .g429-switch[data-on="true"] {
        background: linear-gradient(180deg, #3a5f8a 0%, #2a4a70 100%);
        border-color: rgba(76,154,255,.5);
        color: #eaf3ff;
        box-shadow: 0 1px 3px rgba(76,154,255,.30), inset 0 1px 0 rgba(255,255,255,.12);
      }
      [${HOST_ATTR}] .g429-plan-progress {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
      }
      /* ===== 侧边管家窗口（自建通道，不依赖 csw/原生侧边聊天） ===== */
      [${HOST_ATTR}] .g429-steward-launcher {
        appearance: none;
        border: 1px solid rgba(255,255,255,.07);
        background: linear-gradient(180deg, #1c2836 0%, #141d27 100%);
        color: #aeb9c5;
        border-radius: 5px;
        padding: 3px 10px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
      }
      [${HOST_ATTR}] .g429-steward-launcher:hover {
        background: linear-gradient(180deg, #253244 0%, #1a2533 100%);
        color: #e9eef5;
      }
      [${HOST_ATTR}] .g429-schat {
        position: fixed;
        left: 18px;
        bottom: 88px;
        z-index: 2147483646;
        width: 380px;
        max-height: min(560px, calc(100vh - 140px));
        background: #141c26;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 10px;
        box-shadow: 0 14px 44px rgba(0,0,0,.5);
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      [${HOST_ATTR}][data-schat-open] .g429-schat,
      [${HOST_ATTR}] .g429-schat[data-schat-open="true"] {
        display: flex;
      }
      [${HOST_ATTR}] .g429-schat-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        background: linear-gradient(180deg, #1a2533 0%, #141c26 100%);
      }
      [${HOST_ATTR}] .g429-schat-title {
        font-weight: 650;
        font-size: 12px;
        letter-spacing: 0;
        color: #e9eef5;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [${HOST_ATTR}] .g429-schat-status {
        font-size: 10px;
        color: #7f8b98;
        white-space: nowrap;
      }
      [${HOST_ATTR}] .g429-schat-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      [${HOST_ATTR}] .g429-schat-msg {
        max-width: 92%;
        padding: 8px 10px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.55;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      [${HOST_ATTR}] .g429-schat-msg-sent {
        align-self: flex-end;
        background: #2a4a70;
        border: 1px solid rgba(76,154,255,.4);
        color: #eaf3ff;
      }
      [${HOST_ATTR}] .g429-schat-msg-recv {
        align-self: flex-start;
        background: #1d2836;
        border: 1px solid rgba(255,255,255,.1);
        color: #cfd9e4;
      }
      [${HOST_ATTR}] .g429-schat-msg-sys {
        align-self: center;
        max-width: 100%;
        background: none;
        border: none;
        color: #5a6775;
        font-size: 11px;
        text-align: center;
      }
      [${HOST_ATTR}] .g429-schat-foot {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid rgba(255,255,255,.08);
        background: #10171f;
      }
      [${HOST_ATTR}] .g429-schat-input {
        flex: 1;
        min-height: 34px;
        max-height: 96px;
        overflow-y: auto;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 6px;
        background: #0b1017;
        color: #e9eef5;
        font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        padding: 6px 8px;
        outline: none;
      }
      [${HOST_ATTR}] .g429-schat-input:focus {
        border-color: rgba(76,154,255,.55);
      }
      [${HOST_ATTR}] .g429-schat-send,
      [${HOST_ATTR}] .g429-schat-act {
        appearance: none;
        border: 1px solid rgba(255,255,255,.07);
        background: linear-gradient(180deg, #1c2836 0%, #141d27 100%);
        color: #aeb9c5;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        padding: 4px 8px;
        white-space: nowrap;
        box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
      }
      [${HOST_ATTR}] .g429-schat-send {
        height: 34px;
        padding: 0 12px;
        color: #eaf3ff;
        background: linear-gradient(180deg, #3a5f8a 0%, #2a4a70 100%);
        border-color: rgba(76,154,255,.5);
      }
      [${HOST_ATTR}] .g429-schat-send:disabled,
      [${HOST_ATTR}] .g429-schat-act:disabled {
        opacity: .45;
        cursor: not-allowed;
      }
      [${HOST_ATTR}] .g429-schat-actrow {
        display: flex;
        gap: 4px;
        padding: 6px 10px 0;
      }
      [${HOST_ATTR}] .g429-schat-close {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,.1);
        background: transparent;
        color: #8b98a8;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0;
        flex: 0 0 auto;
      }
      [${HOST_ATTR}] .g429-schat-close:hover {
        color: #e9eef5;
        background: #1e2c3a;
      }
    `;
    document.head.appendChild(style);
  }

  const runtime = {
    version: VERSION,
    alive: true,
    settings: readSettings(),
    phase: "idle",
    eventKey: null,
    threadId: null,
    sessionId: null,
    sessionTitle: null,
    turnId: null,
    dueAtMs: 0,
    expiresAtMs: 0,
    handledEventKey: "",
    lastAction: "",
    taskStatus: "unknown",
    taskThreadId: null,
    pendingTaskStatus: null,
    pendingTaskStatusSinceMs: 0,
    clickInFlight: false,
    recoveryAttempts: 0,
    clickCooldownUntilMs: 0,
    // 时间窗计数（默认 20 分钟）：窗口起点/计数，窗口内累计达到上限则停止，切换会话不清零
    capWindowStartMs: 0,
    capWindowCount: 0,
    // 后台守护：未打开会话的 { threadId -> { dueAtMs, eventKey } }
    background: new Map(),
    // 计划板运行时状态：按线程独立的计划容器
    planThreads: {},
    _planThreadsLoaded: false,
    planActiveThreadId: null,
    planLastImportAtMs: 0,
    deliveryState: (() => {
      try { return normalizeDeliveryState(JSON.parse(localStorage.getItem(DELIVERY_STATE_KEY) || "null")); }
      catch { return { state: "in-progress" }; }
    })(),
    deliveryConfirmStage: 0,
    deliveryModalToken: "",
    panelPosition: null,
    panelInitialized: false,
    // v1.9.16：刚导入完、等任务真的跑起来；期间不再排新倒计时，避免频繁操作输入框
    planAwaitTaskStart: false,
    planImportInFlight: false,
    // 计划板：任务刚变 completed 时排定的导入倒计时到期点 + 已排定的线程/段
    planDueAtMs: 0,
    planScheduledForTurnId: null,
    planScheduledIndex: 0,
    // 管家模式运行时：最近一次已触发审核的主任务 turn（防同一轮重复审核）
    stewardLastTurnId: null,
    // v1.9.3：最近一次读到的 settings 原文，用于检测外部变更、防止旧内存覆盖新配置
    _settingsRaw: "",
    // v1.9.16：本页面会话内是否由用户手动打开过（内存态，刷新即失效）
    sessionArmed: false,
    sessionKey: null,
    _planRaw: "",
    stewardReviewInFlight: false,
    stewardPendingTurnId: null,
    // steward：审核指令发出时刻（ms）与解析重试次数（输出渲染延迟/解析失败用）
    stewardPendingSentAtMs: 0,
    stewardParseRetries: 0,
    // 管家模式：审核超时（由 settings.stewardTimeoutMs 控制，默认 5 分钟）
    stewardTimeoutMs: 0, // resetRuntime 后从 settings 读取
    lastBgSwitchAtMs: 0,
  };
  // 取当前线程的 plan（每次读，避免切线程后用错态）
  function currentPlan() {
    if (!runtime._planThreadsLoaded) {
      runtime.planThreads = readPlanThreads();
      runtime._planThreadsLoaded = true;
    }
    return planForThread(runtime.planThreads, runtime.planActiveThreadId);
  }

  function ensureStewardSessionBootstrap() {
    if (!runtime.settings.steward || !runtime.settings.projectRoot) return null;
    const identity = currentSessionIdentity();
    if (!identity.memoryKey) return null;
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(STEWARD_BOOTSTRAP_KEY) || "{}") || {}; } catch (_) { seen = {}; }
    const marker = `${runtime.settings.projectRoot}::${identity.memoryKey}`;
    if (seen[marker]) return null;
    const text = buildStewardSessionBootstrap({
      projectRoot: runtime.settings.projectRoot,
      sessionTitle: identity.sessionTitle,
      sessionId: identity.sessionId,
      memoryKey: identity.memoryKey,
    });
    const tid = currentThreadId() || "default";
    runtime.planThreads = readPlanThreads();
    runtime._planThreadsLoaded = true;
    const plan = planForThread(runtime.planThreads, tid);
    const next = appendStewardPlan(plan, { fixes: null, nextPlan: text }, "记忆");
    const firstPending = next.entries.findIndex((entry) => !entry.done && entry.source === "steward");
    if (firstPending >= 0) next.index = firstPending;
    runtime.planThreads = upsertThreadPlan(runtime.planThreads, tid, next);
    writePlanThreads(runtime.planThreads);
    seen[marker] = { at: Date.now(), sessionId: identity.sessionId, sessionTitle: identity.sessionTitle };
    try { localStorage.setItem(STEWARD_BOOTSTRAP_KEY, JSON.stringify(seen)); } catch (_) {}
    if (typeof schatAddMsg === "function") {
      schatAddMsg("sys", `已为会话「${identity.sessionTitle}」准备专属记忆目录指令：${identity.memoryKey}`);
    }
    render();
    return { tid, memoryKey: identity.memoryKey, text };
  }

  installStyles();

  const host = document.createElement("div");
  const branding = panelBranding();
  host.setAttribute(HOST_ATTR, VERSION);
  host.dataset.open = "false";
  host.dataset.phase = runtime.phase;
  host.dataset.enabled = String(runtime.settings.enabled);
  host.dataset.taskStatus = runtime.taskStatus;
  host.innerHTML = `
    <div class="g429-panel" role="dialog" aria-label="${branding.panelAriaLabel}">
      <div class="g429-head">
        <span class="g429-title">${branding.title}</span>
        <span class="g429-version-tag">v${VERSION}</span>
      </div>
      <div class="g429-task">
        <span class="g429-task-dot"></span>
        <span class="g429-task-text">等待任务</span>
      </div>

      <!-- 计划板：第二主区块；运行时移动到管家模式之后 -->
      <div class="g429-group g429-group-primary" data-section="plan">
        <button class="g429-group-head" data-collapse="plan" type="button" aria-expanded="true">
          <span class="g429-chev">▾</span><span class="g429-group-name">计划板</span>
          <span class="g429-group-badge" data-plan-badge>0/0</span>
        </button>
        <div class="g429-group-body" data-body="plan">
          <div class="g429-row">
            <span class="g429-row-label" title="任务完成后自动导入下一段计划">计划模式</span>
            <label title="任务完成后自动导入下一段计划">
              <input class="g429-plan-enabled" type="checkbox" aria-label="启用计划模式">
              <span class="g429-switch g429-switch-plan">关</span>
            </label>
          </div>

          <!-- 计划内容：默认展开，可单独折叠 -->
          <button class="g429-subhead" data-collapse="planinput" type="button" aria-expanded="true">
            <span class="g429-chev">▾</span><span>计划内容</span>
            <span class="g429-group-badge" data-plan-badge2>0/0</span>
          </button>
          <div class="g429-group-body" data-body="planinput">
            <div class="g429-row" title="任务完成后等多久自动导入下一段">
              <span class="g429-row-label">等待</span>
              <div class="g429-segment g429-segment-sm" role="group" aria-label="计划导入倒计时">
                <button type="button" data-plan-delay="10">10 秒</button>
                <button type="button" data-plan-delay="30">30 秒</button>
              </div>
            </div>
            <div class="g429-row" title="关闭后计划就绪也不会自动发送，留给你预览确认">
              <span class="g429-row-label">关闭倒计时</span>
              <label title="打开=到点自动发送；关闭=等你点「立即导入」">
                <input class="g429-plan-countdown-enabled" type="checkbox" aria-label="启用计划导入倒计时">
                <span class="g429-switch g429-switch-countdown">开</span>
              </label>
            </div>
            <textarea class="g429-plan-text" rows="5" placeholder="每行一段计划文本，任务完成后自动导入" aria-label="计划文本"></textarea>
            <div class="g429-row">
              <button class="g429-plan-add" type="button" title="追加一行">+ 追加</button>
              <button class="g429-plan-reset" type="button" title="清空全部计划条目">✕ 清空</button>
              <span class="g429-plan-progress" style="color:#7f8b98">0/0</span>
            </div>
            <div class="g429-row">
              <button class="g429-plan-up" type="button" title="上移当前段（排序）">↑</button>
              <button class="g429-plan-down" type="button" title="下移当前段（排序）">↓</button>
              <span class="g429-plan-thread" title="计划按会话独立">本会话</span>
            </div>
            <div class="g429-row" data-plan-countdown-row hidden>
              <span class="g429-row-label">倒计时</span>
              <span class="g429-plan-countdown" style="color:#e8b04b;font-variant-numeric:tabular-nums">--</span>
              <button class="g429-plan-cancel" type="button" title="取消本次自动导入">取消</button>
            </div>
            <div class="g429-row" data-plan-manual-row hidden>
              <span class="g429-row-label">已就绪</span>
              <span style="flex:1;color:#e8b04b;font-size:11px">倒计时已关闭，等你确认</span>
              <button class="g429-plan-import-now" type="button" title="立即把当前计划段发进对话框">立即导入</button>
            </div>
            <div class="g429-row g429-delivery-strip" title="交付必须由用户手动确认，不会自动清理项目">
              <span class="g429-row-label">交付状态</span>
              <span class="g429-delivery-state-text" style="flex:1;font-size:11px;color:#8b98a8">进行中</span>
              <button class="g429-delivery-preview-btn" type="button" disabled title="预览备份与清理清单">预览交付</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 管家模式：第一主区块；运行时移动到计划板之前 -->
      <div class="g429-group g429-group-primary g429-group-hero" data-section="steward">
        <button class="g429-group-head" data-collapse="steward" type="button" aria-expanded="true">
          <span class="g429-chev">▾</span><span class="g429-group-name">管家模式</span>
          <span class="g429-group-badge" data-steward-badge>关</span>
        </button>
        <div class="g429-group-body" data-body="steward">
          <div class="g429-onboard" data-onboard hidden
            style="margin:2px 0 8px;padding:6px 8px;border-radius:6px;background:rgba(76,154,255,.08);border:1px solid rgba(76,154,255,.22);font-size:11px;line-height:1.6;color:#a8c4e0;">
            <div style="font-weight:600;color:#cfe2f5;margin-bottom:2px">首次使用，按顺序完成 4 步</div>
            <div>① 展开「LLM 供应商」填项目目录 + 模型 + Key</div>
            <div>② 打开「审核」开关</div>
            <div>③ 需要无人值守就点管家窗口「⏱ 自动审核」</div>
            <div>④ 任务完成后会自动审核并写回计划板</div>
          </div>
          <div class="g429-row" title="主任务完成后调 LLM 审核并写回计划板">
            <span class="g429-row-label">审核</span>
            <label title="完成后调 LLM 审核并推进计划">
              <input class="g429-steward" type="checkbox" aria-label="启用管家模式">
              <span class="g429-switch g429-switch-steward">关</span>
            </label>
          </div>
          <div class="g429-steward-body" hidden>
            <div class="g429-row" title="审核侧重：全量=完整审核，下一步=只给下一步计划，修改=只给修改步骤，优化=代码优化建议，开发=进一步开发">
              <span class="g429-row-label">侧重</span>
              <div class="g429-chiprow" role="group" aria-label="审核侧重">
                <button class="g429-chip g429-steward-mode" data-mode="review" type="button">全量</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-next" type="button">下一步</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-fixes" type="button">修改</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-optimize" type="button">优化</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-develop" type="button">开发</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-accept" type="button">验收</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-perf" type="button">性能</button>
                <button class="g429-chip g429-steward-mode" data-mode="review-docs" type="button">文档</button>
              </div>
            </div>
            <div class="g429-row" title="LLM 审核超时/重试上限后复位">
              <span class="g429-row-label">超时</span>
              <div class="g429-chiprow" role="group" aria-label="审核超时">
                <button class="g429-chip g429-steward-timeout" data-ms="300000" type="button">3m</button>
                <button class="g429-chip g429-steward-timeout" data-ms="600000" type="button">5m</button>
                <button class="g429-chip g429-steward-timeout" data-ms="900000" type="button">10m</button>
              </div>
            </div>
            <div class="g429-row" title="审核结果是否写回计划板（关闭则只发提示，不自动写条目）">
              <label class="g429-checklabel" title="审核结果写回计划板">
                <input class="g429-steward-writeplan" type="checkbox" aria-label="审核结果写回计划板" checked>
                <span>写回计划板</span>
              </label>
              <label class="g429-checklabel" title="写回后自动导入下一段">
                <input class="g429-steward-autoimport" type="checkbox" aria-label="写回后自动导入下一段" checked>
                <span>自动导入</span>
              </label>
            </div>
            <div class="g429-row">
              <span class="g429-steward-channel" title="LLM 供应商配置状态">通道：--</span>
              <span class="g429-steward-pending" title="管家审核待解析状态"></span>
            </div>

            <div class="g429-row" style="margin-top:6px">
              <button class="g429-selfcheck" type="button" title="一键检查配置、守护进程、计划板状态">运行自检</button>
              <span class="g429-selfcheck-result" style="flex:1;font-size:11px;color:#7f8b98"></span>
            </div>

            <!-- 管家日志（v1.9.0）：默认折叠 -->
            <button class="g429-subhead" data-collapse="log" type="button" aria-expanded="false">
              <span class="g429-chev">▸</span><span>管家日志</span>
              <span class="g429-log-count" data-log-count>0</span>
            </button>
            <div class="g429-group-body" data-body="log" hidden>
              <div class="g429-log-list" style="max-height:180px;overflow-y:auto;font-size:11px;line-height:1.5;"></div>
              <div class="g429-row" style="margin-top:6px">
                <button class="g429-log-clear" type="button">清空日志</button>
                <span class="g429-log-hint" style="color:#5a6775;font-size:10px">错误会打标签，同因不会重复触发</span>
              </div>
            </div>

            <!-- LLM 供应商配置（v1.9.0）：默认折叠 -->
            <button class="g429-subhead" data-collapse="llm" type="button" aria-expanded="false">
              <span class="g429-chev">▸</span><span>LLM 供应商</span>
              <span class="g429-llm-badge" data-llm-badge style="color:#a66">未配置</span>
            </button>
            <div class="g429-group-body" data-body="llm" hidden>
              <div class="g429-row" title="项目根目录：管家会读取这里的目录结构、README/HANDOFF 等 md，建立对项目的整体理解">
                <span class="g429-row-label">项目目录</span>
                <input class="g429-project-root" type="text" placeholder="/path/to/project" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
              <div class="g429-row" title="LLM 供应商：openai 及 custom 走 /chat/completions；anthropic 走 /messages；dashscope 走 OpenAI 兼容端点">
                <span class="g429-row-label">供应商</span>
                <div class="g429-chiprow" role="group" aria-label="LLM 供应商">
                  <button class="g429-chip g429-llm-provider" data-provider="openai" type="button">OpenAI</button>
                  <button class="g429-chip g429-llm-provider" data-provider="anthropic" type="button">Claude</button>
                  <button class="g429-chip g429-llm-provider" data-provider="dashscope" type="button">百炼</button>
                  <button class="g429-chip g429-llm-provider" data-provider="deepseek" type="button">DeepSeek</button>
                  <button class="g429-chip g429-llm-provider" data-provider="openrouter" type="button">OpenRouter</button>
                  <button class="g429-chip g429-llm-provider" data-provider="ollama" type="button">Ollama</button>
                  <button class="g429-chip g429-llm-provider" data-provider="custom" type="button">Custom</button>
                </div>
              </div>
              <div class="g429-row" title="baseURL（OpenAI 兼容端点；留空走官方默认）">
                <span class="g429-row-label">Base URL</span>
                <input class="g429-llm-baseurl" type="text" placeholder="留空用官方默认" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
              <div class="g429-row" title="模型名（如 gpt-4o-mini / claude-sonnet-4-20250514 / qwen-max）">
                <span class="g429-row-label">模型</span>
                <input class="g429-llm-model" type="text" placeholder="如 gpt-4o-mini / qwen-max" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
              <div class="g429-row" title="API Key 保存到 macOS Keychain，保存后不再明文回显">
                <span class="g429-row-label">API Key</span>
                <input class="g429-llm-key" type="password" placeholder="输入后保存到 Keychain；不会回显" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
                <button class="g429-llm-key-save" type="button" title="保存到 macOS Keychain">保存</button>
                <span class="g429-llm-keychain-status" style="font-size:10px;color:#8b98a8;white-space:nowrap">未配置</span>
              </div>
              <div class="g429-row" title="本地 CORS 代理端口（0=关，直连失败自动回退 8443；守护进程直连时不需要）">
                <span class="g429-row-label">CORS 代理</span>
                <input class="g429-llm-proxy" type="number" min="0" placeholder="0（关）" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
              <div class="g429-row" title="主模型不可用时自动切换到备用 Provider">
                <label class="g429-checklabel"><input class="g429-llm-fallback-enabled" type="checkbox"><span>启用备用模型</span></label>
                <select class="g429-llm-fallback-provider" style="background:#0b1017;color:#e9eef5;border:1px solid rgba(255,255,255,.14);border-radius:6px;font:inherit;font-size:11px;padding:4px">
                  <option value="">备用 Provider</option><option value="openai">OpenAI</option><option value="anthropic">Claude</option><option value="dashscope">百炼</option><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="ollama">Ollama</option><option value="custom">Custom</option>
                </select>
              </div>
              <div class="g429-row" title="备用模型 Base URL；留空使用 Provider 默认值">
                <span class="g429-row-label">备用 URL</span>
                <input class="g429-llm-fallback-baseurl" type="text" placeholder="留空用 Provider 默认" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
              <div class="g429-row" title="备用模型名">
                <span class="g429-row-label">备用模型</span>
                <input class="g429-llm-fallback-model" type="text" placeholder="fallback model" style="flex:1;min-width:0;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e9eef5;font:inherit;font-size:11px;padding:4px 6px;outline:none;">
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 次要区块：429 自动恢复（默认折叠） ===== -->
      <div class="g429-group" data-section="r429">
        <button class="g429-group-head" data-collapse="r429" type="button" aria-expanded="false">
          <span class="g429-chev">▸</span><span class="g429-group-name">429 自动恢复</span>
          <span class="g429-group-badge" data-429-badge>开</span>
        </button>
        <div class="g429-group-body" data-body="r429" hidden>
          <div class="g429-row" style="margin-bottom:4px">
            <span class="g429-status" style="margin:0;min-height:0;color:#aeb9c5">等待 429</span>
          </div>
          <div class="g429-row" title="启用或暂停 429 自动恢复">
            <span class="g429-row-label">启用 429 守护</span>
            <label>
              <input class="g429-enabled" type="checkbox" aria-label="启用 429 守护">
              <span class="g429-switch g429-switch-429">关</span>
            </label>
          </div>
          <div class="g429-row" title="429 出现后等多久自动点重试">
            <span class="g429-row-label">重试等待</span>
            <div class="g429-segment g429-segment-sm" role="group" aria-label="重试等待时间">
              <button type="button" data-delay="60">1 分钟</button>
              <button type="button" data-delay="180">3 分钟</button>
            </div>
          </div>
          <div class="g429-row" title="未打开的会话也能后台倒计时并切回前台触发">
            <span class="g429-row-label">后台守护</span>
            <label title="对未打开会话也执行计划模式/429 倒计时">
              <input class="g429-background" type="checkbox" aria-label="启用后台守护">
              <span class="g429-switch g429-switch-bg">开</span>
            </label>
          </div>
        </div>
      </div>

      <div class="g429-row" style="justify-content:space-between;padding-top:2px;color:#6f7d8c;font-size:10px">
        <span class="g429-attribution">Built By Yang YiZhu</span>
        <button class="g429-panel-reset-position" type="button" title="恢复默认右下角位置" style="appearance:none;border:1px solid rgba(255,255,255,.1);background:transparent;color:#8b98a8;border-radius:5px;padding:2px 6px;font:inherit;cursor:pointer">复位位置</button>
      </div>
      <div class="g429-row g429-foot">
        <span class="g429-action">管家待命</span>
        <button class="g429-steward-launcher" type="button" title="打开管家窗口（LLM 直连）">打开管家窗口</button>
        <button class="g429-close" type="button" title="收起" aria-label="收起">×</button>
      </div>
    </div>
    <div class="g429-schat" role="dialog" aria-label="侧边管家窗口"
      style="position:fixed;left:18px;bottom:88px;z-index:2147483646;width:380px;max-height:min(560px,calc(100vh - 140px));background:#141c26;border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.5);display:none;flex-direction:column;overflow:hidden;">
      <div class="g429-schat-head"
        style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,#1a2533 0%,#141c26 100%);flex:0 0 auto;cursor:move;user-select:none;">
        <span class="g429-schat-title" style="font-weight:650;font-size:12px;color:#e9eef5;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">管家 · LLM 审核通道</span>
        <span class="g429-schat-status" style="font-size:10px;color:#7f8b98;white-space:nowrap;">--</span>
        <button class="g429-schat-close" type="button" title="关闭" aria-label="关闭管家窗口"
          style="width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#8b98a8;cursor:pointer;font-size:14px;line-height:1;padding:0;flex:0 0 auto;">×</button>
      </div>
      <div class="g429-schat-body"
        style="flex:1 1 auto;min-height:120px;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;"></div>
      <button class="g429-subhead" data-collapse="trace" type="button" aria-expanded="false"
        style="margin:0 10px;flex:0 0 auto;">
        <span class="g429-chev">▸</span><span>审核过程</span>
        <span class="g429-log-count" data-trace-count>0</span>
      </button>
      <div class="g429-group-body" data-body="trace" hidden
        style="flex:0 0 auto;max-height:150px;overflow-y:auto;padding:4px 12px 0;font-size:11px;line-height:1.55;"></div>
      <div class="g429-schat-actrow"
        style="display:flex;gap:4px;padding:6px 10px 0;flex:0 0 auto;">
        <button class="g429-schat-act" data-schat-act="review" type="button" title="立即把主会话最新成果发给 LLM 审核"
          style="appearance:none;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,#1c2836 0%,#141d27 100%);color:#aeb9c5;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:4px 8px;white-space:nowrap;">▶ 触发审核</button>
        <button class="g429-schat-act" data-schat-act="write" type="button" title="把 LLM 最近一条回复解析并写回计划板"
          style="appearance:none;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,#1c2836 0%,#141d27 100%);color:#aeb9c5;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:4px 8px;white-space:nowrap;">⤓ 写回计划板</button>
        <button class="g429-schat-act" data-schat-act="auto" type="button" title="无人值守：开启后每次任务完成自动触发审核"
          style="appearance:none;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,#1c2836 0%,#141d27 100%);color:#aeb9c5;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:4px 8px;white-space:nowrap;">⏱ 自动审核</button>
        <button class="g429-schat-act" data-schat-act="clear" type="button" title="清空消息"
          style="appearance:none;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,#1c2836 0%,#141d27 100%);color:#aeb9c5;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:4px 8px;white-space:nowrap;">✕ 清空</button>
      </div>
      <div class="g429-schat-foot"
        style="display:flex;align-items:flex-end;gap:6px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.08);background:#10171f;flex:0 0 auto;">
        <div class="g429-schat-input" contenteditable="true" role="textbox" aria-label="管家指令输入框（发给 LLM）" data-codex-429-steward-input="true"
          style="flex:1;min-height:34px;max-height:96px;overflow-y:auto;border:1px solid rgba(255,255,255,.14);border-radius:6px;background:#0b1017;color:#e9eef5;font:12px/1.5 -apple-system,BlinkMacSystemFont,&quot;PingFang SC&quot;,sans-serif;padding:6px 8px;outline:none;"></div>
        <button class="g429-schat-send" type="button" title="发送指令给 LLM（直连或本地代理）"
          style="height:34px;padding:0 12px;border-radius:6px;border:1px solid rgba(76,154,255,.5);background:linear-gradient(180deg,#3a5f8a 0%,#2a4a70 100%);color:#eaf3ff;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap;">发送</button>
      </div>
    </div>
    <div class="g429-pill" role="button" tabindex="0" title="${branding.pillTitle}">
      <span class="g429-dot"></span>
      <span class="g429-label">${branding.pillLabel}</span>
    </div>
    <div class="g429-delivery-modal" role="dialog" aria-label="交付确认" hidden
      style="position:fixed;inset:10% 50% auto auto;transform:translateX(50%);z-index:2147483647;width:min(620px,calc(100vw - 40px));max-height:80vh;overflow:auto;background:#141c26;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.58);padding:14px;color:#dce6f1;">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px">交付预览与安全清理</div>
      <div class="g429-delivery-summary" style="font-size:11px;line-height:1.65;white-space:pre-wrap;max-height:48vh;overflow:auto;background:#0d141d;border:1px solid rgba(255,255,255,.08);border-radius:7px;padding:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="g429-delivery-cancel" type="button">取消</button>
        <button class="g429-delivery-continue" type="button">继续确认</button>
        <button class="g429-delivery-execute" type="button" hidden style="background:#7a2d2d;color:#ffecec">确认执行交付</button>
      </div>
    </div>
  `;
  document.body.appendChild(host);

  const planSection = host.querySelector(SELECTORS.ui.planSection);
  const stewardSection = host.querySelector(SELECTORS.ui.stewardSection);
  if (planSection && stewardSection) {
    stewardSection.parentNode.insertBefore(stewardSection, planSection);
  }

  const pill = host.querySelector(SELECTORS.ui.pill);
  const panel = host.querySelector(SELECTORS.ui.panel);
  const panelResetPositionButton = host.querySelector(SELECTORS.ui.panelResetPosition);
  const attributionNode = host.querySelector(SELECTORS.ui.attribution);
  if (attributionNode) attributionNode.textContent = ATTRIBUTION;

  function panelRect() {
    return panel?.getBoundingClientRect?.() || { width: 248, height: 0, left: 0, top: 0 };
  }

  function persistPanelPosition(position) {
    runtime.panelPosition = position;
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(position)); } catch (_) {}
  }

  function applyPanelPosition(position) {
    if (!panel || !position) return;
    const rect = panelRect();
    const clamped = clampPanelPosition({
      x: position.x,
      y: position.y,
      width: rect.width || 248,
      height: rect.height || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    runtime.panelPosition = clamped;
    panel.style.left = clamped.x + "px";
    panel.style.top = clamped.y + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return clamped;
  }

  function ensurePanelPosition() {
    if (!panel) return null;
    let position = runtime.panelPosition;
    if (!position) {
      try { position = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || "null"); } catch (_) { position = null; }
    }
    const rect = panelRect();
    if (!position) position = defaultPanelPosition({
      width: rect.width || 248,
      height: rect.height || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    runtime.panelInitialized = true;
    return applyPanelPosition(position);
  }

  function resetPanelPosition() {
    if (!panel) return null;
    const rect = panelRect();
    const position = defaultPanelPosition({
      width: rect.width || 248,
      height: rect.height || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    try { localStorage.removeItem(PANEL_POS_KEY); } catch (_) {}
    runtime.panelInitialized = true;
    return applyPanelPosition(position);
  }

  let panelDrag = null;
  panel?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    const blocked = target.closest?.("button,input,textarea,select,a,label,[contenteditable='true'],[data-no-drag]") || null;
    const allowed = canStartPanelDrag({
      tagName: target.tagName,
      isContentEditable: Boolean(target.isContentEditable),
      noDrag: Boolean(blocked),
      disabled: Boolean(target.disabled),
    });
    if (!allowed) return;
    ensurePanelPosition();
    const rect = panelRect();
    panelDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
    host.dataset.panelDragging = "true";
    try { panel.setPointerCapture(event.pointerId); } catch (_) {}
  });
  panel?.addEventListener("pointermove", (event) => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - panelDrag.startX;
    const dy = event.clientY - panelDrag.startY;
    if (!panelDrag.moved && Math.hypot(dx, dy) < 3) return;
    panelDrag.moved = true;
    event.preventDefault();
    const rect = panelRect();
    applyPanelPosition(clampPanelPosition({
      x: panelDrag.left + dx,
      y: panelDrag.top + dy,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  });
  function finishPanelDrag(event) {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
    try { panel.releasePointerCapture(event.pointerId); } catch (_) {}
    if (panelDrag.moved && runtime.panelPosition) persistPanelPosition(runtime.panelPosition);
    panelDrag = null;
    host.dataset.panelDragging = "false";
  }
  panel?.addEventListener("pointerup", finishPanelDrag);
  panel?.addEventListener("pointercancel", finishPanelDrag);
  function handlePanelResize() {
    if (!runtime.panelInitialized || !runtime.panelPosition) return;
    applyPanelPosition(runtime.panelPosition);
  }
  window.addEventListener("resize", handlePanelResize);
  panelResetPositionButton?.addEventListener("click", resetPanelPosition);

  const enabledInput = host.querySelector(SELECTORS.ui.enabled);
  const enabledSwitchUI = host.querySelector(SELECTORS.ui.switch429);
  const backgroundSwitchUI = host.querySelector(SELECTORS.ui.switchBg);
  const planEnabledSwitchUI = host.querySelector(SELECTORS.ui.switchPlan);
  const stewardSwitchUI = host.querySelector(SELECTORS.ui.switchSteward);

  const taskTextNode = host.querySelector(SELECTORS.ui.taskText);
  const statusNode = host.querySelector(SELECTORS.ui.status);
  const labelNode = host.querySelector(SELECTORS.ui.label);
  const actionNode = host.querySelector(SELECTORS.ui.action);
  const closeButton = host.querySelector(SELECTORS.ui.close);
  const delayButtons = [...host.querySelectorAll(SELECTORS.ui.delayBtn)];
  const maxConsecButtons = [...host.querySelectorAll(SELECTORS.ui.maxConsecBtn)];
  const backgroundInput = host.querySelector(SELECTORS.ui.background);
  const planEnabledInput = host.querySelector(SELECTORS.ui.planEnabled);
  const planBody = host.querySelector(SELECTORS.ui.planBody);
  const planTextArea = host.querySelector(SELECTORS.ui.planText);
  const planThreadNode = host.querySelector(SELECTORS.ui.planThread);
  const stewardInput = host.querySelector(SELECTORS.ui.steward);
  const stewardBody = host.querySelector(SELECTORS.ui.stewardBody);
  const stewardModeButtons = [...host.querySelectorAll(SELECTORS.ui.stewardMode)];
  const stewardTimeoutButtons = [...host.querySelectorAll(SELECTORS.ui.stewardTimeout)];
  const stewardWritePlanInput = host.querySelector(SELECTORS.ui.stewardWritePlan);
  const stewardAutoImportInput = host.querySelector(SELECTORS.ui.stewardAutoImport);
  const stewardChannelNode = host.querySelector(SELECTORS.ui.stewardChannel);
  const stewardPendingNode = host.querySelector(SELECTORS.ui.stewardPending);
  const llmProviderButtons = [...host.querySelectorAll(SELECTORS.ui.llmProvider)];
  const llmBaseUrlInput = host.querySelector(SELECTORS.ui.llmBaseUrl);
  const llmModelInput = host.querySelector(SELECTORS.ui.llmModel);
  const llmFallbackProviderInput = host.querySelector(SELECTORS.ui.llmFallbackProvider);
  const llmFallbackBaseUrlInput = host.querySelector(SELECTORS.ui.llmFallbackBaseUrl);
  const llmFallbackModelInput = host.querySelector(SELECTORS.ui.llmFallbackModel);
  const llmFallbackEnabledInput = host.querySelector(SELECTORS.ui.llmFallbackEnabled);
  const llmKeySaveButton = host.querySelector(SELECTORS.ui.llmKeySave);
  const llmKeychainStatus = host.querySelector(SELECTORS.ui.llmKeychainStatus);
  const deliveryStrip = host.querySelector(SELECTORS.ui.deliveryStrip);
  const deliveryStateText = host.querySelector(SELECTORS.ui.deliveryStateText);
  const deliveryPreviewButton = host.querySelector(SELECTORS.ui.deliveryPreview);
  const deliveryModal = host.querySelector(SELECTORS.ui.deliveryModal);
  const deliverySummary = host.querySelector(SELECTORS.ui.deliverySummary);
  const deliveryContinueButton = host.querySelector(SELECTORS.ui.deliveryContinue);
  const deliveryExecuteButton = host.querySelector(SELECTORS.ui.deliveryExecute);
  const deliveryCancelButton = host.querySelector(SELECTORS.ui.deliveryCancel);
  const llmKeyInput = host.querySelector(SELECTORS.ui.llmKey);
  const llmProxyInput = host.querySelector(SELECTORS.ui.llmProxy);
  const projectRootInput = host.querySelector(SELECTORS.ui.projectRoot);
  // ===== 侧边管家窗口（自建通道） =====
  const schat = host.querySelector(SELECTORS.ui.schat);
  const schatHead = host.querySelector(SELECTORS.ui.schatHead);
  const schatTitleNode = host.querySelector(SELECTORS.ui.schatTitle);
  const schatStatus = host.querySelector(SELECTORS.ui.schatStatus);
  const schatBody = host.querySelector(SELECTORS.ui.schatBody);
  const schatInput = host.querySelector(SELECTORS.ui.schatInput);
  const schatSend = host.querySelector(SELECTORS.ui.schatSend);
  const schatClose = host.querySelector(SELECTORS.ui.schatClose);
  const schatLauncher = host.querySelector(SELECTORS.ui.stewardLauncher);
  // ===== 拖拽移动管家窗口（拖 header 移动；位置存 localStorage） =====
  const SCHAT_POS_KEY = "codex429Guardian.schat.pos.v1";
  function schatApplyPos() {
    try {
      const p = JSON.parse(localStorage.getItem(SCHAT_POS_KEY) || "null");
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
        schat.style.left = p.left + "px";
        schat.style.top = p.top + "px";
        schat.style.bottom = "auto";
      }
    } catch (_) {}
  }
  function schatStartDrag(e) {
    // 只有点在 header 上（非按钮/输入）才拖
    if (e.target.closest("button, input")) return;
    e.preventDefault();
    const rect = schat.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    function move(ev) {
      let l = ev.clientX - offX;
      let t = ev.clientY - offY;
      const maxL = window.innerWidth - 60;
      const maxT = window.innerHeight - 40;
      l = Math.max(0, Math.min(l, maxL));
      t = Math.max(0, Math.min(t, maxT));
      schat.style.left = l + "px";
      schat.style.top = t + "px";
      schat.style.bottom = "auto";
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const r = schat.getBoundingClientRect();
      try { localStorage.setItem(SCHAT_POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (_) {}
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  if (schatHead) {
    schatHead.addEventListener("mousedown", schatStartDrag);
    schatHead.addEventListener("touchstart", (e) => {
      if (e.target.closest("button, input")) return;
      const rect = schat.getBoundingClientRect();
      const offX = e.touches[0].clientX - rect.left;
      const offY = e.touches[0].clientY - rect.top;
      function tmove(ev) {
        let l = ev.touches[0].clientX - offX;
        let t = ev.touches[0].clientY - offY;
        l = Math.max(0, Math.min(l, window.innerWidth - 60));
        t = Math.max(0, Math.min(t, window.innerHeight - 40));
        schat.style.left = l + "px"; schat.style.top = t + "px"; schat.style.bottom = "auto";
      }
      function tend() {
        window.removeEventListener("touchmove", tmove);
        window.removeEventListener("touchend", tend);
        const r = schat.getBoundingClientRect();
        try { localStorage.setItem(SCHAT_POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (_) {}
      }
      window.addEventListener("touchmove", tmove);
      window.addEventListener("touchend", tend);
    }, { passive: true });
  }
  schatApplyPos();
  const schatActButtons = [...host.querySelectorAll(SELECTORS.ui.schatActBtn)];
  const schatMsgLog = []; // 内存里的消息记录（窗口关闭不清）

  function schatAddMsg(kind, text) {
    const el = document.createElement("div");
    const isSent = kind === "sent";
    const isSys = kind === "sys";
    el.className = "g429-schat-msg";
    el.textContent = text;
    el.style.cssText = (
      "max-width:92%;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.55;" +
      "overflow-wrap:anywhere;white-space:pre-wrap;" +
      (isSent
        ? "align-self:flex-end;background:#2a4a70;border:1px solid rgba(76,154,255,.4);color:#eaf3ff;"
        : isSys
          ? "align-self:center;max-width:100%;border:none;color:#5a6775;font-size:11px;text-align:center;"
          : "align-self:flex-start;background:#1d2836;border:1px solid rgba(255,255,255,.1);color:#cfd9e4;")
    );
    schatBody.appendChild(el);
    schatBody.scrollTop = schatBody.scrollHeight;
    schatMsgLog.push({ kind, text });
    while (schatMsgLog.length > 60) schatMsgLog.shift();
  }
  let lastAnnouncedSessionKey = "";
  function announceBoundSession() {
    const identity = currentSessionIdentity();
    const key = identity.memoryKey || "未编号";
    if (lastAnnouncedSessionKey === key) return;
    lastAnnouncedSessionKey = key;
    schatAddMsg("sys", `已绑定会话「${identity.sessionTitle}」（编号 ${key}）`);
  }
  function schatSetOpen(open) {
    host.dataset.schatOpen = String(Boolean(open));
    if (schat) {
      schat.dataset.schatOpen = String(Boolean(open));
      // 直接控制 inline display，不依赖 CSS 属性选择器（保险）
      schat.style.display = open ? "flex" : "none";
    }
    if (open) schatInput.focus();
    if (open) announceBoundSession();
  }
  schatLauncher.addEventListener("click", () => schatSetOpen(host.dataset.schatOpen !== "true"));
  schatClose.addEventListener("click", () => schatSetOpen(false));
  // 初始化：确保收起态 inline display 正确
  if (host.dataset.schatOpen !== "true" && schat) schat.style.display = "none";

  // 发送（v1.8.55）：只写请求标志（带自定义文本），由原生守护进程执行 LLM。
  // 页面内绝不 fetch，避免 PNA/CORS 报错反复写进窗口。
  schatSend.addEventListener("click", async () => {
    const text = (schatInput.innerText || "").trim();
    if (!text) return;
    schatAddMsg("sent", text);
    schatInput.innerHTML = "";
    try {
      // v1.9.27：对话模式——带历史上下文，让管家能理解纠正与追问
      appendChat("user", text);
      const history = readChat().slice(-10);
      localStorage.setItem(AUDIT_REQUEST_KEY, JSON.stringify({ ts: Date.now(), text, chat: true, history, ...sessionRequestMeta() }));
      if (typeof addLog === "function") addLog("info", "对话消息已发送：" + text.slice(0, 60));
      schatAddMsg("sys", `已发送给会话「${runtime.sessionTitle || currentSessionTitle()}」的管家模型…`);
      render();
    } catch (err) {
      schatAddMsg("sys", "请求失败：" + String(err).slice(0, 120));
    }
  });
  schatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      schatSend.click();
    }
  });
  for (const b of schatActButtons) {
    b.addEventListener("click", () => {
      if (b.dataset.schatAct === "review") {
        schatAddMsg("sys", `已触发审核：会话「${runtime.sessionTitle || currentSessionTitle()}」的最新成果 → 管家窗口`);
        if (typeof triggerStewardReviewManual === "function") void triggerStewardReviewManual();
        else { schatAddMsg("sys", "审核函数未就绪"); }
      } else if (b.dataset.schatAct === "write") {
        try {
          const wasPending = runtime.stewardPendingTurnId;
          consumeStewardOutput();
          if (runtime.stewardPendingTurnId === wasPending && wasPending) {
            schatAddMsg("sys", "侧边还未回复，或回复不含「修改步骤/下一步计划」段（继续等待中）");
          } else {
            schatAddMsg("sys", "已写回计划板");
          }
        } catch (err) { schatAddMsg("sys", "写回失败：" + String(err).slice(0, 80)); }
      } else if (b.dataset.schatAct === "auto") {
        const on = runtime.settings.stewardAuto !== true;
        setSettings({ ...runtime.settings, stewardAuto: on });
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
        b.style.background = on ? "linear-gradient(180deg,#2a5a3a 0%,#1e4230 100%)" : "linear-gradient(180deg,#1c2836 0%,#141d27 100%)";
        b.style.color = on ? "#6fc" : "#aeb9c5";
        b.textContent = on ? "⏱ 自动审核 · 开" : "⏱ 自动审核";
        schatAddMsg("sys", on ? "已开启无人值守自动审核：每次任务完成会自动审核并写回计划板" : "已关闭自动审核");
      } else if (b.dataset.schatAct === "clear") {
        schatBody.innerHTML = "";
        schatMsgLog.length = 0;
      }
    });
  }
  const planAddButton = host.querySelector(SELECTORS.ui.planAdd);
  const planResetButton = host.querySelector(SELECTORS.ui.planReset);
  const planUpButton = host.querySelector(SELECTORS.ui.planUp);
  const planDownButton = host.querySelector(SELECTORS.ui.planDown);
  const planDelayButtons = [...host.querySelectorAll(SELECTORS.ui.planDelayBtn)];
  const planProgress = host.querySelector(SELECTORS.ui.planProgress);

  // ===== v1.9.0 折叠区块 + 日志 + 倒计时行 =====
  const collapseButtons = [...host.querySelectorAll(SELECTORS.ui.collapseBtn)];
  const planBadge = host.querySelector(SELECTORS.ui.planBadge);
  const stewardBadge = host.querySelector(SELECTORS.ui.stewardBadge);
  const r429Badge = host.querySelector(SELECTORS.ui.badge429);
  const llmBadge = host.querySelector(SELECTORS.ui.llmBadge);
  const logListEl = host.querySelector(SELECTORS.ui.logList);
  const logCountEl = host.querySelector(SELECTORS.ui.logCount);
  const logClearBtn = host.querySelector(SELECTORS.ui.logClear);
  const planCountdownRow = host.querySelector(SELECTORS.ui.planCountdownRow);
  const planCountdownEl = host.querySelector(SELECTORS.ui.planCountdown);
  const planCancelBtn = host.querySelector(SELECTORS.ui.planCancel);
  const planCountdownEnabledInput = host.querySelector(SELECTORS.ui.planCountdownEnabled);
  const planCountdownSwitchUI = host.querySelector(SELECTORS.ui.switchCountdown);
  const planManualRow = host.querySelector(SELECTORS.ui.planManualRow);
  const planImportNowBtn = host.querySelector(SELECTORS.ui.planImportNow);

  const COLLAPSE_KEY = "codex429Guardian.collapse.v1";
  function readCollapse() {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (_) { return {}; }
  }
  function writeCollapse(state) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  const collapseState = readCollapse();
  function applyCollapse(name, collapsed) {
    const btn = collapseButtons.find((b) => b.dataset.collapse === name);
    const body = host.querySelector(SELECTORS.ui.collapseGroupBody(name));
    if (!btn || !body) return;
    const ui = collapseUi(collapsed);
    btn.setAttribute("aria-expanded", ui.ariaExpanded);
    const chev = btn.querySelector(SELECTORS.ui.chev);
    if (chev) chev.textContent = ui.chevron;
    body.hidden = ui.hidden;
    collapseState[name] = collapsed;
    writeCollapse(collapseState);
  }
  // 初始状态：默认值 + 已保存偏好合并
  const initialCollapse = resolveCollapseState(collapseState);
  for (const name of Object.keys(COLLAPSE_DEFAULTS)) {
    applyCollapse(name, initialCollapse[name]);
  }
  for (const btn of collapseButtons) {
    btn.addEventListener("click", () => {
      const name = btn.dataset.collapse;
      const next = toggleCollapse(resolveCollapseState(collapseState), name);
      applyCollapse(name, next[name]);
    });
  }

  // ===== 管家日志（v1.9.0）：可查可读 + 错误打标签 + 防重复 =====
  const LOG_KEY = "codex429Guardian.auditLog.v1";
  const LOG_MAX = 40;
  function readLog() {
    try { const a = JSON.parse(localStorage.getItem(LOG_KEY)); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function writeLog(list) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-LOG_MAX))); } catch (_) {}
  }
  function renderLog() {
    const list = readLog();
    if (logCountEl) logCountEl.textContent = String(list.length);
    if (!logListEl) return;
    if (!list.length) {
      logListEl.innerHTML = '<div style="color:#5a6775">暂无记录</div>';
      return;
    }
    const COLORS = { ok: "#6fc99a", err: "#ff8a8a", dup: "#f0b86a", info: "#8fbde8" };
    logListEl.innerHTML = list.slice().reverse().map((e) => {
      const t = new Date(e.ts || Date.now());
      const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
      const kind = e.kind || "info";
      const label = { ok: "成功", err: "错误", dup: "去重", info: "信息" }[kind] || kind;
      const color = COLORS[kind] || "#8fbde8";
      const text = String(e.text || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      return '<div><span class="g429-log-tag" data-kind="' + kind + '" style="color:' + color + '">' + label + '</span>' +
        '<span style="color:#6b7a8a">' + hh + '</span> ' + text + '</div>';
    }).join("");
  }
  function addLog(kind, text, extra) {
    const list = readLog();
    list.push({ ts: Date.now(), kind, text: String(text || "").slice(0, 300), ...(extra || {}) });
    writeLog(list);
    renderLog();
  }
  window.__codex429AddLog = addLog;
  window.__codex429RenderLog = renderLog;

  // ===== v1.9.27：管家对话（用于纠正与追问）=====
  const CHAT_KEY = "codex429Guardian.stewardChat.v1";
  function readChat() {
    try { const a = JSON.parse(localStorage.getItem(CHAT_KEY)); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function writeChat(list) {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(list.slice(-40))); } catch (_) {}
  }
  function appendChat(role, text) {
    const list = readChat();
    list.push({ role, text: String(text || "").slice(0, 2000), ts: Date.now() });
    writeChat(list);
    if (typeof schatAddMsg === "function") schatAddMsg(role === "user" ? "sent" : "recv", text);
    return list;
  }
  window.__codex429ChatReply = (text) => appendChat("steward", text);
  window.__codex429ChatHistory = readChat;

  // ===== v1.9.26：审核过程追踪（做了什么 / 调了什么 / 读了什么）=====
  const TRACE_KEY = "codex429Guardian.stewardTrace.v1";
  const traceBody = host.querySelector(SELECTORS.ui.traceBody);
  const traceCount = host.querySelector(SELECTORS.ui.traceCount);
  function readTrace() {
    try { const a = JSON.parse(localStorage.getItem(TRACE_KEY)); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function renderTrace() {
    const list = readTrace();
    if (traceCount) traceCount.textContent = String(list.length);
    if (!traceBody) return;
    if (!list.length) { traceBody.innerHTML = '<div style="color:#5a6775">尚无记录</div>'; return; }
    const ICON = { read: "📄", call: "🔗", write: "✍️", ok: "✅", err: "❌", info: "•" };
    traceBody.innerHTML = list.slice(-40).map((e) => {
      const t = new Date(e.ts || Date.now());
      const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
      const color = e.kind === "err" ? "#ff8a8a" : e.kind === "ok" ? "#6fc99a" : "#93a4b6";
      const txt = String(e.detail || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      return '<div style="padding:2px 0;border-bottom:1px dashed rgba(255,255,255,.05)">' +
        '<span style="color:#5a6775">' + hh + '</span> ' +
        '<span>' + (ICON[e.kind] || "•") + '</span> ' +
        '<span style="color:' + color + '">' + String(e.step || "").replace(/[<>&]/g, "") + '</span>' +
        (txt ? ' <span style="color:#7f8b98">' + txt + '</span>' : '') + '</div>';
    }).join("");
    traceBody.scrollTop = traceBody.scrollHeight;
  }
  function addTrace(step, detail, kind) {
    const list = readTrace();
    list.push({ ts: Date.now(), step: String(step || "").slice(0, 60), detail: String(detail || "").slice(0, 200), kind: kind || "info" });
    try { localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-60))); } catch (_) {}
    renderTrace();
  }
  window.__codex429Trace = addTrace;
  window.__codex429RenderTrace = renderTrace;
  renderTrace();
  renderLog();
  if (logClearBtn) logClearBtn.addEventListener("click", () => { writeLog([]); renderLog(); });

  // ===== 一键自检（v1.9.5）=====
  const selfCheckBtn = host.querySelector(SELECTORS.ui.selfCheck);
  const selfCheckResult = host.querySelector(SELECTORS.ui.selfCheckResult);
  function runSelfCheck() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    // 1. 版本
    add("插件版本", true, VERSION);

    // 2. LLM 配置
    const hasKey = Boolean(runtime.settings.llmApiKey || runtime.deliveryState?.credentialStatus?.primary);
    const hasModel = Boolean(runtime.settings.llmModel);
    add("LLM 配置", hasKey && hasModel, hasKey && hasModel ? runtime.settings.llmModel : "缺 Key 或模型");

    // 3. 项目目录
    add("项目目录", Boolean(runtime.settings.projectRoot), runtime.settings.projectRoot || "未填写");

    // 4. 守护进程活跃：近 10 分钟内有过日志，或请求未被滞留
    const logList = readLog();
    const recent = logList.filter((e) => Date.now() - (e.ts || 0) < 10 * 60 * 1000);
    let pendingReq = null;
    try { pendingReq = JSON.parse(localStorage.getItem(AUDIT_REQUEST_KEY) || "null"); } catch (_) {}
    const stale = pendingReq && Date.now() - (pendingReq.ts || 0) > 15000;
    const daemonOk = recent.length > 0 && !stale;
    add("守护进程", daemonOk, daemonOk
      ? "近 10 分钟有 " + recent.length + " 条记录"
      : (stale ? "请求滞留 >15s，守护进程可能未运行" : "尚无审核记录，请点一次「触发审核」验证"));

    // 5. 计划板
    const plan = currentPlan();
    add("计划板", true, `${planCompletedCount(plan)}/${plan.entries.length} 段，倒计时${plan.countdownEnabled === false ? "关" : "开"}`);

    // 6. 选择器模块
    add("SELECTORS", Boolean(SELECTORS && SELECTORS.page && SELECTORS.ui),
      SELECTORS ? Object.keys(SELECTORS.page).length + "+" + Object.keys(SELECTORS.ui).length + " 个" : "缺失");

    // 7. DOM 关键节点
    const domOk = Boolean(
      document.querySelector(SELECTORS.page.composer) &&
      host.querySelector(SELECTORS.ui.planText)
    );
    const hasThread = (document.querySelector(SELECTORS.page.main)?.innerText || "").length > 0;
    add("DOM 关键节点", domOk, domOk
      ? "composer + 计划板就绪"
      : (hasThread ? "composer 缺失（Codex UI 可能已变更）" : "未打开会话：请先新建或选择一个会话"));

    const failed = checks.filter((c) => !c.ok);
    checks.forEach((c) => addLog(c.ok ? "ok" : "err", `自检·${c.name}：${c.detail}`, { check: c.name }));
    if (selfCheckResult) {
      selfCheckResult.textContent = failed.length === 0
        ? `全部通过（${checks.length} 项）`
        : `${failed.length} 项需处理：${failed.map((f) => f.name).join("、")}`;
      selfCheckResult.style.color = failed.length === 0 ? "#6fc99a" : "#ff8a8a";
    }
    applyCollapse("log", false); // 自动展开日志
    renderLog();
    return { checks, failed };
  }
  window.__codex429SelfCheck = runSelfCheck;
  if (selfCheckBtn) selfCheckBtn.addEventListener("click", () => runSelfCheck());

  // 计划倒计时行：显示剩余秒数 + 取消
  if (planCancelBtn) {
    planCancelBtn.addEventListener("click", () => {
      runtime.planDueAtMs = 0;
      runtime.planScheduledForTurnId = null;
      if (planCountdownRow) planCountdownRow.hidden = true;
      addLog("info", "已取消本次计划导入倒计时");
      render();
    });
  }
  // 倒计时总开关：关掉后计划就绪也不自动导入
  if (planCountdownEnabledInput) {
    planCountdownEnabledInput.addEventListener("change", () => {
      const plan = currentPlan();
      setPlan({ ...plan, countdownEnabled: planCountdownEnabledInput.checked });
      if (!planCountdownEnabledInput.checked) {
        runtime.planDueAtMs = 0;
        runtime.planScheduledForTurnId = null;
        addLog("info", "已关闭自动导入倒计时，计划就绪后需手动确认");
      } else {
        addLog("info", "已开启自动导入倒计时，继续向主会话输出");
        // 重新开启：若任务已完成且还有未完成段，立刻重新排队
        const p2 = currentPlan();
        if (p2.enabled && p2.index < p2.entries.length && runtime.taskStatus === "completed") {
          runtime.planDueAtMs = Date.now() + (p2.delaySeconds || 30) * 1000;
          runtime.planScheduledForTurnId = (runtime.planActiveThreadId === "default" ? null : runtime.planActiveThreadId);
        }
      }
      render();
    });
  }
  // 立即导入：手动触发一次
  if (planImportNowBtn) {
    planImportNowBtn.addEventListener("click", () => {
      runtime.planDueAtMs = 0;
      runtime.planScheduledForTurnId = null;
      addLog("info", "手动触发立即导入");
      void importNextPlan();
    });
  }

  function setOpen(open) {
    if (open) requestAnimationFrame(() => ensurePanelPosition());
    host.dataset.open = String(Boolean(open));
  }

  function setSettings(next) {
    runtime.settings = normalizeSettings(next);
    writeSettings(runtime.settings);
    if (
      runtime.eventKey &&
      runtime.dueAtMs > 0 &&
      runtime.phase !== "handled"
    ) {
      runtime.dueAtMs = Date.now() + runtime.settings.delaySeconds * 1000;
      runtime.expiresAtMs = runtime.dueAtMs + MAX_WAIT_AFTER_DUE_MS;
    }
    render();
  }

  function resetRuntime(phase = "idle") {
    runtime.phase = phase;
    runtime.stewardTimeoutMs = runtime.settings.stewardTimeoutMs || 300000;
    runtime.stewardParseRetries = 0;
    runtime.stewardPendingTurnId = null;
    runtime.eventKey = null;
    runtime.threadId = null;
    runtime.turnId = null;
    runtime.dueAtMs = 0;
    runtime.expiresAtMs = 0;
    runtime.clickInFlight = false;
    runtime.recoveryAttempts = 0;
    runtime.clickCooldownUntilMs = 0;
    // 时间窗计数跨会话保留：不在 resetRuntime 里清零
    runtime.background.clear();
  }

  function resetTaskStatus() {
    runtime.taskStatus = "unknown";
    runtime.pendingTaskStatus = null;
    runtime.pendingTaskStatusSinceMs = 0;
    // 切线程/重置时也清掉计划倒计时排定，避免跨线程误触发
    runtime.planDueAtMs = 0;
    runtime.planScheduledForTurnId = null;
  }

  // 时间窗计数（默认 20 分钟）：窗口内 429 次数达到上限则停止自动恢复；
  // 切换会话不清零，只有窗口过期后才清零重数。
  const CAP_WINDOW_MS = 20 * 60 * 1000;
  function bumpCapWindow(now) {
    if (
      !runtime.capWindowStartMs ||
      now - runtime.capWindowStartMs >= CAP_WINDOW_MS
    ) {
      runtime.capWindowStartMs = now;
      runtime.capWindowCount = 0;
    }
    runtime.capWindowCount += 1;
  }

  function isCapWindowExceeded(now) {
    // v1.8.36：429 上限已取消，无限重试（保留函数签名避免调用方报错）
    void now;
    return false;
  }

  function activateSignals(signals, now) {
    if (!signals.eventKey) return;
    // 同一 eventKey 被处理过：若是“连续 429”（仍在卡住），允许在连续次数上限内重排倒计时；
    // 达到上限则不再自动恢复（停止点击）。
    if (runtime.handledEventKey === signals.eventKey) {
      if (isCapWindowExceeded(now)) return; // 时间窗已达上限：停止排倒计时
      // 重新武装：重置该事件的 handled 标记，让下一次到期可再点一次
      runtime.handledEventKey = "";
    }
    if (runtime.eventKey !== signals.eventKey) {
      runtime.eventKey = signals.eventKey;
      runtime.threadId = signals.threadId;
      runtime.turnId = signals.turnId;
      runtime.dueAtMs = now + runtime.settings.delaySeconds * 1000;
      runtime.expiresAtMs = runtime.dueAtMs + MAX_WAIT_AFTER_DUE_MS;
      runtime.recoveryAttempts = 0;
      runtime.clickCooldownUntilMs = 0;
      bumpCapWindow(now);
    } else {
      // 同一事件再次 429：时间窗计数 +1（达到上限后由上面的 handled 判断拦截）
      bumpCapWindow(now);
      runtime.dueAtMs = now + runtime.settings.delaySeconds * 1000;
      runtime.expiresAtMs = runtime.dueAtMs + MAX_WAIT_AFTER_DUE_MS;
    }
    runtime.phase = signals.retryReady ? "waiting-retry" : "waiting-429";
  }

  // ===== 计划板：composer 写入 + 发送 =====

  function composerEditor() {
    return document.querySelector(SELECTORS.page.composer);
  }
  // 侧边聊天机制已全部移除（v1.8.40）：确保 / 读取侧边 composer 的函数已删，审核改 LLM 直连。



  // 读页面上渲染的 md 产物文本（默认读页面渲染；若需本地路径 md 由侧边 agent 去读，插件只提示）
  function renderedMdText() {
    // 读页面上渲染的 md 产物：
    //  1. 文件链接（a[href$=.md]）
    //  2. markdown 块里出现 .md 路径的段落（data-markdown-text-style 容器）
    //  3. [data-markdown-copy] 元素里含 .md 的
    const fileLinks = [...document.querySelectorAll(SELECTORS.page.markdownFileLink)]
      .map(a => a.getAttribute("href")).filter(Boolean);
    const mdBlocks = [...document.querySelectorAll(SELECTORS.page.markdownBlock)]
      .filter(el => /\.md\b/i.test(el.innerText || ""))
      .map(el => (el.innerText || "").trim());
    const copyEls = [...document.querySelectorAll(SELECTORS.page.markdownCopy)]
      .filter(el => /\.md\b/i.test(el.innerText || ""))
      .map(el => (el.innerText || "").trim());
    const parts = [...new Set([...fileLinks.map(h => "文件: " + h), ...mdBlocks, ...copyEls])]
      .filter(Boolean);
    return parts.length ? parts.join("\n").slice(0, 1500) : "";
  }

  // 把文本写入主任务 composer（v1.8.40：side 通道已移除，side=true 直接 false）
  function insertComposerText(text, side = false) {
    if (side) return false;
    const ed = composerEditor();
    if (!ed) return false;
    try {
      ed.focus();
      document.execCommand("insertText", false, text);
      return true;
    } catch (_) {
      return false;
    }
  }
  const AUDIT_REQUEST_KEY = "codex429Guardian.auditRequest.v1";
  // 自动路径（v1.8.55）：与手动按钮一致——只写请求标志，由原生守护进程执行 LLM。
  // 页面内绝不发起网络请求，避免浏览器 PNA/CORS 报错反复写进管家窗口。
  async function triggerStewardReview() {
    if (runtime.stewardReviewInFlight) return;
    const mode = runtime.settings.stewardMode || "review";
    if (mode === "off") return;
    const turn = currentTurn();
    const turnId = turn.turnId;
    if (!turnId || turnId === runtime.stewardLastTurnId) return;
    // v1.9.15：上一段必须「完成且输出完整」才请求审核，避免拿半截结果归纳
    const signalsNow = currentSignals();
    const complete = isResultComplete({
      text: String(turn.turnText || ""),
      hasStop: Boolean(signalsNow.hasStopButton),
      taskStatus: signalsNow.taskStatus,
    });
    if (!complete) {
      if (typeof addLog === "function") {
        addLog("info", "上一段尚未完整输出，暂缓请求审核", { taskStatus: signalsNow.taskStatus });
      }
      return;
    }
    runtime.stewardLastTurnId = turnId;
    try {
      localStorage.setItem(AUDIT_REQUEST_KEY, JSON.stringify({ ts: Date.now(), ...sessionRequestMeta() }));
      if (typeof addLog === "function") addLog("info", "自动审核请求已提交（" + mode + "）");
      console.info("[guardian] 已请求守护进程审核", { turnId, mode });
    } catch (_) {}
  }


  // 手动「▶ 触发审核」（v1.8.52）：页面无法直连 localhost（浏览器 PNA/证书拦截），
  // 改为写一个请求标志，由原生守护进程 scripts/steward-daemon.mjs 通过 CDP 读到后执行 LLM 调用。
  async function triggerStewardReviewManual() {
    try {
      localStorage.setItem(AUDIT_REQUEST_KEY, JSON.stringify({ ts: Date.now(), ...sessionRequestMeta() }));
      if (typeof schatAddMsg === "function") {
        schatAddMsg("sys", `已请求审核会话「${runtime.sessionTitle || currentSessionTitle()}」——由本地守护进程执行（LLM 走原生通道，3 秒内响应）`);
      }
      render();
    } catch (e) {
      if (typeof schatAddMsg === "function") schatAddMsg("sys", "请求失败：" + String(e).slice(0, 80));
    }
  }





  // LLM 供应商调用（v1.8.38）：把审核 prompt 发给配置的模型，拿回文本。
  // 返回 { ok, text, error }。不支持的 provider 或无 key 时返回 ok:false。
  async function callLlmSteward(promptText) {
    const s = runtime.settings;
    const provider = s.llmProvider || "openai";
    const base = String(s.llmBaseUrl || "").replace(/\/$/, "");
    const key = s.llmApiKey || "";
    const model = s.llmModel || "";
    if (!key || !model) return { ok: false, text: "", error: "未配置 LLM 供应商（baseURL/apiKey/model 缺一）" };

    const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + key };
    let url, body;
    if (provider === "anthropic") {
      url = base ? base + "/messages" : "https://api.anthropic.com/v1/messages";
      headers["anthropic-version"] = "2023-06-01";
      delete headers["Authorization"];
      headers["x-api-key"] = key;
      body = { model, max_tokens: 1024, messages: [{ role: "user", content: promptText }] };
    } else if (provider === "dashscope") {
      url = base ? base : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
      body = { model, messages: [{ role: "user", content: promptText }] };
    } else {
      // openai 及 custom（OpenAI 兼容）
      url = base ? (base + "/chat/completions") : "https://api.openai.com/v1/chat/completions";
      body = { model, messages: [{ role: "user", content: promptText }] };
    }

    // 回退链（v1.8.46）：
    //  ① 用户配置端口（若 >0）
    //  ② CodexPlus 内置 LLM 代理 57321（http://127.0.0.1:57321/chat/completions，
    //     同供应商、由 CodexPlus 注入 key，免 CORS、免证书——首选）
    //  ③ 自签 HTTPS 8443（需信任证书）
    //  ④ 直连（最后手段，可能被 CORS 拦）
    // 回退链（v1.8.46 修订）：用户配置端口（若 ≠57321）→ 自签 HTTPS 8443 → 直连。
    // 57321（CodexPlus 内置 LLM 代理）虽在跑，但安全上下文里 http/https 都被拦，已实测无效，跳过。
    const configuredPort = Number(runtime.settings.llmProxyPort);
    const order = [];
    if (configuredPort > 0) order.push({ useProxy: true, pport: configuredPort, https: configuredPort === 8443 });
    if (configuredPort !== 8443) order.push({ useProxy: true, pport: 8443, https: true });
    order.push({ useProxy: false, pport: 0, https: false });

    const doFetch = async (useProxy, pport, httpsMode) => {
      const isCodexPlus = pport === 57321;
      const targetUrl = useProxy
        ? ((httpsMode ? "https" : "http") + "://127.0.0.1:" + pport + (isCodexPlus ? "/chat/completions" : "/llm"))
        : url;
      const targetHeaders = isCodexPlus
        ? { "Content-Type": "application/json", ...(key ? { "Authorization": "Bearer " + key } : {}) }
        : useProxy
          ? { "Content-Type": "application/json" }
          : headers;
      const targetBody = isCodexPlus
        ? JSON.stringify({ model, messages: [{ role: "user", content: promptText }] })
        : useProxy
          ? JSON.stringify({ provider, baseUrl: base, apiKey: key, model, body })
          : JSON.stringify(body);
      const resp = await fetch(targetUrl, { method: "POST", headers: targetHeaders, body: targetBody });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error("HTTP " + resp.status + " " + errText.slice(0, 120));
      }
      const data = await resp.json();
      const inner = data?.upstream || data; // 自签代理包一层 upstream；57321 直接返回 OpenAI 格式
      const text =
        inner?.choices?.[0]?.message?.content ||
        inner?.content?.[0]?.text ||
        inner?.text ||
        "";
      if (!text) throw new Error("模型返回为空");
      return text;
    };

    let lastErr = "";
    const tried = [];
    for (const o of order) {
      tried.push(o.useProxy ? "代理:" + o.pport : "直连");
      try {
        const text = await doFetch(o.useProxy, o.pport, o.https);
        return { ok: true, text, error: "" };
      } catch (e) {
        lastErr = String(e?.message || e).slice(0, 160);
        // 直连失败也继续（试下一个代理）；代理失败也继续（试下一个）
      }
    }
    return {
      ok: false, text: "",
      error: "LLM 调用失败（已试 " + tried.join(" → ") + "）：" + lastErr +
             "。唯一可行：信任自签证书让 https://127.0.0.1:8443 通——双击 resources/cert/llm-proxy.crt → 「信任」→「始终信任」→ 输密码 → 本窗口 Command+R。",
    };
  }

  function consumeStewardOutput() {
    // v1.8.40：侧边轮询废弃，仅清理遗留 pending。
    if (runtime.stewardPendingTurnId) {
      runtime.stewardPendingTurnId = null;
      runtime.stewardParseRetries = 0;
    }
  }


  function findComposerSendButton() {
    const layout = document.querySelector(SELECTORS.page.composerLayout);
    const composer = document.querySelector(SELECTORS.page.composerBody);
    const roots = [layout ? layout.parentElement : layout, layout, composer, document.querySelector(SELECTORS.page.main)]
      .filter(Boolean);
    for (const root of roots) {
      let region = root;
      for (let i = 0; i < 8 && region; i += 1, region = region.parentElement) {
        const btns = [...region.querySelectorAll(SELECTORS.page.buttonLike)]
          .filter((b) => isVisible(b));
        for (const b of btns) {
          const label = normalizeButtonText(b.getAttribute("aria-label") || "");
          if (/^(?:发送|submit|send)$/i.test(label)) return b;
        }
      }
    }
    return null;
  }

  // 把文本写入 composer（Lexical 编辑器）。写入后按钮会从「停止」切到「发送」。
  function insertComposerText(text) {
    const ed = composerEditor();
    if (!ed) return false;
    try {
      ed.focus();
      document.execCommand("insertText", false, text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearComposer() {
    const ed = composerEditor();
    if (!ed) return;
    try {
      ed.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      ed.blur();
    } catch (_) {}
  }

  // 把下一段计划文本写入 composer 并发送。
  // 前置条件由 shouldImportPlan 保证；这里只做写入 + 点击 + 推进索引。
  async function importNextPlan() {
    if (runtime.planImportInFlight) return;
    const tid = runtime.planActiveThreadId;
    let plan = planForThread(runtime.planThreads, tid);
    const text = planImportText(plan);
    if (!text) return;
    runtime.planImportInFlight = true;
    try {
      // 导入前清空 composer 旧草稿，避免上一段/手动输入残留叠加
      try {
        const ed0 = composerEditor();
        if (ed0) { ed0.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      } catch (_) {}
      const ok = insertComposerText(text);
      if (!ok) {
        toast("计划板：未找到 composer 文本框，已跳过");
        return;
      }
      // 等 composer 渲染出发送按钮
      await delay(400);
      const sendBtn = findComposerSendButton();
      if (sendBtn) {
        dispatchRecoveryGesture(sendBtn, 0);
      } else {
        clearComposer();
        toast("计划板：未找到发送按钮，已清空草稿");
        return;
      }

      // v1.9.13：确认「已触发开始」——等停止按钮出现或草稿被清空，最多 3s
      let started = false;
      for (let i = 0; i < 12; i += 1) {
        await delay(250);
        const stopVisible = [...document.querySelectorAll(SELECTORS.page.ariaButton)].some(
          (b) => /^(停止|stop)$/i.test(b.getAttribute("aria-label") || "") && b.getBoundingClientRect().width > 0,
        );
        const draft = (composerEditor()?.innerText || "").trim();
        if (stopVisible || !draft) { started = true; break; }
      }
      if (!started) {
        // 没起来：清空草稿、不推进索引，等待下一轮重试
        clearComposer();
        addLog("err", "计划导入后未确认任务启动（停止按钮未出现/草稿未清空），已保留当前段待重试", { tag: "not-started" });
        toast("计划板：发送后未确认任务启动，已保留该段");
        return;
      }
      addLog("info", "计划段已发送并确认启动", { index: plan.index });
      // 标记该段已完成 + 索引前进，写回该线程
      const entry = plan.entries[plan.index];
      if (entry) entry.done = true;
      const advanced = nextPlanIndex(plan);
      const saved = upsertThreadPlan(runtime.planThreads, tid, {
        ...plan,
        index: advanced,
      });
      runtime.planThreads = saved;
      runtime.planLastImportAtMs = Date.now();
      // 清空本轮排定的倒计时，等待下一段任务完成后再排定
      runtime.planDueAtMs = 0;
      runtime.planScheduledForTurnId = null;
      // v1.9.16：进入「等待任务启动」状态，避免任务未起来时又排新倒计时
      runtime.planAwaitTaskStart = true;
      writePlanThreads(saved);
      toast("计划板：已导入下一段并标记完成");
      render();
    } finally {
      runtime.planImportInFlight = false;
    }
  }

  // 后台会话守护：
  //  - 对非前台会话，若其 planThreads 已 enabled（计划模式开），则在该会话“下一次被打开”时
  //    由前台逻辑触发计划导入；若处于 429（is429 文本仍在该会话 DOM 里可见），则切回前台并倒计时触发重试。
  //  - 这里只“预登记”：把需要后台守护的会话 id 存进 runtime.background；真正点击仍由 scan() 切到前台后执行。
  function scheduleBackgroundThreads(activeThreadId) {
    if (!runtime.settings.enabled || !runtime.settings.background) {
      runtime.background.clear();
      return;
    }
    // 前台会话处于活跃 429 事件（未处理完成）时，标记 pending429，
    // 这样用户切走后该会话仍在后台守护列表里，到点会切回前台点恢复
    if (activeThreadId && runtime.eventKey && runtime.threadId === activeThreadId
        && runtime.handledEventKey !== runtime.eventKey
        && runtime.dueAtMs > 0) {
      const existing = runtime.background.get(activeThreadId) || {};
      runtime.background.set(activeThreadId, {
        threadId: activeThreadId,
        dueAtMs: runtime.dueAtMs,
        pending429: true,
      });
    } else if (activeThreadId && runtime.handledEventKey === runtime.eventKey && runtime.eventKey) {
      // 恢复成功：清除该会话的 pending429
      const existing = runtime.background.get(activeThreadId);
      if (existing?.pending429) {
        runtime.background.set(activeThreadId, { ...existing, pending429: false });
      }
    }
    const ids = threadsNeeding429Guard(activeThreadId).slice(0, BG_MAX_THREADS);
    const now = Date.now();
    // 清理已失效的后台条目
    for (const key of [...runtime.background.keys()]) {
      if (!ids.includes(key)) runtime.background.delete(key);
    }
    for (const id of ids) {
      const plan = planForThread(runtime.planThreads, id);
      const existing = runtime.background.get(id) || {};
      const is429 = Boolean(existing.pending429);
      const hasPlan = Boolean(plan?.enabled);
      // 只有真 429 或 计划模式开启 的会话才登记；
      // 429 会话的 dueAtMs 用 foreground 的 runtime.dueAtMs（已排定）或默认 delaySeconds；
      // 计划模式会话的 dueAtMs 用 delaySeconds（等任务完成后 scan 会排定 planDueAtMs）
      if (!is429 && !hasPlan) continue;
      runtime.background.set(id, {
        threadId: id,
        dueAtMs: (is429 && existing.dueAtMs) || now + runtime.settings.delaySeconds * 1000,
        pending429: is429,
      });
    }
  }

  // 若某个后台会话到了倒计时点，则切到该会话并触发前台 click（交给 scan 的主循环）
  function triggerBackgroundSwitch() {
    if (!runtime.settings.enabled || !runtime.settings.background) return;
    const now = Date.now();
    // 冷却：每次自动切换后 30s 内不再切，防止多会话同时到期导致乱跳
    if (runtime.lastBgSwitchAtMs && now - runtime.lastBgSwitchAtMs < 30_000) return;
    let target = null;
    for (const [id, bg] of runtime.background.entries()) {
      if (now >= bg.dueAtMs && !target) target = id;
      if (target && now >= target.dueAtMs) break;
    }
    if (!target) return;
    switchToThread(target);
    runtime.lastBgSwitchAtMs = now;
  }

  // 切换 Codex 会话：点侧边栏对应行
  function switchToThread(threadId) {
    const row = document.querySelector(
      SELECTORS.page.sidebarThreadById(threadId),
    );
    if (!row) return;
    row.click();
  }

  function triggerPlanImportIfDue(signals, threadId) {
    if (runtime.planImportInFlight) return;
    // v1.9.16：上一段刚导入、任务还没真正跑起来 -> 不再操作输入框
    if (runtime.planAwaitTaskStart) return;
    // 绑定当前线程
    runtime.planActiveThreadId = threadId || null;
    const plan = currentPlan();
    // busy 仅当任务真在跑（有停止按钮）；composer 草稿不算 busy（避免 guardian 自己导入的
    // 草稿导致下一轮误判、导入卡住抖动）。任务跑完草稿会被 send 掉，不影响。
    const composerBusy = Boolean(signals.hasStopButton);
    // v1.9.13：取「上一段任务的完整输出」用于完整性判定
    const resultText = (() => {
      try {
        const turn = currentTurn();
        const t = String(turn?.turnText || "").trim();
        if (t) return t;
        const main = document.querySelector(SELECTORS.page.main);
        return main ? (main.innerText || "").trim() : "";
      } catch (_) { return ""; }
    })();
    const now = Date.now();

    // 切线程：重置排定的倒计时，避免跨线程误触发
    if (
      runtime.planScheduledForTurnId &&
      runtime.planScheduledForTurnId !== (threadId || null)
    ) {
      runtime.planDueAtMs = 0;
      runtime.planScheduledForTurnId = null;
    }

    // 任务刚变 completed 且该线程还没排定倒计时：从此刻起算 delaySeconds
    // 若用户关闭了倒计时，则不排定 -> 等待手动「立即导入」
    if (
      plan.enabled &&
      plan.countdownEnabled !== false &&
      signals.taskStatus === "completed" &&
      plan.index < plan.entries.length &&
      !runtime.planDueAtMs
    ) {
      runtime.planDueAtMs = now + plan.delaySeconds * 1000;
      runtime.planScheduledForTurnId = threadId || null;
      runtime.planScheduledIndex = plan.index;
    }

    // v1.9.11：关闭倒计时 = 暂停计划板向主会话输出，只留手动「立即导入」
    const autoAllowed = canAutoImport(plan) && runtime.sessionArmed === true;
    if (
      autoAllowed &&
      shouldImportPlan({
        plan,
        taskStatus: signals.taskStatus,
        composerBusy: composerBusy,
        nowMs: now,
        lastImportAtMs: runtime.planLastImportAtMs,
        planDueAtMs: runtime.planDueAtMs,
        resultComplete: isResultComplete({
          text: resultText,
          hasStop: Boolean(signals.hasStopButton),
          taskStatus: signals.taskStatus,
        }),
      })
    ) {
      void importNextPlan();
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function dispatchRecoveryGesture(element, attempt) {
    try {
      element.focus?.({ preventScroll: true });
    } catch (_) {}

    if (attempt === 0 || attempt === 2) {
      element.click();
      return;
    }

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    element.dispatchEvent(new PointerEvent("pointerdown", base));
    element.dispatchEvent(new MouseEvent("mousedown", base));
    element.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    element.click();
  }

  function markRecoveryHandled(eventKey, action) {
    runtime.handledEventKey = eventKey;
    // 不再把 phase 锁死为 "handled"：若同一 429 事件再次出现，
    // activateSignals 会基于时间窗计数（capWindowCount）决定是否重排倒计时。
    runtime.lastAction = action || new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  async function performRecoveryClicks(eventKey) {
    if (runtime.clickInFlight) return;
    runtime.clickInFlight = true;
    runtime.recoveryAttempts = 0;
    runtime.clickCooldownUntilMs = 0;
    runtime.phase = "clicking";
    render();

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!runtime.alive || runtime.eventKey !== eventKey) return;
        const currentThread = currentThreadId();
        if (currentThread !== runtime.threadId) return;

        const live = currentSignals(currentThread);
        if (
          isRecoveryConfirmed({
            clickedEventKey: eventKey,
            currentEventKey: live.eventKey,
            hasStopButton: live.hasStopButton,
            retryButtonVisible: Boolean(live.retryButton),
            is429: live.is429,
          })
        ) {
          markRecoveryHandled(eventKey, "任务已自行恢复");
          return;
        }
        if (!live.retryButton?.element) break;

        runtime.recoveryAttempts = attempt + 1;
        runtime.lastAction = `第 ${runtime.recoveryAttempts} 次触发继续`;
        render();
        dispatchRecoveryGesture(live.retryButton.element, attempt);
        await delay(attempt === 0 ? 1400 : 1000);

        if (!runtime.alive || runtime.eventKey !== eventKey) return;
        const after = currentSignals(currentThreadId());
        if (
          isRecoveryConfirmed({
            clickedEventKey: eventKey,
            currentEventKey: after.eventKey,
            hasStopButton: after.hasStopButton,
            retryButtonVisible: Boolean(after.retryButton),
            is429: after.is429,
          })
        ) {
          markRecoveryHandled(eventKey);
          toast("已检测到 429，并成功继续任务");
          return;
        }
      }

      if (runtime.eventKey === eventKey) {
        runtime.phase = "waiting-retry";
        runtime.clickCooldownUntilMs = Date.now() + 10000;
        runtime.lastAction = "继续按钮点击未生效，10 秒后自动重试";
        toast("继续按钮点击未生效，稍后将自动重试");
      }
    } finally {
      runtime.clickInFlight = false;
      render();
    }
  }

  function updateSwitchUI() {
    const setOn = (input, span) => {
      if (!span) return;
      span.dataset.on = String(input.checked);
      span.textContent = input.checked ? "开" : "关";
    };
    setOn(enabledInput, enabledSwitchUI);
    setOn(backgroundInput, backgroundSwitchUI);
    setOn(planEnabledInput, planEnabledSwitchUI);
    setOn(stewardInput, stewardSwitchUI);
  }

  function loadDeliveryState() {
    try {
      runtime.deliveryState = normalizeDeliveryState(JSON.parse(localStorage.getItem(DELIVERY_STATE_KEY) || "null"));
    } catch {
      runtime.deliveryState = { state: "in-progress" };
    }
  }

  function deliveryStateLabel(state) {
    return {
      "in-progress": "进行中",
      "needs-work": "待补齐",
      "ready-for-confirmation": "可确认交付",
      delivered: "已交付",
    }[state] || "进行中";
  }

  function renderDeliveryState() {
    const delivery = normalizeDeliveryState(runtime.deliveryState);
    if (deliveryStateText) {
      const label = deliveryStateLabel(delivery.state);
      const blocked = delivery.decision?.blockingIssues?.length || 0;
      deliveryStateText.textContent = blocked ? `${label} · ${blocked} 项阻断` : label;
      deliveryStateText.style.color = delivery.state === "ready-for-confirmation" ? "#6fc99a" : delivery.state === "delivered" ? "#7fb8ff" : delivery.state === "needs-work" ? "#e8b04b" : "#8b98a8";
    }
    if (deliveryPreviewButton) {
      deliveryPreviewButton.disabled = delivery.state !== "ready-for-confirmation";
      deliveryPreviewButton.title = deliveryPreviewButton.disabled ? "计划完成且所有质量门禁通过后可预览交付" : "预览备份与清理清单";
    }
    const preview = delivery.preview;
    if (!preview) {
      if (deliveryModal) deliveryModal.hidden = true;
      return;
    }
    if (!deliveryModal || !deliverySummary) return;
    if (runtime.deliveryModalToken === preview.executeToken) return;
    runtime.deliveryModalToken = preview.executeToken;
    runtime.deliveryConfirmStage = 0;
    const excludeCounts = Object.entries(preview.excludedCounts || {}).map(([key, value]) => `${key}: ${value}`).join("，") || "无";
    deliverySummary.textContent = [
      `任务等级：${delivery.taskLevel || "feature"}`,
      `备份文件：${preview.include?.length || 0} 个，约 ${Math.ceil((preview.estimatedBytes || 0) / 1024)} KB`,
      `排除项：${excludeCounts}`,
      `清理候选：${(preview.cleanupCandidates || []).map((item) => item.path).join("，") || "无"}`,
      `备份目录：${preview.projectRoot}/outputs/guardian-delivery-<时间>/`,
      "",
      "清理只会处理 .guardian 运行缓存和临时文件，并在生成并校验备份后执行。",
    ].join("\n");
    deliveryContinueButton.hidden = false;
    deliveryExecuteButton.hidden = true;
    deliveryExecuteButton.disabled = false;
    deliveryExecuteButton.textContent = "确认执行交付";
    deliveryModal.hidden = false;
  }

  function render() {
    const now = Date.now();
    if (!host.isConnected) {
      try { document.body.appendChild(host); } catch (_) {}
    }
    host.dataset.phase = runtime.phase;
    host.dataset.enabled = String(runtime.settings.enabled);
    host.dataset.taskStatus = runtime.taskStatus;
    taskTextNode.textContent = taskStatusLabel(runtime.taskStatus);
    pill.title = `${taskStatusLabel(runtime.taskStatus)} · ${branding.pillTitle}`;
    enabledInput.checked = runtime.settings.enabled;
    backgroundInput.checked = runtime.settings.background;
    backgroundInput.checked = runtime.settings.background;
    stewardInput.checked = runtime.settings.steward;
    renderStewardState();
    loadDeliveryState();
    renderDeliveryState();
    // 计划板 UI 同步（按当前线程）
    const curPlan = currentPlan();
    planEnabledInput.checked = curPlan.enabled;
    // 只在「textarea 非焦点 + 内容确实落后于 plan.entries」时写回；
    // 用 planTextArea.value 和 entries 渲染出的字符串对比，避免强制覆盖用户输入。
    const desired = curPlan.entries
      .map((e, i) => `${i + 1}. ${e.done ? "[已完成] " : ""}${e.text}`)
      .join("\n");
    if (planTextArea !== document.activeElement && planTextArea.value !== desired) {
      planTextArea.value = desired;
    }
    // 用户正在编辑：把 textarea 里的内容实时解析回 plan.entries（持久化），
    // 这样即使 render 被反复调用，也不会把用户输入冲掉。
    if (planTextArea === document.activeElement) {
      const edited = parsePlanLines(planTextArea.value);
      if (JSON.stringify(edited.map(e=>({t:e.text,d:e.done}))) !== JSON.stringify(curPlan.entries.map(e=>({t:e.text,d:e.done})))) {
        setPlan({ ...curPlan, entries: edited, index: Math.min(curPlan.index, Math.max(edited.length - 1, 0)) });
      }
    }
    const total = curPlan.entries.length;
    const doneCount = planCompletedCount(curPlan);
    const progressText = `${doneCount}/${total}`;
    // 计划板倒计时显示：排定后实时显示剩余秒数
    if (runtime.planDueAtMs > 0 && now < runtime.planDueAtMs) {
      const remainSec = Math.max(0, Math.ceil((runtime.planDueAtMs - now) / 1000));
      planProgress.textContent = `导入倒计时 ${remainSec}s · ${progressText}`;
    } else {
      planProgress.textContent = progressText;
    }
    for (const button of planDelayButtons) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.planDelay) === curPlan.delaySeconds));
    }

    // ===== v1.9.0 徽标 + 倒计时行 =====
    if (planBadge) planBadge.textContent = `${doneCount}/${total}`;
    const planBadge2 = host.querySelector(SELECTORS.ui.planBadge2);
    if (planBadge2) planBadge2.textContent = `${doneCount}/${total}`;
    const onboardEl = host.querySelector(SELECTORS.ui.onboard);
    if (onboardEl) {
      const configured = Boolean(runtime.settings.llmModel && runtime.settings.projectRoot && (runtime.deliveryState?.credentialStatus?.primary || runtime.settings.llmProvider === "ollama"));
      onboardEl.hidden = configured;
    }
    if (stewardBadge) {
      const on = runtime.settings.steward;
      stewardBadge.textContent = on ? (runtime.settings.stewardAuto ? "自动" : "开") : "关";
      stewardBadge.style.color = on ? "#6fc99a" : "#6b7a8a";
    }
    if (r429Badge) {
      r429Badge.textContent = runtime.settings.enabled ? "开" : "关";
      r429Badge.style.color = runtime.settings.enabled ? "#6fc99a" : "#6b7a8a";
    }
    if (llmBadge) {
      const ok = Boolean(runtime.settings.llmModel && (runtime.deliveryState?.credentialStatus?.primary || runtime.settings.llmProvider === "ollama"));
      llmBadge.textContent = ok ? "已配置" : "未配置";
      llmBadge.style.color = ok ? "#6fc99a" : "#a66";
    }
    // 倒计时总开关
    if (planCountdownEnabledInput) planCountdownEnabledInput.checked = curPlan.countdownEnabled !== false;
    if (planCountdownSwitchUI) {
      const on = curPlan.countdownEnabled !== false;
      planCountdownSwitchUI.dataset.on = String(on);
      planCountdownSwitchUI.textContent = on ? "开" : "关";
    }
    // 关闭倒计时时：计划有未完成段就显示「已就绪 / 立即导入」
    if (planManualRow) {
      const pending = total > 0 && curPlan.index < total;
      planManualRow.hidden = !(curPlan.countdownEnabled === false && pending);
    }
    if (planCountdownRow && planCountdownEl) {
      const leftMs = runtime.planDueAtMs - now;
      if (runtime.planDueAtMs > 0 && leftMs > 0) {
        planCountdownRow.hidden = false;
        planCountdownEl.textContent = Math.ceil(leftMs / 1000) + "s 后导入第 " + (curPlan.index + 1) + " 段";
      } else if (runtime.planDueAtMs > 0) {
        planCountdownRow.hidden = false;
        planCountdownEl.textContent = "等待任务完成后导入";
      } else {
        planCountdownRow.hidden = true;
      }
    }
    host.dataset.planCountdown = String(runtime.planDueAtMs > 0 && now < runtime.planDueAtMs);
    host.dataset.planEnabled = String(curPlan.enabled);
    host.dataset.planDone = String(curPlan.index >= total && total > 0);
    for (const button of delayButtons) {
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.delay) === runtime.settings.delaySeconds),
      );
    }
    for (const button of maxConsecButtons) {
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.maxConsecutive) === runtime.settings.maxConsecutive),
      );
    }

    if (!runtime.settings.enabled) {
      statusNode.textContent = "429 自动恢复已关闭";
      labelNode.textContent = branding.pillLabel;
      actionNode.textContent = "管家待命";
      return;
    }

    if (runtime.phase === "handled") {
      if (runtime.capWindowCount >= runtime.settings.maxConsecutive && runtime.eventKey && isCapWindowExceeded(Date.now())) {
        statusNode.textContent = `20 分钟内 429 已达上限（${runtime.settings.maxConsecutive} 次），停止自动恢复`;
        labelNode.textContent = "已停止";
        actionNode.textContent = runtime.lastAction || "连续 429 超限";
      } else {
        statusNode.textContent = "已点击重试";
        labelNode.textContent = "429 已处理";
        actionNode.textContent = runtime.lastAction || "任务已恢复";
      }
      return;
    }

    if (runtime.phase === "clicking") {
      statusNode.textContent = "时间已到，正在触发任务继续";
      labelNode.textContent = "继续中";
      actionNode.textContent = runtime.lastAction || "正在检查任务是否恢复";
      return;
    }

    if (runtime.phase === "waiting-429" || runtime.phase === "waiting-retry") {
      const remaining = runtime.dueAtMs - now;
      if (now < runtime.dueAtMs) {
        statusNode.textContent = `检测到 429，${formatCountdown(remaining / 1000)}`;
        labelNode.textContent = `${Math.max(0, Math.ceil(remaining / 1000))}s`;
        actionNode.textContent = "等待点击条件";
      } else if (runtime.phase === "waiting-retry" && runtime.clickCooldownUntilMs > now) {
        statusNode.textContent = `继续点击未生效，${formatCountdown((runtime.clickCooldownUntilMs - now) / 1000)}`;
        labelNode.textContent = "重试中";
        actionNode.textContent = runtime.lastAction || "等待下一轮点击";
      } else if (runtime.phase === "waiting-retry") {
        statusNode.textContent = "时间已到，准备继续任务";
        labelNode.textContent = "即将继续";
        actionNode.textContent = "等待恢复按钮";
      } else {
        statusNode.textContent = "时间已到，等待重试按钮出现";
        labelNode.textContent = "等待中";
        actionNode.textContent = "不会点击恢复后的任务";
      }
      return;
    }

    statusNode.textContent = "等待 429";
    labelNode.textContent = branding.pillLabel;
    actionNode.textContent = "管家待命";
    updateSwitchUI();
  }

  function scan() {
    if (!runtime.alive) return;
    const now = Date.now();

    // v1.9.16：每次扫描刷新会话 key（首条消息变化即视为新会话）
    const sessionIdentity = currentSessionIdentity();
    runtime.sessionId = sessionIdentity.sessionId;
    runtime.sessionKey = sessionIdentity.memoryKey;
    runtime.sessionTitle = sessionIdentity.sessionTitle;

    // v1.9.3：外部（另一实例/脚本/守护进程）改过配置或计划板时，重新载入，避免旧内存覆盖
    try {
      const sRaw = localStorage.getItem(SETTINGS_KEY) || "";
      if (runtime._settingsRaw && sRaw !== runtime._settingsRaw) {
        runtime.settings = normalizeSettings({ ...JSON.parse(sRaw || "{}") });
        enabledInput.checked = runtime.settings.enabled;
        backgroundInput.checked = runtime.settings.background;
        stewardInput.checked = runtime.settings.steward;
      }
      runtime._settingsRaw = sRaw;
      const pRaw = localStorage.getItem(PLAN_KEY) || "";
      if (runtime._planRaw && pRaw !== runtime._planRaw) {
        runtime.planThreads = readPlanThreads();
        runtime._planThreadsLoaded = true;
      }
      runtime._planRaw = pRaw;
    } catch (_) {}

    if (!runtime.settings.enabled) {
      // 429 守护关闭时仍渲染面板 + 跑管家模式（steward 独立于 429 enabled）
      if (runtime.settings.steward) {
        const sig = currentSignals();
        if (typeof consumeStewardOutput === "function") {
          try { consumeStewardOutput(); } catch (_) {}
        }
        if (sig.taskStatus === "completed" && typeof triggerStewardReview === "function") {
          void triggerStewardReview();
        }
      }
      render();
      return;
    }

    const activeThreadId = currentThreadId();
    const planThreadId = preferredPlanThreadId(activeThreadId, runtime.sessionKey, runtime.planThreads);
    if (runtime.taskThreadId !== activeThreadId) {
      runtime.taskThreadId = activeThreadId;
      resetTaskStatus();
    }
    if (
      runtime.eventKey &&
      activeThreadId &&
      runtime.threadId &&
      runtime.threadId !== activeThreadId
    ) {
      resetRuntime();
    }

    const signals = currentSignals(activeThreadId);
    // v1.9.16：观察到停止按钮 = 任务真的启动，解除「等待启动」状态
    if (signals.hasStopButton) runtime.planAwaitTaskStart = false;
    const nextTaskState = nextTaskStatusState({
      currentStatus: runtime.taskStatus,
      candidateStatus: signals.taskStatus,
      pendingStatus: runtime.pendingTaskStatus,
      pendingSinceMs: runtime.pendingTaskStatusSinceMs,
      nowMs: now,
    });
    runtime.taskStatus = nextTaskState.status;
    runtime.pendingTaskStatus = nextTaskState.pendingStatus;
    runtime.pendingTaskStatusSinceMs = nextTaskState.pendingSinceMs;

    if (signals.is429 && signals.eventKey) {
      activateSignals(signals, now);
    }

    const activeEventMatches = Boolean(
      runtime.eventKey &&
        runtime.threadId === activeThreadId &&
        signals.eventKey === runtime.eventKey,
    );
    if (
      !runtime.clickInFlight &&
      shouldEnterWaitingRetry({
        activeEventMatches,
        hasRetryButton: Boolean(signals.retryButton),
        phase: runtime.phase,
        eventKey: runtime.eventKey,
        handledEventKey: runtime.handledEventKey,
      })
    ) {
      runtime.phase = "waiting-retry";
    }

    // 时间窗内 429 次数达上限时不再点击；清除该事件，窗口过期后自动恢复
    const capExceeded = isCapWindowExceeded(now);
    if (
      activeEventMatches &&
      !runtime.clickInFlight &&
      now >= runtime.clickCooldownUntilMs &&
      shouldClickRetry({
        enabled: runtime.settings.enabled,
        nowMs: now,
        dueAtMs: runtime.dueAtMs,
        state: signals,
        currentThreadId: activeThreadId,
        handledEventKey: runtime.handledEventKey,
        capWindowExceeded: isCapWindowExceeded(now),
      })
    ) {
      void performRecoveryClicks(runtime.eventKey);
    } else if (capExceeded && activeEventMatches) {
      // 时间窗超限：停止该事件倒计时，窗口过期后自动重新计数
      runtime.dueAtMs = 0;
      runtime.expiresAtMs = 0;
      runtime.phase = "handled";
      runtime.lastAction = `20 分钟内 429 已达 ${runtime.settings.maxConsecutive} 次上限，停止自动恢复`;
      // 上限停止时清除该会话的 pending429，不再后台切回
      if (activeThreadId) {
        const bg = runtime.background.get(activeThreadId);
        if (bg?.pending429) runtime.background.set(activeThreadId, { ...bg, pending429: false });
      }
      toast("429 时间窗超限，已停止自动恢复");
    } else if (
      !activeEventMatches &&
      runtime.eventKey &&
      runtime.expiresAtMs > 0 &&
      now > runtime.expiresAtMs
    ) {
      resetRuntime();
    }

    // 计划板：任务「已完成」时导入下一段计划文本
    triggerPlanImportIfDue(signals, planThreadId);

    // 管家模式：主任务 completed 且开关开时，唤起侧边聊天做审核；
    // 若上一轮已发出审核且侧边已回复，则解析其输出写回计划板
    if (runtime.settings.steward) {
      if (typeof consumeStewardOutput === "function") {
        try { consumeStewardOutput(); } catch (e) {
          console.warn("[guardian] consumeStewardOutput failed:", e);
        }
      }
      if (signals.taskStatus === "completed" && runtime.sessionArmed) {
        if (typeof triggerStewardReview === "function") {
          console.info("[guardian] scan: triggering steward review", { signalsTaskStatus: signals.taskStatus });
          try { void triggerStewardReview(); } catch (e) {
            console.warn("[guardian] triggerStewardReview failed:", e);
          }
        } else {
          console.warn("[guardian] triggerStewardReview not a function");
        }
      } else {
        console.info("[guardian] scan: taskStatus not completed, skipping steward", { signalsTaskStatus: signals.taskStatus });
      }
    } else {
      runtime.stewardPendingTurnId = null;
    }

    // 后台守护：对未打开会话预登记倒计时；到点则切回该会话，由下一轮 scan 完成点击
    if (typeof scheduleBackgroundThreads === "function") {
      scheduleBackgroundThreads(activeThreadId);
    }
    if (typeof triggerBackgroundSwitch === "function") {
      triggerBackgroundSwitch();
    }

    render();
  }

  function setPlan(next) {
    // 写入当前激活线程的计划态
    const tid = runtime.planActiveThreadId || "default";
    runtime.planThreads = upsertThreadPlan(runtime.planThreads, tid, normalizePlanSettings(next));
    writePlanThreads(runtime.planThreads);
    render();
  }

  let scanTimer = 0;
  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 180);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-disabled", "data-state"],
  });

  const ticker = window.setInterval(scan, 1000);

  pill.addEventListener("click", () => {
    setOpen(host.dataset.open !== "true");
  });
  pill.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(host.dataset.open !== "true");
    }
  });
  closeButton.addEventListener("click", () => setOpen(false));
  enabledInput.addEventListener("change", () => {
    setSettings({ ...runtime.settings, enabled: enabledInput.checked });
    scan();
  });

  // 解析文本框：支持 "1. 文本" / "[已完成] 文本" 前缀；序号与完成标记不进入导入文本
  function parsePlanLines(value) {
    return value
      .split("\n")
      .map((line) => line.replace(/^[\d]+\.\s*/, "").trim())
      .map((line) => {
        let done = false;
        let text = line;
        const m = line.match(/^\[已完成\]\s*(.*)$/);
        if (m) { done = true; text = m[1].trim(); }
        return text ? { text, done } : null;
      })
      .filter(Boolean);
  }

  // 计划板事件（全部作用于当前线程）
  planEnabledInput.addEventListener("change", () => {
    // v1.9.6：计划内容始终可见（有自己的折叠按钮），开关只控制是否自动导入
    if (planEnabledInput.checked) runtime.sessionArmed = true;
    setPlan({ ...currentPlan(), enabled: planEnabledInput.checked });
    scan();
  });
  planTextArea.addEventListener("change", () => {
    const entries = parsePlanLines(planTextArea.value);
    setPlan({ ...currentPlan(), entries, index: 0 });
    scan();
  });
  planAddButton.addEventListener("click", () => {
    const lines = planTextArea.value.split("\n").filter((l) => l.replace(/^[\d]+\.\s*/, "").trim());
    lines.push("");
    planTextArea.value = lines.join("\n");
    planTextArea.focus();
    const entries = parsePlanLines(lines.join("\n"));
    setPlan({ ...currentPlan(), entries });
  });
  planResetButton.addEventListener("click", () => {
    // 清空：优先走 hardClear（内存+存储双清，防旧内存复活条目）
    if (typeof api !== "undefined" && api && typeof api.hardClear === "function") {
      api.hardClear();
      if (planTextArea) planTextArea.value = "";
      toast("计划板：已彻底清空");
      return;
    }
    // 清空：同时清 default + 本会话两个桶的全部条目（防 default 桶残留）
    const tid = runtime.planActiveThreadId;
    const defaultPlan = planForThread(runtime.planThreads, "default");
    const activePlan = tid ? planForThread(runtime.planThreads, tid) : null;
    // default 桶：清空
    runtime.planThreads = upsertThreadPlan(runtime.planThreads, "default", {
      ...defaultPlan, entries: [], index: 0,
    });
    // 本会话桶：清空
    if (activePlan && tid) {
      runtime.planThreads = upsertThreadPlan(runtime.planThreads, tid, {
        ...activePlan, entries: [], index: 0,
      });
    }
    writePlanThreads(runtime.planThreads);
    // 同步 textarea 显示（render 会在下一轮做，这里先强制清视觉）
    if (planTextArea && planTextArea !== document.activeElement) planTextArea.value = "";
    toast("计划板：已清空（default + 本会话）");
    render();
  });
  // 排序：上移/下移一条（序号是位置序号，自动重排）
  planUpButton.addEventListener("click", () => {
    const plan = currentPlan();
    const idx = plan.index;
    if (idx <= 0 || idx >= plan.entries.length) return;
    const entries = [...plan.entries];
    [entries[idx - 1], entries[idx]] = [entries[idx], entries[idx - 1]];
    const moved = { ...plan, index: idx - 1 };
    moved.entries = entries;
    setPlan(moved);
  });
  planDownButton.addEventListener("click", () => {
    const plan = currentPlan();
    const idx = plan.index;
    if (idx < 0 || idx + 1 >= plan.entries.length) return;
    const entries = [...plan.entries];
    [entries[idx], entries[idx + 1]] = [entries[idx + 1], entries[idx]];
    const moved = { ...plan, index: idx + 1 };
    moved.entries = entries;
    setPlan(moved);
  });
  for (const button of planDelayButtons) {
    button.addEventListener("click", () => {
      setPlan({ ...currentPlan(), delaySeconds: Number(button.dataset.planDelay), delayUserChosen: true });
      // 切换等待时间：若本轮已排定倒计时则重排
      if (runtime.planDueAtMs > 0) {
        runtime.planDueAtMs = Date.now() + Number(button.dataset.planDelay) * 1000;
      }
      render();
    });
  }
  for (const button of delayButtons) {
    button.addEventListener("click", () => {
      setSettings({
        ...runtime.settings,
        delaySeconds: Number(button.dataset.delay),
      });
      scan();
    });
  }
  for (const button of maxConsecButtons) {
    button.addEventListener("click", () => {
      setSettings({
        ...runtime.settings,
        maxConsecutive: Number(button.dataset.maxConsecutive),
      });
      scan();
    });
  }
  backgroundInput.addEventListener("change", () => {
    setSettings({ ...runtime.settings, background: backgroundInput.checked });
    scan();
  });
  stewardInput.addEventListener("change", () => {
    if (stewardInput.checked) runtime.sessionArmed = true;
    setSettings({ ...runtime.settings, steward: stewardInput.checked });
    if (stewardInput.checked) {
      ensureStewardSessionBootstrap();
    }
    if (stewardInput.checked && !runtime.settings.llmModel) {
      toast("管家模式已开，请在面板填 LLM 供应商（API Key + 模型），任务完成时自动审核");
    }
    scan();
  });

  function renderStewardState() {
    const identity = currentSessionIdentity();
    const boundTitle = runtime.sessionTitle || identity.sessionTitle;
    const boundKey = runtime.sessionKey || identity.memoryKey || "未编号";
    if (planThreadNode) {
      planThreadNode.textContent = `会话 · ${boundTitle.slice(0, 18)}${boundTitle.length > 18 ? "…" : ""}`;
      planThreadNode.title = `当前计划绑定会话：${boundTitle}\n编号：${boundKey}`;
    }
    if (schatTitleNode) {
      schatTitleNode.textContent = `管家 · ${boundTitle}`;
      schatTitleNode.title = `当前绑定会话：${boundTitle}\n会话编号：${boundKey}`;
    }
    if (host.dataset.schatOpen === "true") announceBoundSession();
    // 通道状态：LLM 配置是否就绪（v1.8.40 起不再依赖侧边聊天）
    const cfg = runtime.settings;
    if (stewardChannelNode) {
      if (cfg.llmModel) {
        stewardChannelNode.textContent = "LLM 已配置（守护进程直连供应商，无需浏览器跨域）";
        stewardChannelNode.style.color = "#4a9";
      } else {
        stewardChannelNode.textContent = "未配置 LLM（填 API Key + 模型）";
        stewardChannelNode.style.color = "#a66";
      }
    }

    // 待解析状态
    if (stewardPendingNode) {
      if (runtime.stewardPendingTurnId) {
        const elapsed = runtime.stewardPendingSentAtMs ? Math.floor((Date.now() - runtime.stewardPendingSentAtMs) / 1000) : 0;
        const remain = Math.max(0, Math.ceil(((runtime.stewardTimeoutMs || runtime.settings.stewardTimeoutMs || 300000) - elapsed * 1000) / 1000));
        stewardPendingNode.textContent = `审核中 · ${Math.floor(remain / 60)}m${String(remain % 60).padStart(2, "0")}s · 重试${runtime.stewardParseRetries}`;
        stewardPendingNode.style.color = "#da8";
      } else if (runtime.stewardReviewInFlight) {
        stewardPendingNode.textContent = "正在发送审核指令…";
        stewardPendingNode.style.color = "#da8";
      } else {
        stewardPendingNode.textContent = "";
      }
    }

    // 子设置显示/隐藏
    if (stewardBody) stewardBody.hidden = !runtime.settings.steward;
    // 同步「自动审核」按钮外观
    const autoBtn = host.querySelector(SELECTORS.ui.schatAutoBtn);
    if (autoBtn) {
      const on = runtime.settings.stewardAuto === true;
      autoBtn.classList.toggle("active", on);
      autoBtn.setAttribute("aria-pressed", String(on));
      autoBtn.style.background = on ? "linear-gradient(180deg,#2a5a3a 0%,#1e4230 100%)" : "linear-gradient(180deg,#1c2836 0%,#141d27 100%)";
      autoBtn.style.color = on ? "#6fc" : "#aeb9c5";
      autoBtn.textContent = on ? "⏱ 自动审核 · 开" : "⏱ 自动审核";
    }

    // 侧边管家窗口状态行
    if (schatStatus) {
      if (runtime.stewardReviewInFlight) {
        schatStatus.textContent = "发送中…";
        schatStatus.style.color = "#da8";
      } else if (runtime.stewardPendingTurnId) {
        const el = Math.floor((Date.now() - (runtime.stewardPendingSentAtMs || 0)) / 1000);
        schatStatus.textContent = `等待回复 · ${el}s / 重试${runtime.stewardParseRetries}`;
        schatStatus.style.color = "#da8";
      } else if (runtime.settings.llmModel) {
        schatStatus.textContent = "LLM 已配置 · 守护进程执行";
        schatStatus.style.color = "#4a9";
      } else {
        schatStatus.textContent = "未配置 LLM";
        schatStatus.style.color = "#a66";
      }
    }

    // 同步子设置 UI 状态
    stewardModeButtons.forEach((btn) => {
      const on = btn.dataset.mode === runtime.settings.stewardMode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    stewardTimeoutButtons.forEach((btn) => {
      const on = String(btn.dataset.ms) === String(runtime.settings.stewardTimeoutMs);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    if (stewardWritePlanInput) stewardWritePlanInput.checked = runtime.settings.stewardWritePlan;
    if (stewardAutoImportInput) stewardAutoImportInput.checked = runtime.settings.stewardAutoImport;
    // LLM 配置同步
    if (llmBaseUrlInput && document.activeElement !== llmBaseUrlInput) llmBaseUrlInput.value = runtime.settings.llmBaseUrl || "";
    if (llmModelInput && document.activeElement !== llmModelInput) llmModelInput.value = runtime.settings.llmModel || "";
    if (llmKeyInput && document.activeElement !== llmKeyInput) llmKeyInput.value = "";
    if (llmFallbackProviderInput) llmFallbackProviderInput.value = runtime.settings.llmFallbackProvider || "";
    if (llmFallbackBaseUrlInput && document.activeElement !== llmFallbackBaseUrlInput) llmFallbackBaseUrlInput.value = runtime.settings.llmFallbackBaseUrl || "";
    if (llmFallbackModelInput && document.activeElement !== llmFallbackModelInput) llmFallbackModelInput.value = runtime.settings.llmFallbackModel || "";
    if (llmFallbackEnabledInput) llmFallbackEnabledInput.checked = runtime.settings.llmFallbackEnabled === true;
    if (llmKeychainStatus) {
      const configured = runtime.deliveryState?.credentialStatus?.primary === true || runtime.deliveryState?.provider?.ok === true;
      llmKeychainStatus.textContent = configured ? "Keychain 已配置" : "Keychain 未验证";
      llmKeychainStatus.style.color = configured ? "#6fc99a" : "#8b98a8";
    }
    if (llmProxyInput && document.activeElement !== llmProxyInput) llmProxyInput.value = runtime.settings.llmProxyPort || "";
    if (projectRootInput && document.activeElement !== projectRootInput) projectRootInput.value = runtime.settings.projectRoot || "";
    llmProviderButtons.forEach((btn) => {
      const on = btn.dataset.provider === runtime.settings.llmProvider;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  // 管家模式子设置：审核侧重
  stewardModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setSettings({ ...runtime.settings, stewardMode: btn.dataset.mode });
      render();
    });
  });

  // 管家模式子设置：超时
  stewardTimeoutButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setSettings({ ...runtime.settings, stewardTimeoutMs: Number(btn.dataset.ms) });
      runtime.stewardTimeoutMs = Number(btn.dataset.ms); // 同步 runtime
      render();
    });
  });

  // 管家模式子设置：写回计划板 / 自动导入
  stewardWritePlanInput.addEventListener("change", () => {
    setSettings({ ...runtime.settings, stewardWritePlan: stewardWritePlanInput.checked });
  });
  stewardAutoImportInput.addEventListener("change", () => {
    setSettings({ ...runtime.settings, stewardAutoImport: stewardAutoImportInput.checked });
  });
  // LLM 供应商配置（v1.8.38）
  llmProviderButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setSettings({ ...runtime.settings, llmProvider: btn.dataset.provider });
      render();
    });
  });
  // LLM 输入框：用 input（每敲即存）+ change（失焦兜底），避免漏提交导致"没存上"
  const saveLlmField = () => setSettings({ ...runtime.settings,
    llmBaseUrl: llmBaseUrlInput.value.trim(),
    llmModel: llmModelInput.value.trim(),
    llmFallbackProvider: llmFallbackProviderInput.value,
    llmFallbackBaseUrl: llmFallbackBaseUrlInput.value.trim(),
    llmFallbackModel: llmFallbackModelInput.value.trim(),
    llmFallbackEnabled: llmFallbackEnabledInput.checked,
  });
  for (const el of [llmBaseUrlInput, llmModelInput, llmFallbackProviderInput, llmFallbackBaseUrlInput, llmFallbackModelInput, llmFallbackEnabledInput]) {
    el.addEventListener("input", saveLlmField);
    el.addEventListener("change", saveLlmField);
  }
  llmKeySaveButton.addEventListener("click", () => {
    try {
      const request = buildCredentialRequest({ op: "set", ref: "primary", secret: llmKeyInput.value });
      localStorage.setItem(CREDENTIAL_REQUEST_KEY, JSON.stringify(request));
      llmKeyInput.value = "";
      llmKeychainStatus.textContent = "等待写入 Keychain";
      toast("API Key 已提交到 Keychain 保存队列");
    } catch (error) {
      toast(String(error.message || error));
    }
  });
  const saveLlmProxy = () => {
    let v = Number(llmProxyInput.value) || 0;
    if (v && ![8000, 8791, 8792, 9000, 9090].includes(v)) v = 8792;
    setSettings({ ...runtime.settings, llmProxyPort: v });
  };
  llmProxyInput.addEventListener("input", saveLlmProxy);
  llmProxyInput.addEventListener("change", saveLlmProxy);
  const saveProjectRoot = () => {
    setSettings({ ...runtime.settings, projectRoot: projectRootInput.value.trim() });
  };
  projectRootInput.addEventListener("input", saveProjectRoot);
  projectRootInput.addEventListener("change", () => {
    saveProjectRoot();
    if (runtime.settings.steward) ensureStewardSessionBootstrap();
  });
  deliveryPreviewButton.addEventListener("click", () => {
    localStorage.setItem(DELIVERY_REQUEST_KEY, JSON.stringify(buildDeliveryRequest({ op: "preview" })));
    deliveryPreviewButton.disabled = true;
    toast("正在生成交付预览…");
  });
  deliveryContinueButton.addEventListener("click", () => {
    runtime.deliveryConfirmStage = 1;
    deliveryContinueButton.hidden = true;
    deliveryExecuteButton.hidden = false;
    deliverySummary.textContent += "\n\n二次确认：点击红色按钮后将先生成并校验备份，再仅清理列出的运行缓存。";
  });
  deliveryExecuteButton.addEventListener("click", () => {
    const preview = runtime.deliveryState?.preview;
    if (!preview) return;
    try {
      const request = buildDeliveryRequest({ op: "execute", executeToken: preview.executeToken, confirmed: true });
      localStorage.setItem(DELIVERY_REQUEST_KEY, JSON.stringify(request));
      deliveryExecuteButton.disabled = true;
      deliveryExecuteButton.textContent = "正在交付…";
    } catch (error) { toast(String(error.message || error)); }
  });
  deliveryCancelButton.addEventListener("click", () => {
    runtime.deliveryModalToken = runtime.deliveryState?.preview?.executeToken || "";
    deliveryModal.hidden = true;
    localStorage.setItem(DELIVERY_REQUEST_KEY, JSON.stringify(buildDeliveryRequest({ op: "cancel" })));
  });

  function cleanup() {
    if (!runtime.alive) return;
    runtime.alive = false;
    observer.disconnect();
    window.clearTimeout(scanTimer);
    window.clearInterval(ticker);
    window.removeEventListener("resize", handlePanelResize);
    host.remove();
    document.getElementById(STYLE_ID)?.remove();
    try {
      if (window[STATE_KEY] === api) delete window[STATE_KEY];
    } catch (_) {}
  }

  const api = {
    version: VERSION,
    SELECTORS,
    alive: true,
    cleanup,
    scan,
    reset: () => {
      resetRuntime();
      resetTaskStatus();
      render();
    },
    getState: () => ({ ...runtime }),
    getSignals: () => currentSignals(),
    getSessionSnapshot: () => currentSessionSnapshot(),
    // 只读诊断：steward 闭环状态（供 CDP 探针/测试用）
    getStewardState: () => ({
      enabled: runtime.settings.steward,
      mode: runtime.settings.stewardMode,
      writePlan: runtime.settings.stewardWritePlan,
      autoImport: runtime.settings.stewardAutoImport,
      pendingTurnId: runtime.stewardPendingTurnId,
      parseRetries: runtime.stewardParseRetries,
      pendingSentAtMs: runtime.stewardPendingSentAtMs,
      reviewInFlight: runtime.stewardReviewInFlight,
      lastTurnId: runtime.stewardLastTurnId,
      timeoutMs: runtime.stewardTimeoutMs || runtime.settings.stewardTimeoutMs || 300000,
    }),
    getDeliveryState: () => normalizeDeliveryState(runtime.deliveryState),
    setDeliveryState: (next) => {
      runtime.deliveryState = normalizeDeliveryState(next);
      try { localStorage.setItem(DELIVERY_STATE_KEY, JSON.stringify(runtime.deliveryState)); } catch {}
      render();
      return runtime.deliveryState;
    },
    openDeliveryPreview: () => {
      runtime.deliveryModalToken = "";
      renderDeliveryState();
    },
    setPlan,
    importNextPlan,
    setOpen,
    getPanelPosition: () => ({ ...runtime.panelPosition }),
    resetPanelPosition,
    // 硬清空：同时清内存副本与 localStorage，防止旧内存把已删条目写回
    hardClear: () => {
      // v1.9.16：清空计划只清内容，绝不重新打开计划模式（之前写成 enabled:true 导致自动启动）
      runtime.planThreads = { default: { enabled: false, entries: [], index: 0, delaySeconds: 30, countdownEnabled: true } };
      runtime._planThreadsLoaded = true;
      runtime.planDueAtMs = 0;
      runtime.planScheduledForTurnId = null;
      try { localStorage.setItem(PLAN_KEY, JSON.stringify(runtime.planThreads)); } catch (_) {}
      render();
      return { buckets: Object.keys(runtime.planThreads), entries: runtime.planThreads.default.entries.length };
    },
    // 供原生守护进程调用：由页面自己写计划板（避免 daemon 直写 localStorage 与内存副本冲突），
    // 并立刻排导入倒计时。daemon 只传解析后的文本。
    // v1.9.17：接受 daemon 传来的 threadId（会话指纹），确保写入的是同一个桶，杜绝串台
    applyStewardPlan: ({ fixes, nextPlan, label, threadId, sessionId, sessionKey, sessionTitle, summary } = {}, delaySeconds) => {
      const tid = threadId || runtime.planActiveThreadId || "default";
      // v1.9.17：把活跃线程对齐到本次写入的会话，否则 writePlanThreads 会把这个桶剪掉
      runtime.planActiveThreadId = tid;
      if (sessionId) runtime.sessionId = sessionId;
      if (sessionKey) runtime.sessionKey = sessionKey;
      if (sessionTitle) runtime.sessionTitle = sessionTitle;
      runtime.planThreads = readPlanThreads();
      runtime._planThreadsLoaded = true;
      const plan = planForThread(runtime.planThreads, tid);
      const next = appendStewardPlan(plan, { fixes, nextPlan }, label || "下一步");
      const newFirst = (next.entries || []).findIndex((e) => !e.done && e.source === "steward");
      if (newFirst >= 0) next.index = newFirst;
      runtime.planThreads = upsertThreadPlan(runtime.planThreads, tid, next);
      writePlanThreads(runtime.planThreads);
      runtime.planDueAtMs = Date.now() + (Number(delaySeconds) || 10) * 1000;
      runtime.planScheduledForTurnId = tid === "default" ? null : tid;
      const boundTitle = sessionTitle || runtime.sessionTitle || currentSessionTitle();
      const boundKey = sessionKey || runtime.sessionKey || "未编号";
      if (typeof schatAddMsg === "function") {
        const body = String(summary || nextPlan || "").trim().slice(0, 2000);
        schatAddMsg("recv", `我已按「${boundTitle}」这个会话核对了最新结果（编号 ${boundKey}）。下一步我建议先这样推进：\n${body || "计划已经写回计划板。"}`);
      }
      render();
      return { tid, index: runtime.planThreads[tid]?.index, entries: runtime.planThreads[tid]?.entries?.length, dueAtMs: runtime.planDueAtMs };
    },
    // 供原生守护进程（scripts/steward-daemon.mjs）调用：写回计划板后立刻排导入倒计时
    armPlanImport: (threadId, index, delaySeconds) => {
      const tid = threadId || "default";
      runtime.planThreads = readPlanThreads();          // 重新读盘（daemon 已写入）
      runtime._planThreadsLoaded = true;
      runtime.planActiveThreadId = tid;
      const p = planForThread(runtime.planThreads, tid);
      if (typeof index === "number" && index >= 0 && index < p.entries.length) {
        runtime.planThreads = upsertThreadPlan(runtime.planThreads, tid, { ...p, index });
      }
      runtime.planDueAtMs = Date.now() + (Number(delaySeconds) || 10) * 1000;
      runtime.planScheduledForTurnId = tid === "default" ? null : tid;
      render();
      return { tid, index: runtime.planThreads[tid]?.index, dueAtMs: runtime.planDueAtMs };
    },
  };
  window[STATE_KEY] = api;

  try {
    window.codexPlus?.registerCleanup?.(cleanup);
  } catch (_) {}

  // v1.9.14：Codex 每次启动（页面加载）后，计划模式与管家模式一律回到「关」，
  // 由用户手动打开，避免上次会话的自动化在无人值守时意外继续跑。
  try {
    if (runtime.settings.steward) {
      runtime.settings = { ...runtime.settings, steward: false, stewardAuto: false };
      writeSettings(runtime.settings);
    }
    const tid0 = currentThreadId() || "default";
    runtime.planThreads = readPlanThreads();
    runtime._planThreadsLoaded = true;
    for (const k of Object.keys(runtime.planThreads)) {
      runtime.planThreads[k] = { ...normalizePlanSettings(runtime.planThreads[k]), enabled: false };
    }
    writePlanThreads(runtime.planThreads);
    runtime.planActiveThreadId = tid0;
  } catch (_) {}

  // 首屏绑定当前线程 + 懒载入按线程计划容器
  runtime.planActiveThreadId = currentThreadId() || "default";
  currentPlan(); // 触发 readPlanThreads + prune
  writePlanThreads(runtime.planThreads);
  render();
  scheduleScan();
})();
