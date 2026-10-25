#!/usr/bin/env node
/**
 * 管家守护进程（原生，无浏览器 CORS 限制）
 *
 * 为什么需要它：Codex 页面是 app:// 安全上下文，fetch http/https://127.0.0.1 全被
 * Chromium 的 Private Network Access + 证书策略拦死（实测三种本地端点均 Failed to fetch）。
 * 原生进程不受此限，所以由本进程：
 *   1. 通过 CDP(9229) 读取页面里 guardian 的状态（任务是否 completed、计划板内容、设置）
 *   2. 原生 fetch 调 LLM 供应商（无 CORS）
 *   3. 把「重点问题 / 下一步计划」写回页面 localStorage 的计划板
 *   4. 按设置排定倒计时，由页面里的 guardian 接手把计划喂回 composer 并发送
 *
 * 用法：node scripts/steward-daemon.mjs
 */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createCredentialStore } from "./credential-store.mjs";
import { normalizeProfiles, requestWithFallback } from "./llm-adapters.mjs";
import { classifyTask, evaluateDeliveryReadiness, requiredChecksFor, validateProposedPlan } from "./policy-engine.mjs";
import { applyCleanup, createDelivery, createDeliveryPreview, verifyDelivery } from "./delivery-manager.mjs";

const require = createRequire(import.meta.url);
const core = require("../guardian.js"); // 复用 parseStewardSideOutput / appendStewardPlan 等纯函数

const CDP = "http://127.0.0.1:9229";
const POLL_MS = 3000;
const PLAN_QUALITY_RULES = "【计划质量硬约束】下一步必须直接交付本轮明确未完成或阻断交付的功能/修复；禁止只安装依赖、搭脚手架或初始化环境；必须写出至少一个材料中的路径、参数、文件名或代码标识符；必须包含「验收：<命令或可观察结果>」；未经材料要求不得追最新版；低优先级 TODO 不得抢占当前阻断任务。";
// v1.9.15：审计前要求主会话输出「已完成且稳定」——避免拿半截输出做归纳
const MIN_RESULT_CHARS = 40;      // 结果正文至少这么多字
const SETTLE_MS = 5000;           // 输出至少 5 秒没变化才算收敛
let lastOutputHash = "";
let lastMemorySessionKey = "";
let lastOutputChangedAt = 0;

function textHash(t) {
  const s = String(t || "");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}
const PLAN_KEY = "codex429Guardian.plan.v2";
const SETTINGS_KEY = "codex429Guardian.settings.v1";
const AUDIT_KEY = "codex429Guardian.lastAuditTurn.v1";
const REQ_KEY = "codex429Guardian.auditRequest.v1";
const LOG_KEY = "codex429Guardian.auditLog.v1";
const CREDENTIAL_REQUEST_KEY = "codex429Guardian.credentialRequest.v1";
const DELIVERY_REQUEST_KEY = "codex429Guardian.deliveryRequest.v1";
const DELIVERY_STATE_KEY = "codex429Guardian.deliveryState.v1";
const DELIVERY_HISTORY_KEY = "codex429Guardian.deliveryHistory.v1";
const credentialStore = createCredentialStore();
const providerHealth = new Map();
let lastProviderInfo = null;

// v1.9.8：运行时自检——代码依赖 Node 24 的全局 WebSocket / fetch，版本不足时明确报错而不是诡异失败
(function assertRuntime() {
  const major = Number(String(process.versions.node || "0").split(".")[0]);
  if (major < 24) {
    console.error(
      "[steward-daemon] 需要 Node >= 24，当前 " + process.versions.node + "。\n" +
      "请用 Codex 自带的 node 运行：\n" +
      "  /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/steward-daemon.mjs"
    );
    process.exit(78); // EX_CONFIG
  }
  if (typeof WebSocket !== "function") {
    console.error("[steward-daemon] 当前 Node 缺少全局 WebSocket（需要 >= 22 且未禁用），无法连接 CDP。");
    process.exit(78);
  }
})();

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error("CDP connect failed"));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        }
      };
    });
  }
  eval(expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, (m) => {
        if (m?.result?.exceptionDetails) {
          const d = m.result.exceptionDetails;
          return reject(new Error([d.text, d.exception?.description, d.exception?.value].filter(Boolean).join(" | ").slice(0, 300)));
        }
        resolve(m?.result?.result?.value);
      });
      this.ws.send(JSON.stringify({
        id, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise },
      }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}


// ===== 管家日志（v1.9.0）：可查可读 + 错误打标签 + 防重复 =====
// v1.9.26：审核过程追踪——记录做了什么/调了什么/读了什么
async function trace(cdp, step, detail, kind) {
  try {
    await cdp.eval(`(function(){
      if (window.__codex429Trace) window.__codex429Trace(${JSON.stringify(String(step||""))}, ${JSON.stringify(String(detail||""))}, ${JSON.stringify(kind||"info")});
    })()`);
  } catch (_) {}
}

async function appendLog(cdp, kind, text, extra) {
  const payload = { ts: Date.now(), kind, text: String(text || "").slice(0, 300), ...(extra || {}) };
  try {
    await cdp.eval(`(function(){
      var K = ${JSON.stringify(LOG_KEY)};
      var a = []; try { a = JSON.parse(localStorage.getItem(K)) || []; } catch(_) { a = []; }
      if (!Array.isArray(a)) a = [];
      a.push(${JSON.stringify(payload)});
      if (a.length > 40) a = a.slice(-40);
      localStorage.setItem(K, JSON.stringify(a));
      if (window.__codex429RenderLog) { try { window.__codex429RenderLog(); } catch(_) {} }
      return true;
    })()`);
  } catch (_) {}
}

function shortHash(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// v1.9.17：接地校验——计划里的关键标识符必须能在提供的材料中找到，否则视为幻觉
const GROUND_STOPWORDS = new Set([
  "the","and","for","with","this","that","from","into","then","than","when","what","which","will","your","have","has","are","was","were","not","but","all","any","can","may","use","using","add","fix","run","test","check","update","change","make","ensure","verify","file","files","path","code","step","steps","plan","next","todo","note","from","item","items",
]);
function ungroundedTokens(reply, material) {
  const hay = String(material || "").toLowerCase();
  const tokens = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
  let m;
  while ((m = re.exec(String(reply || "")))) {
    const t = m[0];
    const low = t.toLowerCase();
    if (GROUND_STOPWORDS.has(low)) continue;
    // 只看「像标识符」的：含下划线/驼峰/点号，或长度>=6
    if (!/[_A-Z]/.test(t) && t.length < 6) continue;
    tokens.add(low);
  }
  const unknown = [];
  for (const t of tokens) {
    if (!hay.includes(t)) unknown.push(t);
  }
  return { total: tokens.size, unknown, ratio: tokens.size ? unknown.length / tokens.size : 0 };
}

function planGroundingPart(text) {
  return String(text || "").split(/(?:验收|完成标准|期望(?:结果|输出)|通过条件)\s*[:：]/i)[0];
}

function errorTag(msg) {
  const m = String(msg || "");
  if (/HTTP 401|无效的令牌|invalid.*token|unauthorized/i.test(m)) return "auth";
  if (/HTTP 404|not found/i.test(m)) return "endpoint";
  if (/HTTP 429|rate limit/i.test(m)) return "ratelimit";
  if (/HTTP 5\d\d/.test(m)) return "upstream";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|Failed to fetch/i.test(m)) return "network";
  if (/JSON|响应非 JSON|模型返回为空/.test(m)) return "format";
  if (/timeout/i.test(m)) return "timeout";
  return "unknown";
}

