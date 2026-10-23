import test from "node:test";
import assert from "node:assert/strict";
import {
  derivePolicyChecks,
  computeDeliveryDecision,
  summarizeProviderFailure,
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
