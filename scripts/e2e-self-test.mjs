#!/usr/bin/env node
/**
 * 管家闭环端到端自测（v1.8.56）
 *
 * 覆盖链路：页面请求标志 → 守护进程读取 → 自定义提示词注入 → LLM 返回 → 写回计划板
 *
 * 用法：node scripts/e2e-self-test.mjs
 * 退出码：0=全通过，1=有失败
 */
import http from "node:http";

const CDP = "http://127.0.0.1:9229";
const PLAN_KEY = "codex429Guardian.plan.v2";
const REQ_KEY = "codex429Guardian.auditRequest.v1";
const AUDIT_KEY = "codex429Guardian.lastAuditTurn.v1";
const MARK = "E2E-" + Date.now().toString(36);

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("CDP 连接失败"));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      };
    });
  }
  eval(expr, awaitPromise = false) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, (m) => {
        if (m?.result?.exceptionDetails) return rej(new Error(m.result.exceptionDetails.text || "eval error"));
        res(m?.result?.result?.value);
      });
      this.ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n=== 管家闭环 E2E 自测（标记 ${MARK}）===\n`);

  // --- 1. 前置：CDP 可达 ---
  let page;
  try {
    const list = await httpJson(`${CDP}/json`);
    page = list.find((t) => t.type === "page");
    ok("CDP 9229 可达", !!page);
    if (!page) throw new Error("无页面");
  } catch (e) {
    ok("CDP 9229 可达", false, e.message);
    return finish();
  }

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();

  // --- 2. 前置：guardian API 可用 ---
  // 页面刚重载时 user script 可能晚于 CDP 就绪，最多等待 10 秒。
  for (let i = 0; i < 20; i++) {
    const ready = await cdp.eval("Boolean(window.__CODEX_429_GUARDIAN__ && window.__CODEX_429_GUARDIAN__.applyStewardPlan)");
    if (ready) break;
    await sleep(500);
  }

  const hasApi = await cdp.eval(`Boolean(window.__CODEX_429_GUARDIAN__ && window.__CODEX_429_GUARDIAN__.applyStewardPlan)`);
  ok("guardian applyStewardPlan API 可用", hasApi === true);
  if (!hasApi) { cdp.close(); return finish(); }

  // --- 3. 前置：LLM 已配置 ---
  for (let i = 0; i < 10; i++) {
    const ds = await cdp.eval(`localStorage.getItem("codex429Guardian.deliveryState.v1")`);
    if (ds && ds.includes("credentialStatus")) break;
    await sleep(500);
  }
  const cfg = await cdp.eval(`(function(){
    var s = JSON.parse(localStorage.getItem("codex429Guardian.settings.v1") || "{}");
    let ds = {};
    try { ds = JSON.parse(localStorage.getItem("codex429Guardian.deliveryState.v1") || "{}"); } catch {}
    return JSON.stringify({ hasLegacyKey: !!s.llmApiKey, hasKeychain: ds.credentialStatus?.primary === true, provider: s.llmProvider || "", model: s.llmModel || "", base: s.llmBaseUrl || "", hasDeliveryApi: typeof window.__CODEX_429_GUARDIAN__?.getDeliveryState === "function" });
  })()`);
  const c = JSON.parse(cfg);
  ok("LLM 已配置", !!c.model && (c.hasLegacyKey || c.hasKeychain || c.provider === "ollama"), `model=${c.model}, keychain=${c.hasKeychain}`);
  ok("交付生命周期 API 可用", c.hasDeliveryApi === true);

  // --- 4. 清空计划板 + 清请求/审计标记 ---
  await cdp.eval(`(function(){
    var g = window.__CODEX_429_GUARDIAN__;
    g.hardClear();
    localStorage.removeItem(${JSON.stringify(REQ_KEY)});
    localStorage.removeItem(${JSON.stringify(AUDIT_KEY)});
  })()`);
  const cleared = await cdp.eval(`localStorage.getItem(${JSON.stringify(PLAN_KEY)})`);
  ok("计划板已清空", (() => {
    try { const p = JSON.parse(cleared); return Object.values(p).every(v => (v.entries || []).length === 0); }
    catch { return false; }
  })());

  // --- 5. 写入自定义提示词请求（模拟窗口「发送」按钮）---
  await cdp.eval(`localStorage.setItem(${JSON.stringify(REQ_KEY)}, JSON.stringify({ ts: Date.now(), text: "自测请求：请确认你能收到自定义提示词 ${MARK}", custom: true }))`);
  const flag = await cdp.eval(`localStorage.getItem(${JSON.stringify(REQ_KEY)})`);
  ok("自定义请求已写入", !!flag && String(flag).includes(MARK));

  // --- 6. 等守护进程消费请求并写回计划板（最多 120s）---
  let entries = [];
  let consumed = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const raw = await cdp.eval(`localStorage.getItem(${JSON.stringify(PLAN_KEY)})`);
    try {
      const p = JSON.parse(raw || "{}");
      entries = Object.values(p).flatMap((v) => (v.entries || []).map((e) => e.text));
      if (entries.length > 0) { consumed = true; break; }
    } catch {}
  }
  ok("守护进程消费请求并写回计划板", consumed, `条目数=${entries.length}`);
  ok("写回条目带类型标签", entries.some((t) => /^【/.test(t)), entries[0] ? entries[0].slice(0, 40) : "(空)");

  const reqAfter = await cdp.eval(`localStorage.getItem(${JSON.stringify(REQ_KEY)})`);
  ok("请求标志已被消费（清除）", !reqAfter);

  // --- 7. 倒计时已排定 ---
  const st = JSON.parse(await cdp.eval(`JSON.stringify((function(){ var s = window.__CODEX_429_GUARDIAN__.getState(); return { due: s.planDueAtMs, inFlight: s.planImportInFlight }; })())`));
  ok("导入倒计时已排定", Number(st.due) > 0, `due=${st.due}`);

  cdp.close();
  finish();
}

function finish() {
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("自测异常:", e.message); fail++; finish(); });
