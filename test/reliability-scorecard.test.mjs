import test from "node:test";
import assert from "node:assert/strict";
import { scoreChecks, overallScore } from "../scripts/reliability-scorecard.mjs";

test("scoreChecks returns ten for all passed and zero for all failed", () => {
  assert.equal(scoreChecks([{ id: "a", weight: 1, passed: true }]), 10);
  assert.equal(scoreChecks([{ id: "a", weight: 1, passed: false }]), 0);
});

test("scoreChecks weights failures correctly", () => {
  const score = scoreChecks([
    { id: "a", weight: 3, passed: true },
    { id: "b", weight: 1, passed: false },
  ]);
  assert.equal(score, 7.5);
});

test("overallScore averages dimensions", () => {
  assert.equal(overallScore({ functional: 10, security: 8 }), 9);
});
