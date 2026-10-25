import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  derivePolicyChecks,
  computeDeliveryDecision,
  summarizeProviderFailure,
  persistSessionMemory,
  collectReferencedMds,
} from "../scripts/steward-daemon.mjs";

test("derivePolicyChecks passes verification only when observable verification exists", () => {
  const missing = derivePolicyChecks({
    taskLevel: "feature",
    sourceText: "Implemented export in src/export.js",
    changedPaths: ["src/export.js"],
    backupVerified: false,
  });
  assert.equal(missing.find((check) => check.id === "verification").status, "unknown");

  const verified = derivePolicyChecks({
    taskLevel: "feature",
    sourceText: "Implemented export in src/export.js. npm test: 12/12 passed.",
    changedPaths: ["src/export.js", "README.md"],
    backupVerified: false,
  });
  assert.equal(verified.find((check) => check.id === "verification").status, "pass");
  assert.equal(verified.find((check) => check.id === "documentation").status, "pass");
});

test("high-risk delivery remains blocked without regression and recovery evidence", () => {
  const decision = computeDeliveryDecision({
    taskLevel: "high-risk",
    sourceText: "Implemented login migration",
    changedPaths: ["src/auth.js"],
    planEntries: [{ text: "Implement login migration", done: true }],
    reviewErrors: [],
    backupVerified: true,
  });
  assert.equal(decision.deliveryState, "needs-work");
  assert.ok(decision.blockingIssues.some((issue) => issue.code === "missing-check"));
});

test("summarizeProviderFailure never leaks credentials and keeps failure codes", () => {
  const summary = summarizeProviderFailure({
    attempts: [
      { profileId: "primary", failure: "auth", model: "m" },
      { profileId: "backup", failure: "upstream", model: "m2" },
    ],
    secret: "must-not-appear",
  });
  assert.equal(summary, "primary:auth, backup:upstream");
  assert.ok(!summary.includes("must-not-appear"));
});

test("session memory persists identity, latest context, and steward summary in one folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-session-"));
  const identity = {
    sessionId: "session:abc",
    memoryKey: "s_abc",
    sessionTitle: "会话测试",
  };
  const result = persistSessionMemory({
    projectRoot: root,
    identity,
    sourceText: "主会话最新完成结果",
    projectCtx: { docs: [{ file: "README.md" }] },
    planEntries: [{ text: "下一步实现", done: false }],
    summary: "管家总结与下一步计划",
    now: 1700000000000,
  });
  assert.equal(result.dir, path.join(root, ".guardian", "sessions", "s_abc"));
  assert.ok(fs.existsSync(path.join(result.dir, "SESSION.json")));
  assert.ok(fs.existsSync(path.join(result.dir, "SESSION-STATE.md")));
  assert.match(fs.readFileSync(path.join(result.dir, "SESSION-STATE.md"), "utf8"), /s_abc/);
  assert.match(fs.readFileSync(path.join(result.dir, "LATEST-CONTEXT.md"), "utf8"), /主会话最新完成结果/);
  assert.match(fs.readFileSync(path.join(result.dir, "STEWARD-SUMMARY.md"), "utf8"), /管家总结与下一步计划/);
  const meta = JSON.parse(fs.readFileSync(path.join(result.dir, "SESSION.json"), "utf8"));
  assert.equal(meta.sessionTitle, "会话测试");
  assert.equal(meta.sessionId, "session:abc");
  fs.rmSync(root, { recursive: true, force: true });
});

test("referenced markdown never crosses into another session memory folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-scope-"));
  const own = path.join(root, ".guardian", "sessions", "s_own");
  const other = path.join(root, ".guardian", "sessions", "s_other");
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(own, "SESSION-STATE.md"), "own");
  fs.writeFileSync(path.join(other, "SESSION-STATE.md"), "other");
  const text = `${path.join(own, "SESSION-STATE.md")} ${path.join(other, "SESSION-STATE.md")}`;
  const docs = collectReferencedMds(text, root, "s_own");
  assert.equal(docs.length, 1);
  assert.match(docs[0].file, /s_own/);
  fs.rmSync(root, { recursive: true, force: true });
});
