const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../guardian.js");

test("default settings: enabled, 1min delay, 5 max consecutive, background on, steward off", () => {
  assert.deepEqual(core.normalizeSettings(null), {
    enabled: true,
    delaySeconds: 60,
    maxConsecutive: 5,
    background: true,
    steward: false,
    stewardAuto: false,
    stewardMode: "review",
    stewardTimeoutMs: 300000,
    stewardWritePlan: true,
    stewardAutoImport: true,
    llmProvider: "openai",
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    llmProfiles: [],
    llmFallbackProvider: "",
    llmFallbackBaseUrl: "",
    llmFallbackModel: "",
    llmFallbackEnabled: false,
    llmProxyPort: 8443,
    projectRoot: "",
  });
  // stewardMode=off 且 steward=true 时，steward 仍为 true（mode 只影响审核侧重）
  assert.equal(core.normalizeSettings({ steward: true, stewardMode: "off" }).steward, true);
  // stewardMode=review-next 不影响默认关闭
  assert.equal(core.normalizeSettings({ stewardMode: "review-next" }).steward, false);
  // 新类型也在白名单里
  assert.equal(core.normalizeSettings({ stewardMode: "review-optimize" }).stewardMode, "review-optimize");
  assert.equal(core.normalizeSettings({ stewardMode: "review-develop" }).stewardMode, "review-develop");
  assert.equal(core.normalizeSettings({ stewardMode: "bogus" }).stewardMode, "review");
  // 旧断言保留
  assert.equal(core.normalizeSettings({ steward: true }).steward, true);
  assert.equal(core.normalizeSettings({ steward: 1 }).steward, false);
  // stewardTimeoutMs 只接受 300000/600000/900000
  assert.equal(core.normalizeSettings({ stewardTimeoutMs: 600000 }).stewardTimeoutMs, 600000);
  assert.equal(core.normalizeSettings({ stewardTimeoutMs: 999 }).stewardTimeoutMs, 300000);
  // stewardWritePlan / stewardAutoImport 默认 true
  assert.equal(core.normalizeSettings({ stewardWritePlan: false }).stewardWritePlan, false);
  assert.equal(core.normalizeSettings({ stewardAutoImport: false }).stewardAutoImport, false);
  assert.equal(core.normalizeSettings({}).stewardWritePlan, true);
  assert.equal(core.normalizeSettings({}).stewardAutoImport, true);
});

test("normalizeSettings background only off when explicitly false", () => {
  assert.equal(core.normalizeSettings({}).background, true);
  assert.equal(core.normalizeSettings({ background: false }).background, false);
  assert.equal(core.normalizeSettings({ background: true }).background, true);
});

test("normalizeSettings only accepts 3/5/8 for maxConsecutive, else 5", () => {
  assert.equal(core.normalizeSettings({ maxConsecutive: 3 }).maxConsecutive, 3);
  assert.equal(core.normalizeSettings({ maxConsecutive: 8 }).maxConsecutive, 8);
  assert.equal(core.normalizeSettings({ maxConsecutive: 999 }).maxConsecutive, 5);
  assert.equal(core.normalizeSettings({ maxConsecutive: 2 }).maxConsecutive, 5);
});

test("shouldClickRetry blocks when cap window is exceeded", () => {
  const state = { eventKey: "t:turn-1", retryButton: { text: "重试" }, retryReady: true, threadId: "t" };
  // 时间窗未超限：可点
  assert.equal(
    core.shouldClickRetry({
      enabled: true, nowMs: 100, dueAtMs: 10, state,
      currentThreadId: "t", handledEventKey: "",
      capWindowExceeded: false,
    }),
    true,
  );
  // 时间窗已超限：停止点击
  assert.equal(
    core.shouldClickRetry({
      enabled: true, nowMs: 100, dueAtMs: 10, state,
      currentThreadId: "t", handledEventKey: "",
      capWindowExceeded: true,
    }),
    false,
  );
});

test("handled same event blocks retry until re-armed", () => {
  const state = { eventKey: "t:turn-1", retryButton: {}, threadId: "t" };
  // handled 同事件：shouldClickRetry 被 handledEventKey 挡住（单次 429 不重复点）
  assert.equal(
    core.shouldClickRetry({
      enabled: true, nowMs: 100, dueAtMs: 10, state,
      currentThreadId: "t", handledEventKey: "t:turn-1",
      capWindowExceeded: false,
    }),
    false,
  );
});

test("delay setting only accepts one or three minutes", () => {
  assert.equal(core.normalizeSettings({ delaySeconds: 1 }).delaySeconds, 60);
  assert.equal(core.normalizeSettings({ delaySeconds: 180 }).delaySeconds, 180);
  assert.equal(core.normalizeSettings({ delaySeconds: 999 }).delaySeconds, 60);
});

test("detects localized 429 reconnect text", () => {
  const state = core.detectPageSignals({
    turnText: "服务器繁忙，正在重新连接 2/5",
    buttons: [],
    hasStopButton: true,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });

  assert.equal(state.is429, true);
  assert.equal(state.retryButton, null);
  assert.equal(state.eventKey, "local:thread-1:turn-1");
});

test("detects the explicit retry countdown button after 429", () => {
  const state = core.detectPageSignals({
    turnText: "服务器繁忙，正在重新连接 5/5",
    buttons: [
      { text: "查看诊断", disabled: false },
      { text: "42 秒后重试", disabled: false },
    ],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });

  assert.equal(state.is429, true);
  assert.equal(state.retryButton.text, "42 秒后重试");
  assert.equal(state.retryReady, true);
});

test("detects an icon-only continue button by its accessible label", () => {
  const state = core.detectPageSignals({
    turnText: "",
    statusTexts: ["exceeded retry limit, last status: 429 Too Many Requests"],
    buttons: [
      { text: "", ariaLabel: "继续", disabled: false },
      { text: "", ariaLabel: "在项目中开始新聊天", disabled: false },
    ],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });

  assert.equal(state.retryButton.ariaLabel, "继续");
  assert.equal(state.retryReady, true);
});

