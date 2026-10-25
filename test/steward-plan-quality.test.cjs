const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../guardian.js");

test("extracts only concrete anchors from blocked/unfinished statements", () => {
  const source = [
    "README.md 已承诺支持 --dry-run，但 src/main.rs 没有实现。",
    "docs/ROADMAP.md 标记为未完成。",
    "普通说明：数据库已经初始化。",
  ].join("\n");
  const anchors = core.extractPendingPlanAnchors(source);
  for (const expected of ["--dry-run", "src/main.rs", "main.rs", "README.md", "docs/ROADMAP.md", "ROADMAP.md"]) {
    assert.ok(anchors.includes(expected), expected);
  }
  assert.ok(!anchors.includes("数据库已经初始化"));
});

test("rejects dependency-only plan that misses the promised CLI behavior", () => {
  const source = "README.md 已承诺支持 --dry-run，但 src/main.rs 没有实现。";
  const assessment = core.assessStewardPlanQuality(
    "1. 在 Cargo.toml 引入 clap 依赖并更新至最新版本",
    source,
  );
  assert.equal(assessment.ok, false);
  assert.deepEqual(
    assessment.reasons.map((item) => item.code),
    ["anchor", "acceptance", "unsafe-upgrade", "behavior", "prep-only"],
  );
});

test("rejects a CLI flag plan whose acceptance only proves help/build", () => {
  const source = "README.md 已承诺支持 --dry-run，但 src/main.rs 没有实现。";
  const assessment = core.assessStewardPlanQuality(
    "1. 在 src/main.rs 定义 --dry-run 布尔参数。验收：cargo build 成功且 --help 显示 dry-run",
    source,
  );
  assert.equal(assessment.ok, false);
  assert.ok(assessment.reasons.some((item) => item.code === "behavior"));
});

test("accepts a direct behavior change with observable acceptance", () => {
  const source = "README.md 已承诺支持 --dry-run，但 src/main.rs 没有实现。";
  const assessment = core.assessStewardPlanQuality(
    "1. 在 src/main.rs 实现 --dry-run。验收：cargo run -- --dry-run 只打印计划且不写文件",
    source,
  );
  assert.equal(assessment.ok, true);
  assert.deepEqual(assessment.reasons, []);
  assert.ok(assessment.coveredAnchors.includes("--dry-run"));
  assert.ok(assessment.coveredAnchors.includes("src/main.rs"));
});

test("accepts a document repair plan that hits a broken-link anchor", () => {
  const source = "docs/reference 中有 18 个内部链接失效，阻断发布。";
  const assessment = core.assessStewardPlanQuality(
    "1. 修复 docs/reference 的失效链接。验收：npm run docs:build 无死链且页面可打开",
    source,
  );
  assert.equal(assessment.ok, true);
});

test("rejects plans without an explicit acceptance criterion", () => {
  const assessment = core.assessStewardPlanQuality("1. 修复用户登录逻辑", "");
  assert.equal(assessment.ok, false);
  assert.equal(assessment.reasons[0].code, "acceptance");
});

test("control directives are parsed before ordinary plan formatting", () => {
  assert.deepEqual(core.parseStewardControlDirective("## 需要会话总结\n需要接口清单和失败案例"), {
    kind: "summary",
    text: "需要接口清单和失败案例",
  });
  assert.deepEqual(core.parseStewardControlDirective("## 需要探测\n1. 探测 src/api/users.js 的调用链"), {
    kind: "probe",
    text: "1. 探测 src/api/users.js 的调用链",
  });
  assert.equal(core.parseStewardControlDirective("## 下一步计划\n1. 实现功能"), null);
});

test("plan scheduling prefers a matching session fingerprint over the transient sidebar id", () => {
  assert.equal(core.preferredPlanThreadId("local:abc", "fp:stable", { "fp:stable": { entries: [] } }), "local:abc");
  assert.equal(core.preferredPlanThreadId("local:abc", "fp:missing", { "local:abc": { entries: [] } }), "local:abc");
  assert.equal(core.preferredPlanThreadId(null, null, {}), null);
});
