import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  requiredChecksFor,
  evaluateDeliveryReadiness,
  validateProposedPlan,
} from "../scripts/policy-engine.mjs";

test("documentation-only change is micro", () => {
  assert.equal(
    classifyTask({ taskText: "Update README wording", changedPaths: ["README.md"] }).level,
    "micro",
  );
});

test("new user-facing feature is feature", () => {
  assert.equal(
    classifyTask({ taskText: "Add export button", changedPaths: ["src/ui.js"] }).level,
    "feature",
  );
});

test("auth and migration signals upgrade to high-risk", () => {
  const result = classifyTask({
    taskText: "Change login token handling and migrate users table",
    changedPaths: ["src/auth.js"],
  });
  assert.equal(result.level, "high-risk");
  assert.ok(result.reasons.length > 0);
});

test("required checks increase with task risk", () => {
  const micro = requiredChecksFor("micro").map((check) => check.id);
  const feature = requiredChecksFor("feature").map((check) => check.id);
  const highRisk = requiredChecksFor("high-risk").map((check) => check.id);
  assert.deepEqual(micro, ["implementation", "verification"]);
  assert.ok(feature.includes("documentation"));
  assert.ok(highRisk.includes("regression"));
  assert.ok(highRisk.includes("recovery"));
});

test("delivery is blocked when any required plan entry is pending", () => {
  const decision = evaluateDeliveryReadiness({
    taskLevel: "feature",
    planEntries: [{ text: "Implement export", done: false }],
    reviewErrors: [],
    checks: [
      { id: "implementation", required: true, status: "pass" },
      { id: "verification", required: true, status: "pass" },
      { id: "documentation", required: true, status: "pass" },
    ],
    backupVerified: false,
  });
  assert.equal(decision.deliveryState, "needs-work");
  assert.ok(decision.blockingIssues.some((item) => item.code === "pending-plan"));
  assert.ok(decision.blockingIssues.some((item) => item.code === "backup"));
});

test("delivery is ready only with complete plan, no blockers, and verified backup", () => {
  const decision = evaluateDeliveryReadiness({
    taskLevel: "feature",
    planEntries: [{ text: "Implement export", done: true }],
    reviewErrors: [],
    checks: [
      { id: "implementation", required: true, status: "pass" },
      { id: "verification", required: true, status: "pass" },
      { id: "documentation", required: true, status: "pass" },
    ],
    backupVerified: true,
  });
  assert.equal(decision.deliveryState, "ready-for-confirmation");
  assert.equal(decision.blockingIssues.length, 0);
});

test("delivery rejects an unresolved review error", () => {
  const decision = evaluateDeliveryReadiness({
    taskLevel: "micro",
    planEntries: [{ text: "Update README", done: true }],
    reviewErrors: [{ tag: "plan-quality" }],
    checks: requiredChecksFor("micro").map((check) => ({ ...check, status: "pass" })),
    backupVerified: true,
  });
  assert.equal(decision.deliveryState, "needs-work");
  assert.ok(decision.blockingIssues.some((item) => item.code === "review-error"));
});

test("plan validator rejects dependency-only work without functional delivery", () => {
  const result = validateProposedPlan({
    planText: "1. Install clap and update to the latest version",
    sourceText: "README promises --dry-run but src/main.rs has no implementation",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((item) => item.code === "anchor"));
  assert.ok(result.reasons.some((item) => item.code === "behavior"));
});

test("plan validator accepts a concrete behavior with acceptance evidence", () => {
  const result = validateProposedPlan({
    planText: "1. Implement --dry-run in src/main.rs. Acceptance: cargo run -- --dry-run prints files and writes nothing",
    sourceText: "README promises --dry-run but src/main.rs has no implementation",
  });
  assert.equal(result.ok, true);
});