test("keeps a recovery button ready after the 429 text disappears", () => {
  const state = core.detectPageSignals({
    turnText: "",
    statusTexts: [],
    buttons: [{ text: "", ariaLabel: "继续", disabled: false }],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });

  assert.equal(state.is429, false);
  assert.equal(state.retryButton.ariaLabel, "继续");
  assert.equal(state.retryReady, true);
});

test("detects the real composer send button as a recovery control", () => {
  const state = core.detectPageSignals({
    turnText: "",
    statusTexts: ["exceeded retry limit, last status: 429 Too Many Requests"],
    buttons: [
      { text: "继续", ariaLabel: null, disabled: false },
      { text: "", ariaLabel: "发送", disabled: false },
    ],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });

  assert.equal(state.retryButton.ariaLabel, "发送");
  assert.equal(state.retryReady, true);
});

test("does not click a handled turn or a different thread", () => {
  const state = {
    is429: true,
    retryReady: true,
    threadId: "local:thread-1",
    eventKey: "local:thread-1:turn-1",
    retryButton: { text: "重试" },
  };

  assert.equal(
    core.shouldClickRetry({
      enabled: true,
      nowMs: 1000,
      dueAtMs: 500,
      state,
      currentThreadId: "local:thread-1",
      handledEventKey: "",
    }),
    true,
  );
  assert.equal(
    core.shouldClickRetry({
      enabled: true,
      nowMs: 1000,
      dueAtMs: 500,
      state,
      currentThreadId: "local:thread-2",
      handledEventKey: "",
    }),
    false,
  );
  assert.equal(
    core.shouldClickRetry({
      enabled: true,
      nowMs: 1000,
      dueAtMs: 500,
      state,
      currentThreadId: "local:thread-1",
      handledEventKey: "local:thread-1:turn-1",
    }),
    false,
  );
});

test("clicks an active 429 event after the error text disappears", () => {
  const state = {
    is429: false,
    retryReady: true,
    threadId: "local:thread-1",
    eventKey: "local:thread-1:turn-1",
    retryButton: { text: "", ariaLabel: "继续" },
  };

  assert.equal(
    core.shouldClickRetry({
      enabled: true,
      nowMs: 2000,
      dueAtMs: 1500,
      state,
      currentThreadId: "local:thread-1",
      handledEventKey: "",
    }),
    true,
  );
});

test("does not restore waiting phase after the event was handled", () => {
  assert.equal(
    core.shouldEnterWaitingRetry({
      activeEventMatches: true,
      hasRetryButton: true,
      phase: "waiting-429",
      eventKey: "thread:turn",
      handledEventKey: "",
    }),
    true,
  );
  assert.equal(
    core.shouldEnterWaitingRetry({
      activeEventMatches: true,
      hasRetryButton: true,
      phase: "handled",
      eventKey: "thread:turn",
      handledEventKey: "thread:turn",
    }),
    false,
  );
});

test("confirms recovery only when the task actually starts or advances", () => {
  assert.equal(
    core.isRecoveryConfirmed({
      clickedEventKey: "thread:turn-1",
      currentEventKey: "thread:turn-1",
      hasStopButton: false,
      retryButtonVisible: true,
      is429: false,
    }),
    false,
  );
  assert.equal(
    core.isRecoveryConfirmed({
      clickedEventKey: "thread:turn-1",
      currentEventKey: "thread:turn-1",
      hasStopButton: true,
      retryButtonVisible: false,
      is429: false,
    }),
    true,
  );
  assert.equal(
    core.isRecoveryConfirmed({
      clickedEventKey: "thread:turn-1",
      currentEventKey: "thread:turn-2",
      hasStopButton: false,
      retryButtonVisible: false,
      is429: false,
    }),
    true,
  );
  assert.equal(
    core.isRecoveryConfirmed({
      clickedEventKey: "thread:turn-1",
      currentEventKey: "thread:turn-1",
      hasStopButton: false,
      retryButtonVisible: false,
      is429: false,
    }),
    true,
  );
});

test("formats countdown text", () => {
  assert.equal(core.formatCountdown(60), "60 秒后重试");
  assert.equal(core.formatCountdown(0), "即将重试");
});

test("finds the latest visible turn when the turn wrapper is virtualized", () => {
  const context = core.visibleTurnContext([
    {
      key: "turn-old:msg-old",
      visible: true,
      text: "exceeded retry limit, last status: 429 Too Many Requests",
    },
    {
      key: "turn-current:user",
      visible: true,
      text: "继续修复项目",
    },
    {
      key: "turn-current:msg-error",
      visible: true,
      text: "exceeded retry limit, last status: 429 Too Many Requests",
    },
    {
      key: "turn-current:hidden-placeholder",
      visible: false,
      text: "不应参与识别",
    },
  ]);

  assert.equal(context.turnId, "turn-current");
  assert.match(context.text, /exceeded retry limit/);
  assert.doesNotMatch(context.text, /turn-old/);
});

test("only uses explicit status nodes for 429 detection", () => {
  const assistantExplanation =
    "截图说明问题在守护脚本：页面上的 exceeded retry limit, last status: 429 Too Many Requests 没被识别。";

  const ignored = core.detectPageSignals({
    turnText: assistantExplanation,
    statusTexts: [],
    buttons: [],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });
  assert.equal(ignored.is429, false);

  const detected = core.detectPageSignals({
    turnText: assistantExplanation,
    statusTexts: ["exceeded retry limit, last status: 429 Too Many Requests"],
    buttons: [{ text: "重试", disabled: false }],
    hasStopButton: false,
    threadId: "local:thread-1",
    turnId: "turn-1",
  });
  assert.equal(detected.is429, true);
  assert.equal(detected.retryReady, true);
});