async function pickPageTarget() {
  const list = await httpJson(`${CDP}/json`);
  const page = list.find((t) => t.type === "page" && /index\.html|app:\/\//.test(t.url || ""));
  if (!page) throw new Error("找不到 Codex 页面 target");
  return page;
}


export function summarizeProviderFailure(result) {
  return (result?.attempts || [])
    .map((attempt) => `${attempt.profileId}:${attempt.failure || "unknown"}`)
    .join(", ");
}


export function derivePolicyChecks({ taskLevel = "feature", sourceText = "", changedPaths = [], backupVerified = false } = {}) {
  const text = String(sourceText || "");
  const paths = (changedPaths || []).map((item) => String(item).replace(/\\/g, "/"));
  const hasVerification = /(?:\b\d+\s*\/\s*\d+\b.{0,20}(?:pass|通过)|(?:npm|node|cargo|pytest|go test|swift test|python).{0,30}test|tests?\s+passed|验收\s*[:：]|PASS\b)/i.test(text);
  const hasDocs = paths.some((item) => /(?:^|\/)(?:README|HANDOFF)[^/]*\.md$|(?:^|\/)docs\//i.test(item)) || /README|HANDOFF|docs\//i.test(text);
  const hasRegression = /regression|回归|compatib|兼容/i.test(text) && hasVerification;
  const hasRecovery = /rollback|回滚|recovery|恢复方案|revert|backup/i.test(text);
  return requiredChecksFor(taskLevel).map((check) => {
    let passed = false;
    if (check.id === "implementation") passed = text.trim().length > 0;
    if (check.id === "verification") passed = hasVerification;
    if (check.id === "documentation") passed = hasDocs;
    if (check.id === "regression") passed = hasRegression;
    if (check.id === "recovery") passed = hasRecovery;
    if (check.id === "backup") passed = backupVerified === true;
    return { ...check, status: passed ? "pass" : "unknown" };
  });
}

export function computeDeliveryDecision({
  taskLevel = "feature",
  sourceText = "",
  changedPaths = [],
  planEntries = [],
  reviewErrors = [],
  backupVerified = false,
} = {}) {
  const checks = derivePolicyChecks({ taskLevel, sourceText, changedPaths, backupVerified });
  return evaluateDeliveryReadiness({ taskLevel, planEntries, reviewErrors, checks, backupVerified });
}

function collectChangedPaths(projectRoot) {
  if (!projectRoot) return [];
  const result = spawnSync("git", ["-C", projectRoot, "status", "--porcelain", "-z"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const parts = String(result.stdout || "").split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    const pathValue = record.slice(3);
    if (pathValue) paths.push(pathValue);
    if (/^[RC]/.test(record.slice(0, 2)) && parts[i + 1]) paths.push(parts[++i]);
  }
  return [...new Set(paths)];
}

async function migrateLegacyCredential(cdp, settings) {
  const legacyKey = String(settings?.llmApiKey || "");
  if (!legacyKey) return settings;
  await credentialStore.set("primary", legacyKey);
  await cdp.eval(`(function(){
    const K = ${JSON.stringify(SETTINGS_KEY)};
    const s = JSON.parse(localStorage.getItem(K) || "{}");
    delete s.llmApiKey;
    localStorage.setItem(K, JSON.stringify(s));
  })()`);
  log("已将旧 API Key 迁移到 macOS Keychain");
  return { ...settings, llmApiKey: "" };
}

async function readDeliveryState(cdp) {
  try {
    const raw = await cdp.eval(`localStorage.getItem(${JSON.stringify(DELIVERY_STATE_KEY)})`);
    return raw ? JSON.parse(raw) : { state: "in-progress" };
  } catch { return { state: "in-progress" }; }
}

async function writeDeliveryState(cdp, state) {
  await cdp.eval(`localStorage.setItem(${JSON.stringify(DELIVERY_STATE_KEY)}, ${JSON.stringify(JSON.stringify(state))})`);
}

async function appendDeliveryHistory(cdp, record) {
  await cdp.eval(`(function(){
    const K = ${JSON.stringify(DELIVERY_HISTORY_KEY)};
    let a = [];
    try { a = JSON.parse(localStorage.getItem(K)) || []; } catch {}
    a.push(${JSON.stringify(record)});
    localStorage.setItem(K, JSON.stringify(a.slice(-20)));
  })()`);
}

async function handleCredentialRequest(cdp, rawRequest) {
  if (!rawRequest) return null;
  let request = null;
  try { request = JSON.parse(rawRequest); } catch {}
  await cdp.eval(`localStorage.removeItem(${JSON.stringify(CREDENTIAL_REQUEST_KEY)})`).catch(() => {});
  if (!request?.op) return { ok: false, error: "invalid-request" };
  try {
    if (request.op === "set") {
      await credentialStore.set(String(request.ref || "primary"), String(request.secret || ""));
      await appendLog(cdp, "info", "凭据已保存到 macOS Keychain", { ref: String(request.ref || "primary"), mode: "credential" });
      return { ok: true, ref: String(request.ref || "primary") };
    }
    if (request.op === "remove") {
      await credentialStore.remove(String(request.ref || "primary"));
      await appendLog(cdp, "info", "凭据已从 macOS Keychain 移除", { ref: String(request.ref || "primary"), mode: "credential" });
      return { ok: true, ref: String(request.ref || "primary") };
    }
  } catch (error) {
    await appendLog(cdp, "err", "凭据操作失败：" + String(error.message || error).slice(0, 120), { tag: "credential", mode: "credential" });
    return { ok: false, error: "credential-operation-failed" };
  }
  return { ok: false, error: "unsupported-operation" };
}

function unresolvedReviewErrors(logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  let lastSuccess = -1;
  for (let i = 0; i < list.length; i += 1) if (list[i]?.kind === "ok") lastSuccess = i;
  return list.slice(lastSuccess + 1).filter((entry) => entry?.kind === "err");
}

async function readAuditLog(cdp) {
  try {
    const raw = await cdp.eval(`localStorage.getItem(${JSON.stringify(LOG_KEY)})`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function refreshDeliveryState(cdp, context) {
  const previous = await readDeliveryState(cdp);
  const changedPaths = collectChangedPaths(context.projectRoot);
  const classification = classifyTask({ taskText: context.sourceText, changedPaths });
  const logs = await readAuditLog(cdp);
  const reviewErrors = unresolvedReviewErrors(logs);
  const backupVerified = previous?.lastDelivery?.verificationOk === true;
  const credentialStatus = {};
  for (const profile of normalizeProfiles(context.settings || {}, {})) {
    if (profile.auth === false) credentialStatus[profile.credentialRef] = true;
    else credentialStatus[profile.credentialRef] = await credentialStore.has(profile.credentialRef).catch(() => false);
  }
  const decision = computeDeliveryDecision({
    taskLevel: classification.level,
    sourceText: context.sourceText,
    changedPaths,
    planEntries: context.planEntries,
    reviewErrors,
    backupVerified,
  });
  const state = {
    ...previous,
    state: decision.deliveryState,
    taskLevel: classification.level,
    taskLevelReasons: classification.reasons,
    decision,
    credentialStatus,
    provider: lastProviderInfo,
    changedPaths,
    updatedAt: Date.now(),
  };
  await writeDeliveryState(cdp, state);
  return state;
}

async function handleDeliveryRequest(cdp, rawRequest, context) {
  if (!rawRequest) return null;
  let request = null;
  try { request = JSON.parse(rawRequest); } catch {}
  await cdp.eval(`localStorage.removeItem(${JSON.stringify(DELIVERY_REQUEST_KEY)})`).catch(() => {});
  if (!request?.op) return { ok: false, error: "invalid-request" };
  let deliveryState = await refreshDeliveryState(cdp, context);
  if (request.op === "cancel") {
    deliveryState = { ...deliveryState, preview: null, lastAction: "preview-cancelled" };
    await writeDeliveryState(cdp, deliveryState);
    return { ok: true };
  }
  if (request.op === "preview") {
    if (deliveryState.decision?.deliveryState !== "ready-for-confirmation") return { ok: false, error: "delivery-not-ready" };
    const preview = createDeliveryPreview({ projectRoot: context.projectRoot, sessionKey: context.tid, decision: deliveryState.decision, now: Date.now });
    preview.provider = lastProviderInfo;
    deliveryState = { ...deliveryState, preview, lastAction: "preview-ready" };
    await writeDeliveryState(cdp, deliveryState);
    return { ok: true, preview };
  }
  if (request.op === "execute") {
    if (request.confirmed !== true) return { ok: false, error: "confirmation-required" };
    const preview = deliveryState.preview;
    if (!preview || preview.executeToken !== request.executeToken) return { ok: false, error: "stale-preview" };
    const result = await createDelivery({ projectRoot: context.projectRoot, preview, userConfirmed: true, now: Date.now });
    if (!result.ok) {
      deliveryState = { ...deliveryState, lastAction: result.errorCode, lastError: result.error };
      await writeDeliveryState(cdp, deliveryState);
      return result;
    }
    const verification = await verifyDelivery({ deliveryDir: result.deliveryDir });
    const cleanup = verification.ok ? await applyCleanup({ projectRoot: context.projectRoot, preview }) : null;
    const record = {
      ts: Date.now(),
      sessionKey: context.tid,
      deliveryDir: result.deliveryDir,
      archiveSha256: result.archiveSha256,
      verificationOk: verification.ok,
      cleanup,
    };
    await appendDeliveryHistory(cdp, record);
    deliveryState = {
      ...deliveryState,
      state: verification.ok ? "delivered" : "needs-work",
      preview: null,
      lastDelivery: record,
      lastAction: verification.ok ? "delivered" : "verification-failed",
    };
    await writeDeliveryState(cdp, deliveryState);
    return { ok: verification.ok, verification, cleanup, record };
  }
  return { ok: false, error: "unsupported-operation" };
}

async function callLlm(settings, prompt) {
  const profiles = normalizeProfiles(settings, {});
  const result = await requestWithFallback({
    profiles,
    prompt,
    credentialStore,
    health: providerHealth,
  });
  if (!result.ok) {
    lastProviderInfo = { ok: false, attempts: result.attempts, errorCode: result.errorCode };
    throw new Error("LLM provider chain failed: " + summarizeProviderFailure(result));
  }
  lastProviderInfo = {
    ok: true,
    profileId: result.profileId,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
  };
  return result.text;
}

// ===== 项目上下文采集（v1.8.58）=====
// 守护进程是原生进程，可直接读项目文件，建立对项目结构框架的整体理解。
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".cache", "out", "coverage", ".venv", "venv", "__pycache__", ".idea", ".vscode", "vendor"]);
const MAX_TREE_ENTRIES = 140;
const MAX_TREE_DEPTH = 2;
const MAX_DOC_CHARS = 2600;          // 项目级文档截断上限
const MAX_SESSION_DOC_CHARS = 20000;  // 会话专属文档（如 SESSION-STATE.md）尽量读全
const MAX_MAIN_OUTPUT_CHARS = 20000;  // 主任务本轮输出尽量读全
const MAX_DOCS = 4;

// v1.9.17：会话隔离目录——每个会话的 md 只落在自己的目录里，互不可见
function sessionDir(root, sessionKey) {
  const key = String(sessionKey || "default").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64);
  return path.join(root, ".guardian", "sessions", key);
}

function persistSessionMemory({ projectRoot, identity, sourceText, projectCtx, planEntries, summary, now } = {}) {
  const root = String(projectRoot || "").trim();
  if (!root) throw new Error("projectRoot is required");
  const memoryKey = String(identity?.memoryKey || identity?.sessionId || "default");
  const dir = sessionDir(root, memoryKey);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date(Number(now) || Date.now()).toISOString();
  const title = String(identity?.sessionTitle || "未命名会话").replace(/\s+/g, " ").trim();
  const meta = {
    sessionId: identity?.sessionId || null,
    memoryKey,
    sessionTitle: title,
    projectRoot: root,
    updatedAt: timestamp,
  };
  fs.writeFileSync(path.join(dir, "SESSION.json"), JSON.stringify(meta, null, 2), "utf8");
  const statePath = path.join(dir, "SESSION-STATE.md");
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, [
      "# 会话状态", "", `- 会话名称：${title}`, `- 会话编号：${memoryKey}`, "",
      "## 本会话目标", "", "待主会话根据当前任务补充。", "",
      "## 已完成", "", "待补充。", "",
      "## 未完成/阻塞", "", "待补充。", "",
      "## 关键决策", "", "待补充。", "",
      "## 下一步", "", "待管家或主会话补充。", "",
    ].join("\n"), "utf8");
  }
  const docs = (projectCtx?.docs || []).map((doc) => `- ${doc.file}`).join("\n") || "- 无";
  const plan = (planEntries || []).map((entry) => `- ${entry.done ? "[已完成] " : ""}${entry.text}`).join("\n") || "- 无";
  const contextMd = [
    "# 管家最新上下文", "", `- 会话名称：${title}`, `- 会话编号：${memoryKey}`, `- 更新时间：${timestamp}`, "",
    "## 主会话最新输出", "", String(sourceText || "(无)").slice(0, MAX_MAIN_OUTPUT_CHARS), "",
    "## 管家本次读取的文档", "", docs, "",
    "## 当前计划板", "", plan, "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "LATEST-CONTEXT.md"), contextMd, "utf8");
  if (String(summary || "").trim()) {
    const summaryMd = [
      "# 管家总结", "", `- 会话名称：${title}`, `- 会话编号：${memoryKey}`, `- 更新时间：${timestamp}`, "",
      String(summary).trim(), "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "STEWARD-SUMMARY.md"), summaryMd, "utf8");
  }
  return { dir, meta };
}

function collectTree(root) {
  const out = [];
  function walk(dir, depth, prefix) {
    if (depth > MAX_TREE_DEPTH || out.length >= MAX_TREE_ENTRIES) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const it of items) {
      if (out.length >= MAX_TREE_ENTRIES) return;
      if (it.name.startsWith(".")) continue;
      if (it.isDirectory() && SKIP_DIRS.has(it.name)) continue;
      out.push(prefix + it.name + (it.isDirectory() ? "/" : ""));
      if (it.isDirectory()) walk(path.join(dir, it.name), depth + 1, prefix + "  ");
    }
  }
  walk(root, 1, "");
  return out;
}

function safeRead(file, maxChars) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return fs.readFileSync(file, "utf8").slice(0, maxChars || MAX_DOC_CHARS);
  } catch { return null; }
}

