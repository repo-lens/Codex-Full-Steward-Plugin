const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../guardian.js");

test("settings normalize provider and fallback fields for v2", () => {
  const settings = core.normalizeSettings({
    llmProvider: "deepseek",
    llmFallbackProvider: "openrouter",
    llmFallbackModel: "fallback-model",
    llmFallbackBaseUrl: "https://fallback.example/v1",
    llmFallbackEnabled: true,
    llmProfiles: [{ id: "primary", provider: "deepseek", model: "primary" }],
  });
  assert.equal(settings.llmProvider, "deepseek");
  assert.equal(settings.llmFallbackProvider, "openrouter");
  assert.equal(settings.llmFallbackModel, "fallback-model");
  assert.equal(settings.llmFallbackEnabled, true);
  assert.equal(settings.llmProfiles.length, 1);
});

test("delivery state normalization accepts only known lifecycle states", () => {
  assert.equal(core.normalizeDeliveryState({ state: "ready-for-confirmation" }).state, "ready-for-confirmation");
  assert.equal(core.normalizeDeliveryState({ state: "delivered" }).state, "delivered");
  assert.equal(core.normalizeDeliveryState({ state: "auto-delete" }).state, "in-progress");
  assert.equal(core.normalizeDeliveryState(null).state, "in-progress");
});

test("delivery request builder requires confirmation and a preview token for execute", () => {
  const preview = core.buildDeliveryRequest({ op: "preview" });
  assert.equal(preview.op, "preview");
  assert.ok(preview.ts > 0);

  assert.throws(() => core.buildDeliveryRequest({ op: "execute", confirmed: true }), /preview token/i);
  assert.throws(() => core.buildDeliveryRequest({ op: "execute", executeToken: "token", confirmed: false }), /confirmation/i);

  const execute = core.buildDeliveryRequest({ op: "execute", executeToken: "token", confirmed: true });
  assert.equal(execute.op, "execute");
  assert.equal(execute.executeToken, "token");
  assert.equal(execute.confirmed, true);
});

test("credential request builder never keeps an empty secret", () => {
  assert.throws(() => core.buildCredentialRequest({ op: "set", ref: "primary", secret: "" }), /secret/i);
  const remove = core.buildCredentialRequest({ op: "remove", ref: "backup" });
  assert.equal(remove.op, "remove");
  assert.equal(remove.ref, "backup");
  assert.ok(remove.ts > 0);
});

test("delivery and provider selectors are centralized", () => {
  for (const key of [
    "deliveryStrip",
    "deliveryStateText",
    "deliveryPreview",
    "deliveryModal",
    "deliveryContinue",
    "deliveryExecute",
    "deliveryCancel",
    "llmFallbackProvider",
    "llmFallbackModel",
    "llmFallbackBaseUrl",
    "llmFallbackEnabled",
    "llmKeySave",
    "llmKeychainStatus",
  ]) {
    assert.ok(core.SELECTORS.ui[key], key);
  }
});
