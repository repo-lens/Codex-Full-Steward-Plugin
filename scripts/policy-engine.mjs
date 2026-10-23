import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../guardian.js");

const HIGH_RISK_PATTERNS = [
  /\bauth(?:entication|orization)?\b/i,
  /\blogin\b/i,
  /\bpayment|billing\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\bdelete|destroy|drop\s+table\b/i,
  /权限|鉴权|登录|支付|账单|数据迁移|删除|销毁/i,
];

const MICRO_PATH_PATTERN = /(?:^README(?:\.[^/]*)?$|^docs\/|(?:^|\/)[^/]+\.md$|(?:^|\/)[^/]+\.(?:json|ya?ml|toml)$)/i;

function normalizeChangedPaths(paths) {
  return Array.isArray(paths) ? paths.map((value) => String(value || "").replace(/\\/g, "/")) : [];
}

export function classifyTask({ taskText = "", changedPaths = [] } = {}) {
  const text = String(taskText || "");
  const paths = normalizeChangedPaths(changedPaths);
  const highRiskReason = HIGH_RISK_PATTERNS.find(
    (pattern) => pattern.test(text) || paths.some((item) => pattern.test(item)),
  );
  if (highRiskReason) {
    return { level: "high-risk", reasons: ["security, data, or destructive-change signal"] };
  }

  const hasBehaviorChange = paths.some((item) => item && !MICRO_PATH_PATTERN.test(item));
  const textRequestsBehavior = /\badd|implement|feature|fix|change\b|新增|实现|开发|修复|改造|功能/i.test(text);
  if (hasBehaviorChange || textRequestsBehavior) {
    return { level: "feature", reasons: ["behavior or implementation change"] };
  }
  return { level: "micro", reasons: ["documentation or metadata-only change"] };
}

export function requiredChecksFor(level) {
  const checks = [
    { id: "implementation", title: "Implementation evidence exists", required: true },
    { id: "verification", title: "Observable verification exists", required: true },
  ];
  if (level === "feature" || level === "high-risk" || level === "delivery") {
    checks.push({ id: "documentation", title: "Relevant documentation is current", required: true });
  }
  if (level === "high-risk" || level === "delivery") {
    checks.push(
      { id: "regression", title: "Regression verification exists", required: true },
      { id: "recovery", title: "Rollback or recovery path exists", required: true },
    );
  }
  if (level === "delivery") {
    checks.push({ id: "backup", title: "Verified delivery backup exists", required: true });
  }
  return checks;
}

export function evaluateDeliveryReadiness({
  taskLevel = "feature",
  planEntries = [],
  reviewErrors = [],
  checks = [],
  backupVerified = false,
} = {}) {
  const blockingIssues = [];
  const pendingEntries = (Array.isArray(planEntries) ? planEntries : []).filter((entry) => !entry?.done);
  if (pendingEntries.length > 0) {
    blockingIssues.push({
      code: "pending-plan",
      message: `${pendingEntries.length} required plan entr${pendingEntries.length === 1 ? "y is" : "ies are"} unfinished`,
    });
  }

  if ((Array.isArray(reviewErrors) ? reviewErrors : []).length > 0) {
    blockingIssues.push({
      code: "review-error",
      message: "The latest review contains unresolved errors",
    });
  }

  const statusById = new Map(
    (Array.isArray(checks) ? checks : []).map((check) => [check?.id, check?.status]),
  );
  for (const required of requiredChecksFor(taskLevel)) {
    if (statusById.get(required.id) !== "pass") {
      blockingIssues.push({
        code: "missing-check",
        checkId: required.id,
        message: `${required.title} is not verified`,
      });
    }
  }

  if (!backupVerified) {
    blockingIssues.push({
      code: "backup",
      message: "A verified delivery backup does not exist",
    });
  }

  const ready = blockingIssues.length === 0;
  return {
    taskLevel,
    requiredChecks: requiredChecksFor(taskLevel).map((check) => ({
      ...check,
      status: statusById.get(check.id) || "unknown",
    })),
    passedChecks: [...statusById.entries()]
      .filter(([, status]) => status === "pass")
      .map(([id]) => id),
    blockingIssues,
    missingEvidence: blockingIssues
      .filter((issue) => issue.code === "missing-check" || issue.code === "backup")
      .map((issue) => issue.checkId || issue.code),
    deliveryState: ready ? "ready-for-confirmation" : "needs-work",
    nextAction: ready ? "confirm-delivery" : "continue",
  };
}

function normalizeAcceptanceLabels(text) {
  return String(text || "")
    .replace(/\bAcceptance criteria\s*:/gi, "验收：")
    .replace(/\bAcceptance\s*:/gi, "验收：")
    .replace(/\bExpected result\s*:/gi, "期望结果：")
    .replace(/\bExpected\s*:/gi, "期望结果：");
}

export function validateProposedPlan({ planText = "", sourceText = "", supportingText = "" } = {}) {
  return core.assessStewardPlanQuality(
    normalizeAcceptanceLabels(planText),
    sourceText,
    supportingText,
  );
}

export function planPolicyCompatibility() {
  return {
    source: "guardian.js",
    exported: ["assessStewardPlanQuality", "extractPendingPlanAnchors"],
  };
}