test("classifies task reminder lights by task outcome priority", () => {
  assert.equal(
    core.classifyTaskStatus({
      is429: true,
      hasUnexpectedStop: true,
      hasStopButton: true,
      hasAssistantOutput: true,
    }),
    "429",
  );
  assert.equal(
    core.classifyTaskStatus({
      is429: false,
      hasUnexpectedStop: true,
      hasStopButton: false,
      hasAssistantOutput: true,
    }),
    "unexpected",
  );
  assert.equal(
    core.classifyTaskStatus({
      is429: false,
      hasUnexpectedStop: false,
      hasStopButton: true,
      hasAssistantOutput: true,
    }),
    "running",
  );
  assert.equal(
    core.classifyTaskStatus({
      is429: false,
      hasUnexpectedStop: false,
      hasStopButton: false,
      hasAssistantOutput: true,
    }),
    "completed",
  );
  assert.equal(
    core.classifyTaskStatus({
      is429: false,
      hasUnexpectedStop: false,
      hasStopButton: false,
      hasAssistantOutput: false,
    }),
    "unknown",
  );
});

test("shows clear labels for task reminder lights", () => {
  assert.equal(core.taskStatusLabel("429"), "任务遇到 429");
  assert.equal(core.taskStatusLabel("unexpected"), "任务意外停止");
  assert.equal(core.taskStatusLabel("running"), "任务运行中");
  assert.equal(core.taskStatusLabel("completed"), "任务已完成");
  assert.equal(core.taskStatusLabel("unknown"), "等待任务");
});

test("recognizes non-429 unexpected stop status text", () => {
  assert.equal(core.isUnexpectedStopText("任务已意外停止"), true);
  assert.equal(core.isUnexpectedStopText("Task was interrupted"), true);
  assert.equal(core.isUnexpectedStopText("连接失败，请稍后重试"), true);
  assert.equal(core.isUnexpectedStopText("任务运行中"), false);
  assert.equal(core.isUnexpectedStopText("任务已完成"), false);
});

test("debounces completion and stop lights while showing 429 immediately", () => {
  const waiting = core.nextTaskStatusState({
    currentStatus: "running",
    candidateStatus: "completed",
    pendingStatus: null,
    pendingSinceMs: 0,
    nowMs: 1000,
    debounceMs: 700,
  });
  assert.equal(waiting.status, "running");
  assert.equal(waiting.pendingStatus, "completed");

  const settled = core.nextTaskStatusState({
    currentStatus: "running",
    candidateStatus: "completed",
    pendingStatus: "completed",
    pendingSinceMs: 1000,
    nowMs: 1700,
    debounceMs: 700,
  });
  assert.equal(settled.status, "completed");

  const urgent = core.nextTaskStatusState({
    currentStatus: "running",
    candidateStatus: "429",
    pendingStatus: null,
    pendingSinceMs: 0,
    nowMs: 1200,
    debounceMs: 700,
  });
  assert.equal(urgent.status, "429");
  assert.equal(urgent.pendingStatus, null);
});

// ===== 计划板（plan board）测试 =====

test("plan settings default to disabled with empty entries and 30s delay", () => {
  const p = core.normalizePlanSettings(null);
  assert.deepEqual(p, { enabled: false, entries: [], index: 0, delaySeconds: 30, countdownEnabled: true, delayUserChosen: false });
});

test("plan delay only accepts 10 or 30 seconds", () => {
  assert.equal(core.normalizePlanSettings({ delaySeconds: 30 }).delaySeconds, 30);
  assert.equal(core.normalizePlanSettings({ delaySeconds: 10 }).delaySeconds, 10);
  assert.equal(core.normalizePlanSettings({ delaySeconds: 999 }).delaySeconds, 30); // v1.9.3 默认 30
  assert.equal(core.normalizePlanSettings(null).delaySeconds, 30);
});

test("plan countdownEnabled: 默认开，显式 false 才关", () => {
  assert.equal(core.normalizePlanSettings(null).countdownEnabled, true);
  assert.equal(core.normalizePlanSettings({ countdownEnabled: false }).countdownEnabled, false);
  assert.equal(core.normalizePlanSettings({ countdownEnabled: "no" }).countdownEnabled, true);
});

test("plan entries are normalized to {text,done} and capped at 50", () => {
  const p = core.normalizePlanSettings({
    enabled: true,
    entries: ["  step one  ", "", "step two\nnext", ...Array(60).fill("x")],
  });
  // 字符串会被规范化成 { text, done:false }
  assert.equal(p.entries.length, 50);
  assert.deepEqual(p.entries[0], { text: "step one", done: false });
  assert.deepEqual(p.entries[1], { text: "step two\nnext", done: false });
  assert.equal(p.entries[49].text, "x");
  // 结构化条目保留 done 标记
  const st = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a", done: true }, { text: "b", done: false }, { text: "", done: false }],
  });
  assert.equal(st.entries.length, 2);
  assert.equal(st.entries[0].done, true);
  // 空白项被过滤
  const blanks = core.normalizePlanSettings({ enabled: true, entries: ["", "   ", "real"] });
  assert.equal(blanks.entries.length, 1);
  assert.equal(blanks.entries[0].text, "real");
});

test("plan index is clamped to non-negative integer", () => {
  assert.equal(core.normalizePlanSettings({ index: -3 }).index, 0);
  assert.equal(core.normalizePlanSettings({ index: 1.5 }).index, 0);
  assert.equal(core.normalizePlanSettings({ index: 2 }).index, 2);
});

test("shouldImportPlan gates on completed status, idle composer and remaining entries", () => {
  const plan = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a" }, { text: "b" }],
    index: 0,
  });
  // planDueAtMs=0 表示无待倒计时（立即可导）
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 10000, planDueAtMs: 0, resultComplete: true }),
    true,
  );
  // 任务未完成不导入
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "running", composerBusy: false, nowMs: 10000, planDueAtMs: 0 }),
    false,
  );
  // composer 忙不导入
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: true, nowMs: 10000, planDueAtMs: 0 }),
    false,
  );
  // 文本用尽不导入
  const exhausted = { ...plan, index: 2 };
  assert.equal(
    core.shouldImportPlan({ plan: exhausted, taskStatus: "completed", composerBusy: false, nowMs: 10000, planDueAtMs: 0 }),
    false,
  );
});

