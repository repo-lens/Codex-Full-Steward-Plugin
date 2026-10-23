const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../guardian.js");

test("clamps panel positions fully inside the viewport", () => {
  assert.deepEqual(
    core.clampPanelPosition({
      x: -50,
      y: 9999,
      width: 248,
      height: 600,
      viewportWidth: 1440,
      viewportHeight: 900,
    }),
    { x: 8, y: 292 },
  );
});

test("clamps oversized panels to the minimum margin", () => {
  assert.deepEqual(
    core.clampPanelPosition({
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    { x: 8, y: 8 },
  );
});

test("default panel position is bottom-right", () => {
  assert.deepEqual(
    core.defaultPanelPosition({
      width: 248,
      height: 700,
      viewportWidth: 1440,
      viewportHeight: 900,
    }),
    { x: 1184, y: 192 },
  );
});

test("interactive and explicitly blocked nodes cannot start dragging", () => {
  assert.equal(core.canStartPanelDrag({ tagName: "BUTTON" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "INPUT" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "SELECT" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "TEXTAREA" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "A" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV", isContentEditable: true }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV", noDrag: true }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV", disabled: true }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV" }), true);
});

test("panel reset and attribution selectors are centralized", () => {
  assert.ok(core.SELECTORS.ui.panelResetPosition);
  assert.ok(core.SELECTORS.ui.attribution);
});