function collectProjectDocs(root, sessionKey) {
  const docs = [];
  // ① 本会话专属目录（最高优先级，只读自己的）
  const sdir = sessionDir(root, sessionKey);
  try {
    const items = fs.readdirSync(sdir).filter((n) => /\.md$/i.test(n)).sort().reverse();
    const priority = ["SESSION-STATE.md", "PROJECT-STATE.md", "REA-EVIDENCE.md", "LATEST-CONTEXT.md", "STEWARD-SUMMARY.md"];
    items.sort((a, b) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return b.localeCompare(a);
    });
    for (const n of items) {
      if (docs.length >= 2) break;
      const txt = safeRead(path.join(sdir, n), MAX_SESSION_DOC_CHARS);
      if (txt) docs.push({ file: ".guardian/sessions/" + path.basename(sdir) + "/" + n, text: txt, full: true });
    }
  } catch (_) { /* 目录不存在即跳过 */ }

  // ② 项目级文档（全局事实，最多 2 个）
  const candidates = ["HANDOFF-STEWARD.md", "README.md", "HANDOFF.md", "ARCHITECTURE.md"];
  for (const name of candidates) {
    if (docs.length >= MAX_DOCS) break;
    const txt = safeRead(path.join(root, name));
    if (txt) docs.push({ file: name, text: txt });
  }
  return docs;
}

function collectReferencedMds(text, root, sessionKey) {
  if (!root || !text) return [];
  const found = new Set();
  const re = /[A-Za-z0-9_\-\/\.\u4e00-\u9fa5]+\.md/g;
  let m;
  while ((m = re.exec(text)) && found.size < 3) {
    let p = m[0];
    if (!p.startsWith("/")) p = path.join(root, p);
    found.add(path.normalize(p));
  }
  const out = [];
  const rootNorm = path.normalize(root);
  const myDir = path.normalize(sessionDir(root, sessionKey));
  for (const f of found) {
    if (!f.startsWith(rootNorm)) continue;
    // v1.9.17：禁止读取其他会话的专属文件（.guardian/sessions/<别的key>/...）
    const inSessions = f.includes(path.join(".guardian", "sessions"));
    if (inSessions && !f.startsWith(myDir)) continue;
    const txt = safeRead(f);
    if (txt) out.push({ file: path.relative(root, f), text: txt });
  }
  return out;
}

// ===== 会话级上下文缓存（v1.9.21）=====
// 目录树 + 项目文档只在本会话首次构建时计算，之后复用磁盘缓存，直到文件变化或过期。
const CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 分钟

function contextCachePath(root, sessionKey) {
  return path.join(sessionDir(root, sessionKey), "context-cache.json");
}

// 廉价签名：候选文档的 mtime+size + 顶层条目名，任一变化即失效
function projectSignature(root, sessionKey) {
  const parts = [path.basename(root)];
  const push = (p, label) => {
    try {
      const st = fs.statSync(p);
      parts.push(label + ":" + Math.round(st.mtimeMs) + ":" + st.size);
    } catch (_) { /* 不存在 */ }
  };
  for (const name of ["HANDOFF-STEWARD.md", "README.md", "HANDOFF.md", "ARCHITECTURE.md", "DESIGN.md", "PLAN.md"]) {
    push(path.join(root, name), name);
  }
  try {
    const top = fs.readdirSync(root).sort().slice(0, 60).join(",");
    parts.push("top:" + top.length + ":" + hashStr(top));
  } catch (_) {}
  try {
    const sd = sessionDir(root, sessionKey);
    const items = fs.readdirSync(sd).filter((n) => /\.md$/i.test(n)).sort();
    parts.push("sess:" + items.join(","));
    for (const n of items) push(path.join(sd, n), "sess/" + n);
  } catch (_) {}
  return hashStr(parts.join("|"));
}