test("shouldImportPlan respects the import cooldown window", () => {
  const plan = core.normalizePlanSettings({ enabled: true, entries: [{ text: "a" }], index: 0 });
  // 窗口内（差 3999 < 4000 默认冷却）不导入
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 4999, lastImportAtMs: 1000 }),
    false,
  );
  // 窗口外（差 4000 >= 4000）可导入
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 5000, lastImportAtMs: 1000, resultComplete: true }),
    true,
  );
});

test("shouldImportPlan waits for the plan countdown due point", () => {
  const plan = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a" }],
    index: 0,
    delaySeconds: 10,
  });
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 5000, planDueAtMs: 10000 }),
    false,
  );
  assert.equal(
    core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 10000, planDueAtMs: 10000, resultComplete: true }),
    true,
  );
});

test("planImportText returns the current entry text (no sequence number)", () => {
  const plan = core.normalizePlanSettings({ enabled: true, entries: [{ text: "first" }, { text: "second" }], index: 0 });
  assert.equal(core.planImportText(plan), "first");
  assert.equal(core.planImportText({ ...plan, index: 1 }), "second");
  assert.equal(core.planImportText({ ...plan, index: 2 }), null);
  assert.equal(core.planImportText({ enabled: false, entries: [{ text: "x" }], index: 0 }), null);
});

test("nextPlanIndex advances and clamps at the end", () => {
  const plan = core.normalizePlanSettings({ enabled: true, entries: [{ text: "a" }, { text: "b" }, { text: "c" }], index: 0 });
  assert.equal(core.nextPlanIndex(plan), 1);
  assert.equal(core.nextPlanIndex({ ...plan, index: 2 }), 3);
  assert.equal(core.nextPlanIndex({ ...plan, index: 7 }), 3);
  assert.equal(core.nextPlanIndex(null), 0);
});

test("planCompletedCount tallies done entries", () => {
  const plan = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a", done: true }, { text: "b", done: false }, { text: "c", done: true }],
  });
  assert.equal(core.planCompletedCount(plan), 2);
  assert.equal(core.planCompletedCount({ enabled: true, entries: [] }), 0);
});

test("per-thread plan storage keeps each session independent", () => {
  const threads = {};
  const t1 = core.planForThread(threads, "thread-1");
  const saved = core.upsertThreadPlan(threads, "thread-1", {
    ...t1,
    enabled: true,
    entries: [{ text: "a" }, { text: "b" }],
    index: 1,
    delaySeconds: 30,
  });
  // thread-1 有内容；thread-2 仍是空默认
  const got1 = core.planForThread(saved, "thread-1");
  const got2 = core.planForThread(saved, "thread-2");
  assert.equal(got1.entries.length, 2);
  assert.equal(got1.index, 1);
  assert.equal(got1.delaySeconds, 30);
  assert.equal(got2.entries.length, 0);
  assert.equal(got2.enabled, false);
  // 空 threadId 归到 default 桶
  const gotDefault = core.planForThread(core.upsertThreadPlan({}, null, { enabled: true, entries: [{ text: "z" }], index: 0, delaySeconds: 10 }), null);
  assert.equal(gotDefault.entries.length, 1);
});

test("done mark prevents re-importing the same segment", () => {
  const plan = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a", done: true }, { text: "b" }],
    index: 1,
  });
  // index 指向未完成段 b：可导
  assert.equal(core.shouldImportPlan({ plan, taskStatus: "completed", composerBusy: false, nowMs: 100000, resultComplete: true }), true);
  // 全部 done：应推进到末尾，不可导
  const allDone = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "a", done: true }, { text: "b", done: true }],
    index: 2,
  });
  assert.equal(core.shouldImportPlan({ plan: allDone, taskStatus: "completed", composerBusy: false, nowMs: 100000 }), false);
});

