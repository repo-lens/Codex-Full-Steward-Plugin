const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../guardian.js");

test("steward-first branding keeps the primary identity free of legacy guardian labels", () => {
  const branding = core.panelBranding();
  assert.equal(branding.title, "Codex Full Steward");
  assert.equal(branding.panelAriaLabel, "Codex Full Steward 管家面板");
  assert.equal(branding.pillLabel, "管家");
  assert.equal(branding.pillTitle, "打开管家面板");
  assert.doesNotMatch(branding.title, /429|Guardian/i);
  assert.doesNotMatch(branding.pillLabel, /429|Guardian/i);
});

test("panel priority is steward, then plan board, then optional 429 recovery", () => {
  assert.deepEqual(core.PANEL_SECTION_ORDER, ["steward", "plan", "r429"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "guardian.js"), "utf8");
  assert.match(source, /data-section="steward"/);
  assert.match(source, /data-section="plan"/);
  assert.match(source, /data-section="r429"/);
  assert.match(source, /labelNode\.textContent = branding\.pillLabel/);
  assert.match(source, /stewardSection\.parentNode\.insertBefore\(stewardSection, planSection\)/);
});