function hashStr(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readContextCache(root, sessionKey) {
  try {
    const raw = fs.readFileSync(contextCachePath(root, sessionKey), "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch (_) {}
  return null;
}

function writeContextCache(root, sessionKey, payload) {
  try {
    const dir = sessionDir(root, sessionKey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(contextCachePath(root, sessionKey), JSON.stringify(payload), "utf8");
  } catch (_) {}
}

// 缓存静态部分（目录树 + 项目级/会话级文档），引用 md 每次动态合并
function buildProjectContextCached(root, conversationText, sessionKey) {
  if (!root) return buildProjectContext(root, conversationText, sessionKey);
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch { exists = false; }
  if (!exists) return buildProjectContext(root, conversationText, sessionKey);

  const sig = projectSignature(root, sessionKey);
  const cached = readContextCache(root, sessionKey);
  const fresh = cached && cached.sig === sig && (Date.now() - (cached.builtAt || 0)) < CONTEXT_TTL_MS;

  let base;
  if (fresh) {
    base = { ...cached.ctx, cacheHit: true };
    log("上下文缓存命中", { session: String(sessionKey).slice(0, 18), age: Math.round((Date.now() - cached.builtAt) / 1000) + "s", sig });
  } else {
    const tree = collectTree(root);
    const docs = collectProjectDocs(root, sessionKey);
    base = { ok: tree.length > 0 || docs.length > 0, reason: "", tree: tree.join("\n"), docs, cacheHit: false };
    writeContextCache(root, sessionKey, { sig, builtAt: Date.now(), ctx: base });
    log("上下文缓存重建", { session: String(sessionKey).slice(0, 18), tree: tree.length, docs: docs.length, sig });
  }

  // 动态部分：本会话引用的 md（每次都算，量很小）
  const referenced = collectReferencedMds(conversationText, root, sessionKey);
  if (!referenced.length) return base;
  const seen = new Set(base.docs.map((d) => d.file));
  const docs = [...base.docs];
  for (const r of referenced) if (!seen.has(r.file)) { seen.add(r.file); docs.push(r); }
  return { ...base, docs: docs.slice(0, MAX_DOCS) };
}

function buildProjectContext(root, conversationText, sessionKey) {
  if (!root) return { ok: false, reason: "未配置项目目录（面板「项目目录」留空）", tree: "", docs: [] };
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch { exists = false; }
  if (!exists) return { ok: false, reason: "项目目录不存在：" + root, tree: "", docs: [] };

  const tree = collectTree(root);
  const docs = collectProjectDocs(root, sessionKey);
  const referenced = collectReferencedMds(conversationText, root, sessionKey);
  const seen = new Set(docs.map((d) => d.file));
  for (const r of referenced) if (!seen.has(r.file)) { seen.add(r.file); docs.push(r); }

  const ok = tree.length > 0 || docs.length > 0;
  return {
    ok,
    reason: ok ? "" : "项目目录为空，且没有可读的 README/HANDOFF 文档",
    tree: tree.join("\n"),
    docs: docs.slice(0, MAX_DOCS),
  };
}

// 从项目文档里提取「项目最终目标」：优先 HANDOFF-STEWARD.md，其次 README.md
function extractProjectGoal(projectCtx) {
  const docs = projectCtx && projectCtx.docs ? projectCtx.docs : [];
  const pick = docs.find((d) => /HANDOFF-STEWARD\.md$/i.test(d.file)) || docs.find((d) => /^README\.md$/i.test(d.file));
  if (!pick) return "";
  const text = String(pick.text || "");
  // 取第一段非标题、非空的正文
  const lines = text.split("\n").map((l) => l.trim());
  const para = [];
  for (const l of lines) {
    if (!l) { if (para.length) break; continue; }
    if (l.startsWith("#")) { if (para.length) break; continue; }
    para.push(l.replace(/^>\s*/, ""));
    if (para.join(" ").length > 220) break;
  }
  return para.join(" ").slice(0, 300);
}

function buildPrompt({ mainOutput, projectStatus, planEntries, mode, projectCtx, projectGoal }) {
  const type = core.stewardReviewTypeById ? core.stewardReviewTypeById(mode) : { label: "审核", planLabel: "下一步", focus: "" };
  const kindHint = {
    review: "全面审核：既要判断本轮产出是否达标，也要从项目整体框架判断推进方向是否正确。",
    "review-next": "只聚焦下一步：给出可直接执行的下一段任务。",
    "review-fixes": "只聚焦缺陷：找出必须修的短板并给出修复指令。",
    "review-optimize": "只聚焦优化：性能、可读性、复用性、测试覆盖、成本、可维护性。",
    "review-develop": "只聚焦扩展：新功能、补全缺口、阶段目标、后续模块。",
  }[mode] || "全面审核。";

  const treePart = projectCtx && projectCtx.tree
    ? "\n\n【项目目录结构（2 层）】\n" + projectCtx.tree
    : "";

  let docsPart = "";
  if (projectCtx && projectCtx.docs && projectCtx.docs.length) {
    docsPart = "\n\n【项目文档摘要】";
    for (const d of projectCtx.docs) {
      const cap = d.full ? MAX_SESSION_DOC_CHARS : MAX_DOC_CHARS;
      docsPart += "\n\n--- " + d.file + " ---\n" + String(d.text || "").slice(0, cap);
    }
  }

  const doneItems = (planEntries || []).filter((e) => e.done).map((e) => e.text).slice(-6);
  const donePart = doneItems.length
    ? "\n\n【已完成的计划段（禁止重复规划）】\n" + doneItems.map((t, i) => (i + 1) + ". " + t).join("\n")
    : "";
  const planPart = planEntries && planEntries.length
    ? "\n\n【计划板现状】\n" + planEntries.map((e, i) => (i + 1) + ". " + e.text + (e.done ? " [已完成]" : "")).join("\n")
    : "\n\n【计划板现状】\n(空)";

  const head = [PLAN_QUALITY_RULES,
    "你是本项目的技术审核管家。你拿到了项目的目录结构、关键文档、本轮主任务输出和计划板现状。",
    "请基于项目整体框架判断本轮产出，而不是只看本轮文字。",
    "",
    "【必须按以下顺序处理，不要跳步】",
    "第一步：完整读完「主任务本轮输出」的每一段，理解它到底交付了什么、没交付什么；",
    "第二步：完整读完「会话文档 / 项目文档」里与当前会话相关的内容，形成对项目框架的整体认识；",
    "第三步：把两者对照——本轮输出是否真的推进了项目目标？还缺什么？下一步最该做什么？",
    "第四步：如果读完上面两项仍然不清楚（缺关键实现细节、缺接口定义、缺状态记录），",
    "        不要猜，改为只输出这一段：",
    "        ## 需要会话总结",
    "        说明需要主会话产出什么样的状态文档（要包含哪几节）。",
    "",
    "【事实优先级（重要）】",
    "1) 「主任务本轮输出」= 当前最新事实，最高优先级；",
    "2) 「项目文档摘要」可能滞后（写于更早版本），当两者冲突时以本轮输出为准；",
    "3) 本轮输出里明确说明「已完成」的项，绝对不要再规划一次；",
    "4) 计划板里已标 [已完成] 的段落，也不要重复规划。",
    "",
    "【项目最终目标】",
    projectGoal || "(未从文档中提取到目标，请从目录结构与文档自行归纳，并在「项目整体理解」中说明)",
    "",
    "【主任务本轮输出】",
    String(mainOutput || "(未读到输出)").slice(0, MAX_MAIN_OUTPUT_CHARS) + treePart + docsPart + donePart + planPart,
    "",
    "【项目当前状态】",
    projectStatus || "(未提供)",
    "",
    "---",
    "请严格按以下四段输出，标题原样保留：",
    "",
    "## 项目整体理解",
    "用 1-2 句说明：这个项目是什么、由哪几个主要模块构成、当前处于什么阶段。",
    "必须引用上面目录结构或文档里的具体模块/文件名，不要空泛。",
    "",
    "## 本轮产出评估",
    "① 本轮实际完成了什么（1 句，指名具体文件/模块）。",
    "② 与项目整体目标相比，当前完成度大概多少，还差哪几块。",
    "",
    "## 关键短板",
    "这是给【审核日志】看的，必须带依据。每条格式：",
    "「依据：<文件/路径/函数/原文片段> → 问题：<具体问题> → 影响：<会导致什么>」",
    "按严重程度排序，最多 3 条。没有明显问题就写「无」。",
    "",
    "## 下一步计划",
    "这是要直接写进【计划板】并自动发给 Codex 执行的指令，必须干净、可直接执行：",
    "- 不要出现「依据」「【依据】」「【动作】」「【验收】」等标记，不要复述证据",
    "- 每条一行，动词开头，指明要改的文件/模块，自带验收判据",
    "- 3-5 条，按执行顺序编号",
    "- 每条都必须服务于本项目的最终设计目的，不许偏离项目框架去做无关的事",
    "- 禁止「继续优化」「进一步完善」这类空话",
    "",
    "## 证据不足时（重要）",
    "如果上面的材料不足以判断下一步该做什么（缺关键实现依据、缺接口定义、缺调用链证据），",
    "不要猜。改为只输出这一段：",
    "## 需要探测",
    "1. <用 rea 探测什么，具体到文件/符号/接口>",
    "2. <...>",
    "并说明预期的证据文件路径，例如 REA-EVIDENCE-<主题>.md。",
    "",
    "【硬约束】",
    "- 全文 ≤ 400 字",
    "- 禁止复述上面材料原文",
    "- 禁止提出与项目结构无关的泛泛建议",
  ];
  return head.join("\n");
}

async function tick(cdp) {
  // 1. 读页面里 guardian 的实时状态
  const state = await cdp.eval(`(function(){
    const raw = localStorage.getItem(${JSON.stringify(SETTINGS_KEY)});
    const s = raw ? JSON.parse(raw) : {};
    const planRaw = localStorage.getItem(${JSON.stringify(PLAN_KEY)});
    let plan = {};
    try { plan = planRaw ? JSON.parse(planRaw) : {}; } catch(_) {}
    const g = window.__CODEX_429_GUARDIAN__;
    const rt = g?.getState ? g.getState() : null;
    const snap = g?.getSessionSnapshot ? g.getSessionSnapshot() : null;
    // 主任务输出：按可靠性多级回退（当前 UI 版本 content-search-unit 可能为 0 宽）
    function grabText() {
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
      };
      const conv = [...document.querySelectorAll('[data-response-annotation-conversation]')].filter(visible).at(-1)?.getAttribute('data-response-annotation-conversation') || null;
      const inScope = (el) => {
        const owner = el.closest('[data-response-annotation-conversation]')?.getAttribute('data-response-annotation-conversation') || null;
        return !conv || !owner || owner === conv;
      };
      // ① 助手 markdown 块（最可靠）
      const md = Array.from(document.querySelectorAll('[data-markdown-text-style]')).filter((el) => visible(el) && inScope(el));
      if (md.length) {
        const tail = md.slice(-4).map(function(el){ return (el.innerText||'').trim(); }).filter(Boolean);
        if (tail.length) return tail.join(' || ').slice(-4000);
      }
      // ② annotation target
      const ann = Array.from(document.querySelectorAll('[data-response-annotation-target]')).filter((el) => visible(el) && inScope(el));
      if (ann.length) {
        const t = ann.slice(-3).map(function(el){ return (el.innerText||'').trim(); }).filter(Boolean);
        if (t.length) return t.join(' || ').slice(-4000);
      }
      // ③ content-search-unit（不过滤宽度）
      const un = Array.from(document.querySelectorAll('[data-content-search-unit-key]')).filter(inScope);
      if (un.length) {
        const t = un.slice(-2).map(function(el){ return (el.innerText||'').trim(); }).filter(Boolean);
        if (t.length) return t.join(' || ').slice(-4000);
      }
      // ④ main 尾部兜底
      const main = document.querySelector('main');
      return main ? (main.innerText||'').slice(-3000) : '';
    }
    const lastText = String(snap?.lastText || grabText()).trim();
    const stop = [...document.querySelectorAll('button[aria-label]')].some(b => /^(停止|stop)$/i.test(b.getAttribute('aria-label')||'') && b.getBoundingClientRect().width>0);
    return {
      settings: s,
      plan,
      taskStatus: snap?.taskStatus || rt?.taskStatus || null,
      threadId: snap?.threadId || rt?.threadId || null,
      turnId: snap?.turnId || rt?.turnId || null,
      lastText,
      hasStop: stop,
      activeThread: snap?.planThreadId || rt?.planActiveThreadId || rt?.threadId || null,
      sessionKey: snap?.sessionKey || rt?.sessionKey || null,
      sessionId: snap?.sessionId || rt?.sessionId || null,
      sessionTitle: snap?.sessionTitle || rt?.sessionTitle || null,
      auditRequest: localStorage.getItem("codex429Guardian.auditRequest.v1"),
      credentialRequest: localStorage.getItem("codex429Guardian.credentialRequest.v1"),
      deliveryRequest: localStorage.getItem("codex429Guardian.deliveryRequest.v1"),
      deliveryState: localStorage.getItem("codex429Guardian.deliveryState.v1"),
    };
  })()`);

  let s = state?.settings || {};
  let reqTs = 0;
  let reqText = "";
  let reqChat = null;
  try {
    const rj = state.auditRequest ? JSON.parse(state.auditRequest) : null;
    reqTs = rj?.ts || 0;
    reqText = (rj?.custom || rj?.chat) ? String(rj.text || "") : "";
    if (rj?.chat) reqChat = { history: Array.isArray(rj.history) ? rj.history : [], text: String(rj.text || "") };
  } catch (_) {}
  const requested = reqTs > 0;
  try {
    s = await migrateLegacyCredential(cdp, s);
  } catch (error) {
    await appendLog(cdp, "err", "旧 API Key 迁移 Keychain 失败：" + String(error.message || error).slice(0, 100), { tag: "credential", mode: "credential" });
  }
  await handleCredentialRequest(cdp, state.credentialRequest);
  const planTid = state.activeThread || state.threadId || "default";
  const memoryKey = state.sessionKey || state.sessionId || planTid;
  const sessionIdentity = {
    sessionId: state.sessionId || `session:${String(memoryKey).replace(/^s_/, "")}`,
    memoryKey,
    sessionTitle: state.sessionTitle || "未命名会话",
  };
  const plan = state.plan?.[planTid] || { entries: [], index: 0, delaySeconds: 30 };
  const projectRoot = String(s.projectRoot || "").trim();
  const reviewSourceText = reqText || state.lastText || "";

  if (projectRoot && (s.steward || s.stewardAuto) && memoryKey !== lastMemorySessionKey) {
    try {
      persistSessionMemory({ projectRoot, identity: sessionIdentity, sourceText: reviewSourceText, projectCtx: { docs: [] }, planEntries: plan.entries || [] });
      lastMemorySessionKey = memoryKey;
    } catch (error) {
      log("会话记忆目录初始化失败", error.message);
    }
  }

  const deliveryContext = {
    settings: s,
    projectRoot,
    tid: memoryKey,
    sourceText: reviewSourceText,
    planEntries: (plan.entries || []).slice(0, 20),
  };
  if (projectRoot) {
    if (state.deliveryRequest) {
      const deliveryResult = await handleDeliveryRequest(cdp, state.deliveryRequest, deliveryContext);
      log("交付请求结果", deliveryResult);
      return;
    }
    await refreshDeliveryState(cdp, deliveryContext).catch((error) => log("交付状态刷新失败", error.message));
  } else if (state.deliveryRequest) {
    await cdp.eval(`localStorage.removeItem(${JSON.stringify(DELIVERY_REQUEST_KEY)})`).catch(() => {});
    await writeDeliveryState(cdp, { state: "needs-work", lastAction: "project-root-required", lastError: "Project root is not configured" });
  }

  const forced = process.argv.includes("--force") || requested;
  // 跟踪输出变化（无论是否强制，都用于判断稳定性）
  const outHash = textHash(state.lastText);
  const nowTs = Date.now();
  if (outHash !== lastOutputHash) {
    lastOutputHash = outHash;
    lastOutputChangedAt = nowTs;
  }
  const outputLen = String(state.lastText || "").replace(/\s+/g, "").length;
  const settled = lastOutputChangedAt > 0 && nowTs - lastOutputChangedAt >= SETTLE_MS;

  if (!forced) {
    // 无人值守模式：stewardAuto 开启即可自动审核；否则要求 steward 开
    if (!s.stewardAuto && !s.steward) return;
    if (state.hasStop) return;                    // 任务在跑
    if (state.taskStatus !== "completed") return; // 只在完成态审核
    // v1.9.15：输出不完整 / 仍在变化 -> 等，不拿半截结果做归纳
    if (outputLen < MIN_RESULT_CHARS) return;
    if (!settled) return;
  } else if (requested) {
    // 手动请求已受理，清掉标志避免重复触发
    await cdp.eval(`localStorage.removeItem(${JSON.stringify(REQ_KEY)})`).catch(() => {});
  }
  if (!s.llmModel || !normalizeProfiles(s, {}).some((profile) => profile.enabled && profile.model)) { log("未配置 LLM，跳过"); return; }

  // v1.9.27：对话模式——与管家模型直接对话，用于纠正与追问，不写计划板
  if (reqChat) {
    const history = reqChat.history.slice(-10).map((m) => (m.role === "user" ? "用户：" : "管家：") + String(m.text || "")).join("\n");
    // v1.9.29：对话也要带真实项目上下文（目录树 + 文档摘要），否则无法解释代码细节
    const chatRoot = String(s.projectRoot || "").trim();
    const chatTid = memoryKey;
    const chatCtx = buildProjectContextCached(chatRoot, reqChat.text, chatTid);
    if (chatRoot) persistSessionMemory({ projectRoot: chatRoot, identity: sessionIdentity, sourceText: reqChat.text, projectCtx: chatCtx, planEntries: plan.entries || [] });
    let ctxPart = "项目目录：" + (chatRoot || "(未配置)");
    if (chatCtx.ok) {
      ctxPart += "\n\n【目录结构】\n" + String(chatCtx.tree || "").slice(0, 3000);
      if (chatCtx.docs.length) {
        ctxPart += "\n\n【相关文档】";
        for (const d of chatCtx.docs.slice(0, 3)) {
          ctxPart += "\n--- " + d.file + " ---\n" + String(d.text || "").slice(0, 4000);
        }
      }
    }
    // 附上本会话最近的主任务输出，便于解释具体实现
    if (state.lastText) ctxPart += "\n\n【最近主任务输出】\n" + String(state.lastText).slice(0, 6000);

    const chatPrompt = [
      `当前绑定会话：${sessionIdentity.sessionTitle}（${memoryKey}）`,
      "你是 Codex Guardian 的审核管家。用户在与你对话，可以纠正你的判断、补充信息、追问理由。",
      "回答要求：简洁、直接、中文；涉及项目事实时优先引用下面材料中出现的内容；材料里确实没有就明确说没有，不要编。",
      "",
      "【项目上下文】",
      ctxPart,
      "",
      "【最近对话】",
      history,
      "",
      "请回应用户最新这条消息：",
      reqChat.text,
    ].join("\n");
    log("对话请求", { len: chatPrompt.length });
    await trace(cdp, "对话·调用 LLM", String(reqChat.text || "").slice(0, 40), "call");
    try {
      const reply = await callLlm(s, chatPrompt);
      await cdp.eval(`window.__codex429ChatReply && window.__codex429ChatReply(${JSON.stringify(reply.slice(0, 2000))})`).catch(() => {});
      if (chatRoot) persistSessionMemory({ projectRoot: chatRoot, identity: sessionIdentity, sourceText: reqChat.text, projectCtx: chatCtx, planEntries: plan.entries || [], summary: reply });
      await trace(cdp, "对话·已回复", reply.slice(0, 60).replace(/\n/g, " "), "ok");
      await appendLog(cdp, "info", "对话回复：" + reply.slice(0, 80).replace(/\n/g, " "), { mode: "chat" });
    } catch (e) {
      await cdp.eval(`window.__codex429ChatReply && window.__codex429ChatReply(${JSON.stringify("调用失败：" + e.message)})`).catch(() => {});
      await appendLog(cdp, "err", "对话调用失败：" + e.message, { tag: errorTag(e.message) });
    }
    return;
  }

  const turnId = state.turnId || "unknown";
  if (!forced) {
    const lastAudit = await cdp.eval(`localStorage.getItem(${JSON.stringify(AUDIT_KEY)})`);
    if (lastAudit === turnId) return;           // 这一轮已审过
  }

  // v1.9.16：会话隔离优先——sessionKey 基于首条消息指纹，同一项目下不同对话不会串台

  // 防自我繁殖（v1.8.57）：计划板里已有未执行的管家指令时，不再自动审核。
  // 否则「审核 → 写计划 → 执行 → 再审核」会无限追加重复条目。
  if (!requested) {
    const pendingSteward = (plan.entries || []).some((e) => !e.done && /^【/.test(String(e.text || "")));
    if (pendingSteward) return;
  }

  const planEntries = (plan.entries || []).slice(0, 20);
  const projectStatus = `任务状态 ${state.taskStatus}；计划板 ${planEntries.filter(e => e.done).length}/${planEntries.length} 段已完成；当前会话「${sessionIdentity.sessionTitle}」，会话编号 ${memoryKey}，计划绑定 ${planTid}。`;

  const mode = s.stewardMode || "review";

  // 项目上下文：读目录结构 + README/HANDOFF 等文档 + 会话里提到的 md
  const projectCtx = buildProjectContextCached(projectRoot, reviewSourceText, memoryKey);
  const qualitySupportText = projectCtx.ok
    ? [String(projectCtx.tree || "")].concat((projectCtx.docs || []).map((doc) => doc.file + "\n" + String(doc.text || ""))).join("\n").slice(0, 12000)
    : "";
  if (projectRoot) persistSessionMemory({ projectRoot, identity: sessionIdentity, sourceText: reviewSourceText, projectCtx, planEntries });
  if (projectCtx.ok) {
    await trace(cdp, projectCtx.cacheHit ? "上下文缓存命中" : "上下文缓存重建",
      "tree " + String(projectCtx.tree || "").split("\n").filter(Boolean).length + " 项 / docs " + projectCtx.docs.length + " 个",
      projectCtx.cacheHit ? "ok" : "read");
    await trace(cdp, "目录+文档", "tree " + String(projectCtx.tree || "").split("\n").filter(Boolean).length + " 项 / docs " + projectCtx.docs.length + " 个", "read");
    if (projectCtx.docs.length) {
      await trace(cdp, "读取文档", projectCtx.docs.map((d) => d.file).join(", "), "read");
    }
  } else {
    await trace(cdp, "项目上下文不足", projectCtx.reason || "", "err");
  }
  if (projectRoot) {
    log("项目上下文", projectCtx.ok
      ? `tree=${projectCtx.tree.split("\n").length}行 docs=${projectCtx.docs.length}个`
      : "不足：" + projectCtx.reason);
  } else {
    log("未配置项目目录，管家只能基于会话文本归纳");
  }

  const prompt = reqText
    ? buildPrompt({
        mainOutput: reqText,
        projectStatus,
        planEntries,
        mode,
        projectCtx,
        projectGoal: extractProjectGoal(projectCtx),
      }) + "\n\n【本次为自定义指令，请围绕上面的指令作答，但所有结论必须能在上面的项目材料中找到依据】"
    : buildPrompt({ mainOutput: state.lastText, projectStatus, planEntries, mode, projectCtx, projectGoal: extractProjectGoal(projectCtx) });

  // 去重：同 prompt 10 分钟内不重复调用（防止同因反复触发）
  const promptHash = shortHash(prompt);
  const recent = await cdp.eval(`(function(){
    try { return JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(LOG_KEY)})) || []); } catch(_) { return "[]"; }
  })()`);
  let dup = false;
  try {
    const arr = JSON.parse(recent);
    const cutoff = Date.now() - 10 * 60 * 1000;
    dup = arr.some((e) => (e.ts || 0) > cutoff && e.hash === promptHash && e.kind === "ok");
  } catch (_) {}
  if (dup) {
    log("跳过：10 分钟内已有相同审核", { promptHash });
    await appendLog(cdp, "dup", "相同审核在 10 分钟内已执行，跳过", { hash: promptHash });
    return;
  }

  log("触发审核", { turnId, mode, session: memoryKey, sessionTitle: sessionIdentity.sessionTitle, planTid, promptHash });
  await trace(cdp, "读取主任务输出", String(reviewSourceText || "").length + " 字", "read");
  await trace(cdp, "读取项目上下文", projectRoot || "(未配置项目目录)", "read");
  let reply;
  const llmStart = Date.now();
  await trace(cdp, "调用 LLM", (s.llmModel || "?") + " / prompt " + prompt.length + " 字", "call");
  try {
    reply = await callLlm(s, prompt);
    await trace(cdp, "Provider链路", `${lastProviderInfo?.profileId || "?"} / ${lastProviderInfo?.provider || "?"} / attempts ${lastProviderInfo?.attempts?.length || 0}`, "call");
    await trace(cdp, "LLM 返回", Math.round((Date.now() - llmStart) / 1000) + "s / " + reply.length + " 字", "ok");
    log("LLM 返回", reply.slice(0, 80).replace(/\n/g, " "));
  } catch (e) {
    const tag = errorTag(e.message);
    log("LLM 失败:", e.message, "tag=" + tag);
    await appendLog(cdp, "err", "LLM 调用失败：" + e.message, { tag, hash: promptHash, mode });
    return;
  }

  // 2. 解析 + 写回计划板
  const parsed = core.parseStewardSideOutput(reply);
  // 控制指令必须先于普通计划解析处理，否则会被格式重试误吞。
  const control = core.parseStewardControlDirective ? core.parseStewardControlDirective(reply) : null;
  if (control) {
    let guide = "";
    let label = "会话总结";
    if (control.kind === "summary") {
      const mdPath = projectRoot ? path.join(sessionDir(projectRoot, memoryKey), "SESSION-STATE.md") : "SESSION-STATE.md";
      guide = "【管家】当前材料不足以判断下一步。请先把本次会话状态写成 " + mdPath +
        "，必须包含：1) 本会话目标 2) 已完成内容（含文件） 3) 未完成/阻塞 4) 关键决策 5) 建议下一步。" +
        (control.text ? " 额外要求：" + control.text : "");
    } else {
      const mdPath = projectRoot ? path.join(sessionDir(projectRoot, memoryKey), "REA-EVIDENCE.md") : "REA-EVIDENCE.md";
      label = "探测";
      guide = "【管家·探测】现有材料不足以完整落地，请先用 rea 探测：" + control.text.replace(/\s+/g, " ") +
        " 然后把探测到的实现依据写入 " + mdPath +
        "（包含：涉及文件、关键函数/数据结构、调用链、可落地的最小改动点）。写完后我会读取该 md 再给出落地指令。";
    }
    await trace(cdp, control.kind === "summary" ? "需要会话总结" : "需要证据探测", control.text.slice(0, 80), "write");
    const appliedControl = await cdp.eval(`(function(){
      const g = window.__CODEX_429_GUARDIAN__;
      if (g && typeof g.applyStewardPlan === "function") {
        return JSON.stringify(g.applyStewardPlan({ fixes: null, nextPlan: ${JSON.stringify(guide)}, label: ${JSON.stringify(label)}, threadId: ${JSON.stringify(planTid)}, sessionId: ${JSON.stringify(sessionIdentity.sessionId)}, sessionKey: ${JSON.stringify(memoryKey)}, sessionTitle: ${JSON.stringify(sessionIdentity.sessionTitle)}, summary: ${JSON.stringify(guide)} }, ${plan.delaySeconds || 30}));
      }
      return "NO_API";
    })()`).catch(() => "ERR");
    await cdp.eval(`localStorage.setItem(${JSON.stringify(AUDIT_KEY)}, ${JSON.stringify(turnId)})`).catch(() => {});
    await appendLog(cdp, "info", control.kind === "summary" ? "材料不足，已要求主会话输出会话状态 md" : "证据不足，已要求主会话输出 REA-EVIDENCE.md", { mode });
    log("控制指令已写回", appliedControl);
    return;
  }

  await trace(cdp, "解析结果", (parsed.fixes ? "有短板段 " : "") + (parsed.nextPlan ? "有下一步段" : "无可解析段"), parsed.has ? "ok" : "err");
  if (!parsed.has) {
    // v1.9.5：格式异常自动重试一次（更严格的 prompt），失败才写错误日志
    log("回复无可解析段落，尝试重试一次（严格格式）");
    const strictPrompt =
      "你上一轮回复没有按要求分段。请只输出下面两段，不要任何前言/解释/代码块：\n" +
      "## 关键短板\n<1-3 条，无则写「无」>\n" +
      "## 下一步计划\n<3-5 条，动词开头，指明文件，可验证>";
    let retryReply = "";
    try {
      retryReply = await callLlm(s, strictPrompt + "\n\n原始任务输出摘要：\n" + String(reviewSourceText || "").slice(0, 5000));
    } catch (e2) {
      const tag2 = errorTag(e2.message);
      await appendLog(cdp, "err", "重试仍失败：" + e2.message, { tag: tag2, hash: promptHash, mode, retry: true });
      log("重试失败:", e2.message);
      return;
    }
    const retryParsed = core.parseStewardSideOutput(retryReply);
    if (retryParsed.has) {
      log("重试成功", retryReply.slice(0, 60).replace(/\n/g, " "));
      await appendLog(cdp, "info", "格式异常已通过重试修复", { hash: promptHash, mode });
      reply = retryReply;
      Object.assign(parsed, retryParsed);
    } else {
      log("重试仍无可解析段落，跳过写回");
      await appendLog(cdp, "err", "LLM 两轮回复均无可解析段落（缺「下一步计划」标题）", { tag: "format", hash: promptHash, mode, retried: true });
      await cdp.eval(`localStorage.setItem(${JSON.stringify(AUDIT_KEY)}, ${JSON.stringify(turnId)})`).catch(() => {});
      return;
    }
  }
  // v1.9.9：指令必须带依据，禁止凭空生成
  const hasEvidence = /依据/.test(String(reply));
  if (!hasEvidence) {
    log("回复缺少依据，拒绝写回并重试");
    await appendLog(cdp, "err", "本轮审核缺少「依据」，已拒绝写回计划板", { tag: "noevidence", hash: promptHash, mode });
    let strictReply = "";
    try {
      strictReply = await callLlm(s,
        "你上一条回复没有给出依据。请重新输出，只输出下面格式，每条必须带【依据】：\n" +
        "## 关键短板\n1. 【依据】<具体文件/函数/日志片段> → 【问题】<...>\n" +
        "## 下一步计划\n1. 【依据】<...> → 【动作】<...> → 【验收】<...>");
    } catch (e3) {
      await appendLog(cdp, "err", "依据重试失败：" + e3.message, { tag: errorTag(e3.message), mode });
      return;
    }
    if (!/依据/.test(strictReply)) {
      await appendLog(cdp, "err", "重试仍无依据，已放弃写回", { tag: "noevidence", mode, retried: true });
      log("重试仍无依据，放弃");
      return;
    }
    reply = strictReply;
    Object.assign(parsed, core.parseStewardSideOutput(strictReply));
    log("依据重试成功");
    await appendLog(cdp, "info", "已通过重试补齐依据", { mode });
  }

  // v1.9.17：接地校验——计划里出现材料中没有的标识符，判定为幻觉，拒绝写回
  {
    const ground = ungroundedTokens(planGroundingPart(parsed.nextPlan), prompt);
    if (ground.total >= 3 && ground.ratio > 0.5) {
      log("接地校验未通过", { total: ground.total, unknown: ground.unknown.slice(0, 6), ratio: ground.ratio.toFixed(2) });
      await appendLog(cdp, "err", "计划接地校验未通过（疑似幻觉）：" + ground.unknown.slice(0, 5).join(", "), { tag: "ungrounded", mode, unknown: ground.unknown.slice(0, 5) });
      let retry = "";
      try {
        retry = await callLlm(s,
          "你上一条计划引用了材料中不存在的内容。请重新输出，所有条目必须只引用下面材料里出现过的文件名/函数名/字段名。\n\n" + prompt);
      } catch (e4) {
        await appendLog(cdp, "err", "接地重试失败：" + e4.message, { tag: errorTag(e4.message), mode });
        return;
      }
      const retryParsed = core.parseStewardSideOutput(retry);
      const g2 = ungroundedTokens(String(retryParsed.nextPlan || ""), prompt);
      if (!retryParsed.has || (g2.total >= 3 && g2.ratio > 0.5)) {
        await appendLog(cdp, "err", "重试后仍不可靠，已放弃写回计划板", { tag: "ungrounded", mode, retried: true });
        log("重试后仍不可靠，放弃");
        return;
      }
      reply = retry;
      Object.assign(parsed, retryParsed);
      await appendLog(cdp, "info", "已通过重试修复接地问题", { mode });
    }
  }

  // 写回前沿用确定性质量闸门：不合格只重试一次，绝不把准备步骤当成交付。
  let quality = validateProposedPlan({ planText: parsed.nextPlan || "", sourceText: reviewSourceText, supportingText: qualitySupportText });
  if (!quality.ok) {
    const reasonText = quality.reasons.map((item) => item.message).join("；");
    await trace(cdp, "计划质量闸门", reasonText, "err");
    await appendLog(cdp, "err", "计划质量闸门拦截：" + reasonText, { tag: "plan-quality", mode, reasons: quality.reasons, plan: String(parsed.nextPlan || "").slice(0, 300) });
    const anchors = (quality.anchors || []).slice(0, 8);
    const qualityPrompt = [
      PLAN_QUALITY_RULES,
      "你上一版下一步计划未通过可靠性检查：" + reasonText + "。",
      anchors.length ? "至少直接命中这些待修复锚点之一：" + anchors.join("、") : "材料没有可提取锚点时，也必须给出单一、可验证的交付动作。",
      "只输出：## 下一步计划",
      "1. <直接交付的行为或修复>。验收：<可运行命令或可观察结果>",
      "不得只写安装依赖、升级版本、搭脚手架、初始化环境；不得偏离主任务本轮输出。",
      "",
      "【主任务本轮输出】",
      String(reviewSourceText || "").slice(0, 5000),
      qualitySupportText ? "\n【项目文档与结构】\n" + qualitySupportText.slice(0, 10000) : "",
    ].join("\n");
    let qualityReply = "";
    try {
      qualityReply = await callLlm(s, qualityPrompt);
    } catch (e5) {
      await appendLog(cdp, "err", "计划质量重试失败：" + e5.message, { tag: errorTag(e5.message), mode, retried: true });
      await cdp.eval(`localStorage.setItem(${JSON.stringify(AUDIT_KEY)}, ${JSON.stringify(turnId)})`).catch(() => {});
      return;
    }
    const qualityParsed = core.parseStewardSideOutput(qualityReply);
    quality = validateProposedPlan({ planText: qualityParsed.nextPlan || "", sourceText: reviewSourceText, supportingText: qualitySupportText });
    const retryGround = ungroundedTokens(planGroundingPart(qualityParsed.nextPlan), prompt);
    if (!qualityParsed.nextPlan || !quality.ok || (retryGround.total >= 3 && retryGround.ratio > 0.5)) {
      const why = !qualityParsed.nextPlan ? "重试未输出下一步计划" : !quality.ok ? quality.reasons.map((item) => item.message).join("；") : "重试计划疑似引用材料外内容";
      await trace(cdp, "计划质量重试未通过", why, "err");
      await appendLog(cdp, "err", "计划质量重试未通过，已拒绝写回：" + why, { tag: "plan-quality", mode, retried: true, unknown: retryGround.unknown.slice(0, 8), plan: String(qualityParsed.nextPlan || "").slice(0, 300) });
      await cdp.eval(`localStorage.setItem(${JSON.stringify(AUDIT_KEY)}, ${JSON.stringify(turnId)})`).catch(() => {});
      return;
    }
    parsed.nextPlan = qualityParsed.nextPlan;
    await trace(cdp, "计划质量重试通过", String(parsed.nextPlan).slice(0, 100), "ok");
    await appendLog(cdp, "info", "计划质量闸门已通过重试修复", { mode, coveredAnchors: quality.coveredAnchors });
  }

  const type = core.stewardReviewTypeById ? core.stewardReviewTypeById(mode) : { planLabel: "下一步" };

  const next = core.appendStewardPlan(plan, parsed, type.planLabel || "下一步");

  // 把新条目设为下一条待导入
  const newFirst = (next.entries || []).findIndex((e) => !e.done);
  if (newFirst >= 0) next.index = newFirst;

  // 3. 交给页面自己写计划板 + 排倒计时（避免与页面内存副本冲突）
  // 项目理解不足时，追加一条「先产出项目状态 md」的引导指令（v1.8.58）
  // v1.9.14：依据只留在日志，写进计划板的是干净指令
  let nextPlanText = core.stripEvidenceForPlan(parsed.nextPlan || "");
  if (!nextPlanText) nextPlanText = null;
  if (!projectCtx.ok) {
    const mdName = "PROJECT-STATE.md";
    const where = projectRoot ? path.join(sessionDir(projectRoot, memoryKey), mdName) : mdName;
    const guide =
      `【管家】项目理解不足（${projectCtx.reason}）。` +
      `请先输出项目状态总结到 ${where}，必须包含五节：` +
      `1) 目录结构与模块职责 2) 当前已完成能力 3) 已知短板与风险 4) 关键入口文件 5) 下一步候选任务（按优先级）。` +
      `写完后我会读取该 md 再做进一步规划。`;
    // v1.9.23：材料不足时只保留「先产出状态 md」这一条，避免同时给出无依据的计划
    nextPlanText = guide;
    log("项目理解不足，已追加产出 md 的引导指令");
  }

  const applied = await cdp.eval(`(function(){
    const g = window.__CODEX_429_GUARDIAN__;
    if (g && typeof g.applyStewardPlan === "function") {
      return JSON.stringify(g.applyStewardPlan(
        { fixes: ${JSON.stringify(parsed.fixes || null)}, nextPlan: ${JSON.stringify(nextPlanText)}, label: ${JSON.stringify(type.planLabel || "下一步")}, threadId: ${JSON.stringify(planTid)}, sessionId: ${JSON.stringify(sessionIdentity.sessionId)}, sessionKey: ${JSON.stringify(memoryKey)}, sessionTitle: ${JSON.stringify(sessionIdentity.sessionTitle)}, summary: ${JSON.stringify(reply)} },
        ${plan.delaySeconds || 10}
      ));
    }
    return "NO_API";
  })()`);
  await cdp.eval(`localStorage.setItem(${JSON.stringify(AUDIT_KEY)}, ${JSON.stringify(turnId)})`).catch(() => {});
  log("页面写回结果", applied);
  if (projectRoot) {
    try {
      persistSessionMemory({ projectRoot, identity: sessionIdentity, sourceText: reviewSourceText, projectCtx, planEntries: next.entries || [], summary: reply });
    } catch (error) {
      log("管家总结落盘失败", error.message);
    }
  }
  await trace(cdp, "写入计划板", String(applied).slice(0, 120), "write");
  // 日志里显式记录「依据 → 指令」，可回溯
  const evidenceSrc = parsed.risks || (String(reply).match(/##\s*关键短板\s*\n([\s\S]*?)(?=\n##\s|$)/) || [])[1] || "";
  const evidenceOneLine = String(evidenceSrc)
    .replace(/\s+/g, " ")
    .replace(/^(?:依据[:：]\s*)+/i, "")   // v1.9.25：去掉重复的「依据：」前缀
    .trim()
    .slice(0, 180);
  const planOneLine = String(parsed.nextPlan || "").replace(/\s+/g, " ").trim().slice(0, 180);
  await appendLog(cdp, "ok", "依据：" + (evidenceOneLine || "(见回复)") + " ｜ 指令：" + (planOneLine || "(无)"), { hash: promptHash, mode });

  log("已写回计划板", { session: memoryKey, sessionTitle: sessionIdentity.sessionTitle, planTid, index: next.index, entries: next.entries.length });
  await refreshDeliveryState(cdp, {
    settings: s,
    projectRoot,
    tid: memoryKey,
    sourceText: reviewSourceText,
    planEntries: (next.entries || []).slice(0, 20),
  }).catch((error) => log("交付状态刷新失败", error.message));
}

async function main() {
  log("管家守护进程启动");
  let cdp = null;
  let lastPageKey = "";
  let failStreak = 0;
  let lastLoggedErr = "";
  for (;;) {
    let wait = POLL_MS;
    try {
      const page = await pickPageTarget();
      const key = page.id + page.webSocketDebuggerUrl;
      if (!cdp || key !== lastPageKey) {
        cdp?.close();
        cdp = new Cdp(page.webSocketDebuggerUrl);
        await cdp.connect();
        lastPageKey = key;
        if (failStreak > 0) log("已恢复连接（此前连续失败 " + failStreak + " 次）");
        else log("已连上 Codex 页面");
        failStreak = 0;
        lastLoggedErr = "";
      }
      await tick(cdp);
      failStreak = 0;
      lastLoggedErr = "";
    } catch (e) {
      failStreak += 1;
      const msg = String(e?.message || e).slice(0, 120);
      // 同一错误只在首次记录，避免 CDP 断开期间刷屏
      if (msg !== lastLoggedErr) {
        log("轮询异常:", msg, failStreak > 1 ? "(连续 " + failStreak + " 次，进入退避)" : "");
        lastLoggedErr = msg;
      }
      try { cdp?.close(); } catch {}
      cdp = null;
      lastPageKey = "";
      // 指数退避：3s → 6s → 12s → 24s → 30s 封顶
      wait = Math.min(30000, POLL_MS * Math.pow(2, Math.min(failStreak - 1, 4)));
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

export { buildProjectContext, collectProjectDocs, collectReferencedMds, sessionDir, persistSessionMemory, buildPrompt, extractProjectGoal, textHash, errorTag };

if (process.argv.includes("--once")) {
  (async () => {
    const page = await pickPageTarget();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await tick(cdp);
    cdp.close();
    process.exit(0);
  })().catch((e) => { console.error("失败:", e.message); process.exit(1); });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // v1.9.17：用 pathToFileURL 比较，兼容含中文/空格的路径（之前字符串拼接在中文路径下永远不相等）
  main();
}