test("buildStewardReviewPrompt embeds only provided material (no fabrication)", () => {
  const p = core.buildStewardReviewPrompt({
    mainOutput: "重构完成 auth 模块",
    projectStatus: "计划板 2/5 段",
    renderedMd: "README: 支持 JWT",
    planEntries: [{ text: "写测试", done: false }],
  });
  assert.match(p, /重构完成 auth 模块/);
  assert.match(p, /计划板 2\/5/);
  assert.match(p, /支持 JWT/);
  assert.match(p, /写测试/);
  assert.match(p, /## 修改步骤/);
  assert.match(p, /## 下一步计划/);
  assert.match(p, /推测或假设/);
  // 空材料也要给出安全占位，不会崩
  const p2 = core.buildStewardReviewPrompt({});
  assert.match(p2, /未读到主任务输出/);
});

test("parseStewardSideOutput extracts fixes + next plan, ignores 无", () => {
  const text = [
    "## 审核结论",
    "完成 auth 重构",
    "## 短板与风险",
    "无",
    "## 修改步骤",
    "补一条 JWT 单测",
    "## 下一步计划",
    "跑全量测试并修失败用例",
  ].join("\n");
  const r = core.parseStewardSideOutput(text);
  assert.equal(r.has, true);
  assert.match(r.fixes, /补一条 JWT 单测/);
  assert.match(r.nextPlan, /跑全量测试/);
});

test("parseStewardSideOutput returns has=false when sections absent or 无", () => {
  assert.equal(core.parseStewardSideOutput("无关文本").has, false);
  const none = "## 修改步骤\n无\n## 下一步计划\n无";
  assert.equal(core.parseStewardSideOutput(none).has, false);
});

test("appendStewardPlan dedups and caps entries, preserves index", () => {
  const plan = { enabled: true, entries: [{ text: "A", done: true }, { text: "B", done: false }], index: 1, delaySeconds: 10 };
  const next = core.appendStewardPlan(plan, { fixes: "改 A", nextPlan: "B" });
  assert.ok(next.entries.some((e) => e.text === "【修改】改 A"));
  assert.equal(next.entries.filter((e) => e.text === "B").length, 1); // 去重
  // 再调一次不重复追加
  const again = core.appendStewardPlan(next, { fixes: "改 A", nextPlan: "B" });
  assert.equal(again.entries.length, next.entries.length);
});

test("appendStewardPlan respects planLabel", () => {
  const plan = { enabled: true, entries: [], index: 0, delaySeconds: 10 };
  const next = core.appendStewardPlan(plan, { fixes: "修 X", nextPlan: "加 Y" }, "优化");
  assert.ok(next.entries.some((e) => e.text === "【优化】修 X"));
  assert.ok(next.entries.some((e) => e.text === "【优化】加 Y"));
});

test("splitIntoSegments splits long text into <= size segments, caps at maxSegs", () => {
  const short = "hello";
  assert.deepEqual(core.splitIntoSegments(short, 10, 6), ["hello"]);

  const long = "A".repeat(100);
  const segs = core.splitIntoSegments(long, 10, 6);
  assert.equal(segs.length, 6);
  // each seg <= 10 except possibly last (tail merged)
  for (let i = 0; i < 5; i++) assert.ok(segs[i].length <= 10, "seg " + i + " too long");
  // last seg has the tail marker
  assert.match(segs[5], /后续内容略/);

  // exactly at boundary
  const exact = "B".repeat(10);
  assert.deepEqual(core.splitIntoSegments(exact, 10, 6), ["BBBBBBBBBB"]);
});

test("buildStewardReviewPrompt long text triggers summary mode", () => {
  const longOutput = "X".repeat(7000); // > 6000 threshold
  const p = core.buildStewardReviewPrompt({ mainOutput: longOutput });
  // Should contain "摘要" mode instructions
  assert.match(p, /摘要/);
  assert.match(p, /分段/);
  assert.match(p, /第 1\//);
  assert.match(p, /## 修改步骤/);
  assert.match(p, /## 下一步计划/);
});

test("buildStewardReviewPrompt medium text uses segmented direct review", () => {
  const medium = "Y".repeat(4000); // > 1500 (segment size) but < 6000
  const p = core.buildStewardReviewPrompt({ mainOutput: medium });
  // Should contain multiple segments but NOT the "摘要" step-1 instruction
  assert.match(p, /第 1\//);
  assert.match(p, /第 2\//);
  assert.doesNotMatch(p, /请先做摘要提炼/);
});

test("buildStewardReviewPrompt short text single segment", () => {
  const p = core.buildStewardReviewPrompt({ mainOutput: "短输出" });
  assert.doesNotMatch(p, /第 1\/2/); // no multi-segment header
  assert.match(p, /短输出/);
});

// ===== v1.8.20 新增测试 =====

test("stewardParseDecision: timeout when elapsed exceeds timeoutMs", () => {
  assert.deepEqual(core.stewardParseDecision({ nowMs: 300001, sentAtMs: 0, timeoutMs: 300000 }), {
    giveUp: true,
    reason: "timeout",
  });
  assert.deepEqual(core.stewardParseDecision({ nowMs: 299999, sentAtMs: 0, timeoutMs: 300000 }), {
    giveUp: false,
    reason: "ok",
  });
  // sentAtMs null/undefined treated as 0
  assert.equal(core.stewardParseDecision({ nowMs: 400000, sentAtMs: null, timeoutMs: 300000 }).giveUp, true);
});

test("parseStewardSideOutput accepts single-# headers", () => {
  const r = core.parseStewardSideOutput("# 修改步骤\n修复 X\n# 下一步计划\n继续 Y");
  assert.equal(r.has, true);
  assert.match(r.fixes, /修复 X/);
  assert.match(r.nextPlan, /继续 Y/);
});

test("parseStewardSideOutput rejects 无/无需修改 bodies in # headers", () => {
  const r = core.parseStewardSideOutput("# 修改步骤\n无\n# 下一步计划\n无需修改");
  assert.equal(r.has, false);
});

test("parseStewardSideOutput returns has=false for unrelated text", () => {
  assert.equal(core.parseStewardSideOutput("我觉得应该改 X 然后继续 Y").has, false);
});

// ===== isLegacyV1 边界回归（v1.8.59）=====
// 背景：v1.8.56 修复过一个真 bug——v2 容器 {default:{entries:[...]}} 曾被误判为 v1，
// 导致每次读取都从 codex429Guardian.plan.v1 重新迁移，「继续」条目反复复活。

test("isLegacyV1: v1 单 plan 对象（带 threadId）判为 legacy", () => {
  assert.equal(core.isLegacyV1({ threadId: null, enabled: true, entries: ["a"] }), true);
});

test("isLegacyV1: v1 entries 是字符串数组时判为 legacy", () => {
  assert.equal(core.isLegacyV1({ enabled: true, entries: ["继续", "继续"], index: 2 }), true);
  assert.equal(core.isLegacyV1({ entries: [] , enabled: true }), true);
});

test("isLegacyV1: v2 容器（entries 是 {text,done} 对象）不判为 legacy", () => {
  const v2 = {
    default: {
      enabled: true,
      entries: [{ text: "【优化】跑测试", done: false }],
      index: 0,
      delaySeconds: 10,
    },
  };
  assert.equal(core.isLegacyV1(v2), false);
});

test("isLegacyV1: 带 delaySeconds 的空 v2 桶不判为 legacy", () => {
  assert.equal(core.isLegacyV1({ default: { enabled: true, entries: [], index: 0, delaySeconds: 10 } }), false);
});

test("isLegacyV1: 多线程 v2 容器不判为 legacy", () => {
  const v2 = {
    default: { enabled: true, entries: [{ text: "a", done: true }], index: 1, delaySeconds: 10 },
    "local:abc": { enabled: true, entries: [{ text: "b", done: false }], index: 0, delaySeconds: 30 },
  };
  assert.equal(core.isLegacyV1(v2), false);
});

test("isLegacyV1: 非对象/数组/null 一律不是 legacy", () => {
  assert.equal(core.isLegacyV1(null), false);
  assert.equal(core.isLegacyV1(undefined), false);
  assert.equal(core.isLegacyV1("string"), false);
  assert.equal(core.isLegacyV1(123), false);
  assert.equal(core.isLegacyV1([]), false);
  assert.equal(core.isLegacyV1({}), false);
});

// ===== UI 折叠状态（v1.9.1）=====
// 这些纯函数直接决定 DOM 的 hidden / aria-expanded / chevron 三个属性，
// 单测它们即可保证 UI 重构不破坏折叠行为。

test("collapse: 默认状态——计划板(含输入框)/管家展开，日志/LLM/429 折叠", () => {
  const d = core.COLLAPSE_DEFAULTS;
  assert.equal(d.plan, false);
  assert.equal(d.planinput, false, "计划输入框默认展开");
  assert.equal(d.steward, false);
  assert.equal(d.log, true);
  assert.equal(d.llm, true);
  assert.equal(d.r429, true);
  // 默认值应冻结，避免被运行时改写
  assert.equal(Object.isFrozen(d), true);
});

test("collapse: collapseUi 映射 hidden / aria-expanded / chevron", () => {
  assert.deepEqual(core.collapseUi(true), { hidden: true, ariaExpanded: "false", chevron: "\u25B8" });
  assert.deepEqual(core.collapseUi(false), { hidden: false, ariaExpanded: "true", chevron: "\u25BE" });
  // 非布尔真值不应被视为折叠
  assert.equal(core.collapseUi(1).hidden, false);
  assert.equal(core.collapseUi("true").hidden, false);
});

test("collapse: resolveCollapseState 合并已保存偏好，忽略非法值/未知键", () => {
  const merged = core.resolveCollapseState({ log: false, llm: "yes", r429: true, bogus: true });
  assert.equal(merged.log, false);      // 合法布尔被采纳
  assert.equal(merged.llm, true);       // 非法值回落默认（llm 默认 true）
  assert.equal(merged.r429, true);      // 合法布尔被采纳
  assert.equal("bogus" in merged, false); // 未知键不进入结果
  assert.equal(merged.plan, false);     // 未提供的键用默认
  assert.equal(merged.steward, false);
});

test("collapse: resolveCollapseState 对非对象输入回落全默认", () => {
  for (const bad of [null, undefined, "x", 42, [], true]) {
    assert.deepEqual(core.resolveCollapseState(bad), { ...core.COLLAPSE_DEFAULTS });
  }
});

test("collapse: toggleCollapse 翻转指定区块且不影响其它区块", () => {
  const base = { ...core.COLLAPSE_DEFAULTS };
  const afterLog = core.toggleCollapse(base, "log");
  assert.equal(afterLog.log, false);         // log 默认折叠 -> 展开
  assert.equal(afterLog.plan, base.plan);    // 其它不变
  assert.equal(afterLog.llm, base.llm);
  const back = core.toggleCollapse(afterLog, "log");
  assert.equal(back.log, true);              // 再切回折叠
  // 未知区块：返回等价状态，不新增键
  const unknown = core.toggleCollapse(base, "nope");
  assert.deepEqual(unknown, base);
  assert.equal("nope" in unknown, false);
});

// ===== 会话内容指纹兜底（v1.9.1）=====
test("fingerprintThreadId: 相同内容产生稳定 key，不同内容产生不同 key", () => {
  const a = core.fingerprintThreadId("总结项目状态，清理旧冗余对话");
  const b = core.fingerprintThreadId("总结项目状态，清理旧冗余对话");
  const c = core.fingerprintThreadId("另一个完全不同的会话内容");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^fp:[0-9a-z]+$/);
});

test("fingerprintThreadId: 忽略空白差异，空内容返回 null", () => {
  assert.equal(core.fingerprintThreadId("  hello   world \n"), core.fingerprintThreadId("hello world"));
  assert.equal(core.fingerprintThreadId(""), null);
  assert.equal(core.fingerprintThreadId(null), null);
  assert.equal(core.fingerprintThreadId(undefined), null);
});

// ===== v1.9.3：新增审核侧重 + 计划倒计时开关 =====
test("steward 侧重扩展到 8 种，新增验收/性能/文档", () => {
  const ids = core.STEWARD_REVIEW_TYPES.map((t) => t.id);
  assert.equal(ids.length, 8);
  for (const id of ["review-accept", "review-perf", "review-docs"]) {
    assert.ok(ids.includes(id), "缺少 " + id);
    const t = core.stewardReviewTypeById(id);
    assert.equal(t.id, id);
    assert.ok(t.label && t.focus && t.instruction);
  }
  // 未知 id 回落默认
  assert.equal(core.stewardReviewTypeById("nope").id, "review");
});

test("plan countdownEnabled 持久化到条目结构", () => {
  const plan = core.normalizePlanSettings({ enabled: true, entries: [{ text: "a", done: false }], countdownEnabled: false });
  const saved = core.upsertThreadPlan({}, "tid1", plan);
  assert.equal(saved.tid1.countdownEnabled, false);
  // 缺省时按开处理
  const saved2 = core.upsertThreadPlan({}, "tid2", core.normalizePlanSettings({ enabled: true }));
  assert.equal(saved2.tid2.countdownEnabled, true);
});

// ===== SELECTORS 集中化（v1.9.4）=====
// 目标：改选择器值不需要动业务逻辑。以下断言保证这一点不会被悄悄破坏。

test("SELECTORS: 导出且冻结，page/ui 分组齐全", () => {
  const S = core.SELECTORS;
  assert.ok(S && typeof S === "object");
  assert.equal(Object.isFrozen(S), true);
  assert.equal(Object.isFrozen(S.page), true);
  assert.equal(Object.isFrozen(S.ui), true);
  // 关键页面选择器必须存在且非空
  for (const k of ["main", "composer", "composerBody", "annotationConversation", "markdownBlock", "assistantMsg", "contentUnit", "sidebarThread"]) {
    assert.equal(typeof S.page[k], "string", "page." + k);
    assert.ok(S.page[k].length > 0, "page." + k + " 为空");
  }
  for (const k of ["pill", "panel", "planText", "steward", "schat", "collapseBtn", "logList"]) {
    assert.equal(typeof S.ui[k], "string", "ui." + k);
  }
});

test("SELECTORS: 参数化选择器是函数且产出正确", () => {
  assert.equal(core.SELECTORS.page.sidebarThreadById("abc"), '[data-app-action-sidebar-thread-id="abc"]');
  assert.equal(core.SELECTORS.ui.collapseGroupBody("plan"), '[data-body="plan"]');
});

test("SELECTORS: guardian.js 中所有 querySelector 都走 SELECTORS（改值不需改逻辑）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "guardian.js"), "utf8");

  // 抓取每个 querySelector(All) 的第一个实参
  const re = /querySelector(?:All)?\(/g;
  const offenders = [];
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    const arg = src.slice(start, i - 1).trim();
    if (!arg.startsWith("SELECTORS")) {
      offenders.push(arg.slice(0, 60));
    }
  }
  assert.deepEqual(offenders, [], "以下 querySelector 未走 SELECTORS：" + offenders.join(" | "));
});

// ===== prunePlanThreads 脏数据注入与恢复（v1.9.10）=====
// 背景：v1.9.9 发现 plan.v2 曾被写成 196 项数组（planThreads 被 spread 成数字键），
// 导致 delaySeconds 等字段全部丢失。以下用例锁死「脏数据进来、干净数据出去」。

test("prunePlanThreads: 输入是数组时全部丢弃（数组是最典型脏数据）", () => {
  const dirty = [
    { enabled: true, entries: [{ text: "a", done: false }], index: 0, delaySeconds: 30 },
    { enabled: true, entries: [{ text: "b", done: false }], index: 0, delaySeconds: 30 },
  ];
  assert.deepEqual(core.prunePlanThreads(dirty, "default"), {});
});

test("prunePlanThreads: 数字键（数组被 spread 的产物）被丢弃，合法线程键保留", () => {
  const dirty = {
    "0": { enabled: true, entries: [], index: 0, delaySeconds: 10 },
    "1": { enabled: true, entries: [], index: 0, delaySeconds: 10 },
    "195": { enabled: true, entries: [], index: 0, delaySeconds: 10 },
    default: { enabled: true, entries: [{ text: "keep", done: false }], index: 0, delaySeconds: 30 },
  };
  const out = core.prunePlanThreads(dirty, "default");
  assert.deepEqual(Object.keys(out), ["default"]);
  assert.equal(out.default.entries[0].text, "keep");
  assert.equal(out.default.delaySeconds, 30);
});

test("prunePlanThreads: 只保留 default + 当前活跃线程", () => {
  const threads = {
    default: { enabled: true, entries: [], index: 0, delaySeconds: 30 },
    "local:aaa": { enabled: true, entries: [], index: 0, delaySeconds: 30 },
    "local:bbb": { enabled: true, entries: [], index: 0, delaySeconds: 30 },
  };
  const out = core.prunePlanThreads(threads, "local:aaa");
  assert.deepEqual(Object.keys(out).sort(), ["default", "local:aaa"]);
});

test("prunePlanThreads: 非计划对象（缺 entries / entries 非数组）被丢弃", () => {
  const threads = {
    default: { enabled: true, entries: [], index: 0, delaySeconds: 30 },
    junk1: { enabled: true },
    junk2: { enabled: true, entries: "not-an-array" },
    junk3: null,
    junk4: "string",
    junk5: 42,
  };
  const out = core.prunePlanThreads(threads, "default");
  assert.deepEqual(Object.keys(out), ["default"]);
});

test("prunePlanThreads: 非对象输入安全返回空容器（null/undefined/字符串/数字）", () => {
  for (const bad of [null, undefined, "x", 123, true]) {
    assert.deepEqual(core.prunePlanThreads(bad, "default"), {});
  }
});

test("prunePlanThreads: 脏数据清洗后仍是合法结构，可继续写入", () => {
  // 模拟真实恢复路径：脏数组 -> prune -> upsert 新条目
  const dirty = [{ entries: [] }, { entries: [] }];
  const clean = core.prunePlanThreads(dirty, "default");
  const next = core.upsertThreadPlan(clean, "default", core.normalizePlanSettings({ enabled: true }));
  assert.equal(next.default.enabled, true);
  assert.deepEqual(next.default.entries, []);
  assert.equal(next.default.delaySeconds, 30);
});

// ===== 关闭倒计时 = 暂停计划板输出（v1.9.11）=====
test("canAutoImport: 关闭倒计时时不自动导入（暂停向主会话输出）", () => {
  const base = { enabled: true, entries: [{ text: "a", done: false }], index: 0, delaySeconds: 30 };
  assert.equal(core.canAutoImport({ ...base, countdownEnabled: true }), true);
  assert.equal(core.canAutoImport({ ...base, countdownEnabled: false }), false, "关闭倒计时必须暂停");
});

test("canAutoImport: 计划模式关 / 已全部完成 / 空列表 都不自动导入", () => {
  const entries = [{ text: "a", done: false }];
  assert.equal(core.canAutoImport({ enabled: false, entries, index: 0, countdownEnabled: true }), false);
  assert.equal(core.canAutoImport({ enabled: true, entries, index: 1, countdownEnabled: true }), false, "已越界");
  assert.equal(core.canAutoImport({ enabled: true, entries: [], index: 0, countdownEnabled: true }), false);
  assert.equal(core.canAutoImport(null), false);
  assert.equal(core.canAutoImport({ enabled: true, entries: "x", index: 0 }), false);
});

test("canAutoImport: 重新开启倒计时后恢复自动导入能力", () => {
  const plan = { enabled: true, entries: [{ text: "a", done: false }], index: 0, delaySeconds: 30 };
  assert.equal(core.canAutoImport({ ...plan, countdownEnabled: false }), false);
  assert.equal(core.canAutoImport({ ...plan, countdownEnabled: true }), true, "重新开启后应恢复");
});

// ===== 上一段必须完成且输出完整才允许倒计时导入（v1.9.13）=====
test("isResultComplete: 有实质正文即视为完整", () => {
  const long = "已完成 guardian.js 的 SELECTORS 抽取，96 处 querySelector 全部改走键值引用。";
  assert.equal(core.isResultComplete({ text: long, hasStop: false, taskStatus: "completed" }), true);
});

test("isResultComplete: 任务在跑 / 未完成 / 正文过短 / 占位符 都不算完整", () => {
  const long = "已完成 guardian.js 的 SELECTORS 抽取，96 处 querySelector 全部改走键值引用。";
  assert.equal(core.isResultComplete({ text: long, hasStop: true, taskStatus: "completed" }), false, "有停止按钮");
  assert.equal(core.isResultComplete({ text: long, hasStop: false, taskStatus: "running" }), false, "未完成");
  assert.equal(core.isResultComplete({ text: "好的", hasStop: false, taskStatus: "completed" }), false, "过短");
  assert.equal(core.isResultComplete({ text: "…", hasStop: false, taskStatus: "completed" }), false, "占位");
  assert.equal(core.isResultComplete({ text: "", hasStop: false, taskStatus: "completed" }), false);
});

test("shouldImportPlan: resultComplete=false 时绝不导入（核心闸门）", () => {
  const plan = core.normalizePlanSettings({
    enabled: true,
    entries: [{ text: "下一段", done: false }],
    index: 0,
    delaySeconds: 30,
  });
  const base = { plan, taskStatus: "completed", composerBusy: false, nowMs: 100000, planDueAtMs: 0 };
  assert.equal(core.shouldImportPlan({ ...base, resultComplete: false }), false);
  assert.equal(core.shouldImportPlan({ ...base, resultComplete: undefined }), false);
  assert.equal(core.shouldImportPlan({ ...base, resultComplete: true }), true);
});

// ===== 依据只在日志，计划板保持干净（v1.9.14）=====
test("stripEvidenceForPlan: 去掉【依据】…→ 前缀，保留编号与动作", () => {
  const input = "1. 【依据】guardian.js:900 → 【动作】补充 prunePlanThreads 单测 → 【验收】覆盖率>80%";
  const out = core.stripEvidenceForPlan(input);
  assert.equal(out, "1. 补充 prunePlanThreads 单测 → 覆盖率>80%");
  assert.ok(!/依据/.test(out), "计划板文本里不应出现「依据」");
});

test("stripEvidenceForPlan: 去掉「依据：xxx → 」写法", () => {
  const out = core.stripEvidenceForPlan("2. 依据：README 第3节 → 重写安装说明");
  assert.ok(!/依据/.test(out), out);
  assert.ok(/重写安装说明/.test(out), out);
});

test("stripEvidenceForPlan: 纯靠依据行被删除，其余条目保留，空行剔除", () => {
  const input = [
    "1. 【依据】a.md → 补测试",
    "",
    "2. 【依据】b.js",
    "3. 重写 README 的安装章节",
  ].join("\n");
  const out = core.stripEvidenceForPlan(input);
  assert.ok(!/依据/.test(out), out);
  assert.ok(/补测试/.test(out));
  assert.ok(/重写 README/.test(out));
  assert.ok(!/\n\n/.test(out), "不应保留空行");
});

test("stripEvidenceForPlan: 空/非字符串安全返回空串", () => {
  assert.equal(core.stripEvidenceForPlan(""), "");
  assert.equal(core.stripEvidenceForPlan(null), "");
  assert.equal(core.stripEvidenceForPlan(undefined), "");
});

// ===== 会话隔离 key（v1.9.16）=====
test("computeSessionKey: 首条消息相同 -> key 相同（同一对话稳定）", () => {
  // 纯函数层面的等价验证：fingerprintThreadId 是 computeSessionKey 的核心
  const a = core.fingerprintThreadId("项目 A 的第一条消息：把管家模式做稳定");
  const b = core.fingerprintThreadId("项目 A 的第一条消息：把管家模式做稳定");
  assert.equal(a, b);
});

test("computeSessionKey 语义: 同项目不同对话首条消息不同 -> key 不同（不会串台）", () => {
  const a = core.fingerprintThreadId("对话一：优化计划板倒计时");
  const b = core.fingerprintThreadId("对话二：修复 SELECTORS 抽取");
  assert.notEqual(a, b);
});

// ===== 计划板倒计时完成后不频繁操作输入框（v1.9.16）=====
test("canAutoImport: 关闭倒计时时不导入，开启才允许（倒计时读完不会连着再发）", () => {
  const plan = { enabled: true, entries: [{ text: "a", done: false }], index: 0, delaySeconds: 30 };
  assert.equal(core.canAutoImport({ ...plan, countdownEnabled: false }), false);
  assert.equal(core.canAutoImport({ ...plan, countdownEnabled: true }), true);
});

test("shouldImportPlan: 导入冷却窗口内不会重复操作输入框", () => {
  const plan = core.normalizePlanSettings({ enabled: true, entries: [{ text: "a", done: false }], delaySeconds: 30 });
  const base = { plan, taskStatus: "completed", composerBusy: false, resultComplete: true, planDueAtMs: 0 };
  // 刚导入过（距上次 1s），冷却 4s 内应拒绝
  assert.equal(core.shouldImportPlan({ ...base, nowMs: 1000, lastImportAtMs: 0 }), false);
  // 超过冷却后可再次导入
  assert.equal(core.shouldImportPlan({ ...base, nowMs: 5000, lastImportAtMs: 0 }), true);
});
