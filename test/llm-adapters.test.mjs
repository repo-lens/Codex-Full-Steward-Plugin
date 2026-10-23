import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_PRESETS,
  normalizeProfiles,
  requestWithFallback,
} from "../scripts/llm-adapters.mjs";

const credentials = {
  async get(ref) {
    return ref ? "test-secret" : null;
  },
};

const profiles = [
  {
    id: "primary",
    provider: "openai",
    baseUrl: "https://primary.example/v1",
    model: "primary-model",
    enabled: true,
    priority: 1,
    credentialRef: "primary",
  },
  {
    id: "backup",
    provider: "openai",
    baseUrl: "https://backup.example/v1",
    model: "backup-model",
    enabled: true,
    priority: 2,
    credentialRef: "backup",
  },
];

test("provider presets include required adapters", () => {
  for (const provider of ["openai", "anthropic", "dashscope", "deepseek", "openrouter", "ollama", "custom"]) {
    assert.ok(PROVIDER_PRESETS[provider], provider);
  }
});

test("normalizes legacy settings into a primary profile", () => {
  const result = normalizeProfiles(
    {
      llmProvider: "custom",
      llmBaseUrl: "https://legacy.example/v1",
      llmModel: "legacy-model",
      llmApiKey: "legacy-secret",
    },
    { primary: true },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "primary");
  assert.equal(result[0].provider, "custom");
  assert.equal(result[0].model, "legacy-model");
  assert.equal(result[0].credentialRef, "primary");
});

test("401 switches immediately to the fallback profile", async () => {
  const calls = [];
  const result = await requestWithFallback({
    profiles,
    prompt: "hello",
    credentialStore: credentials,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith("https://primary.example/")) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ choices: [{ message: { content: "fallback-ok" } }] });
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "fallback-ok");
  assert.equal(result.profileId, "backup");
  assert.equal(calls.length, 2);
  assert.equal(result.attempts[0].failure, "auth");
});

test("429 retries with backoff before succeeding on the same profile", async () => {
  let attempts = 0;
  const waits = [];
  const result = await requestWithFallback({
    profiles: [profiles[0]],
    prompt: "hello",
    credentialStore: credentials,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return Response.json({ choices: [{ message: { content: "retried-ok" } }] });
    },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "retried-ok");
  assert.deepEqual(waits, [1000]);
});

test("malformed JSON gets one strict retry before fallback", async () => {
  let primaryCalls = 0;
  const result = await requestWithFallback({
    profiles,
    prompt: "hello",
    credentialStore: credentials,
    fetchImpl: async (url) => {
      if (url.startsWith("https://primary.example/")) {
        primaryCalls += 1;
        return new Response("not-json", { status: 200 });
      }
      return Response.json({ choices: [{ message: { content: "backup-ok" } }] });
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.profileId, "backup");
  assert.equal(primaryCalls, 2);
});

test("all provider failure returns a normalized error without leaking credentials", async () => {
  const result = await requestWithFallback({
    profiles,
    prompt: "hello",
    credentialStore: credentials,
    fetchImpl: async () => new Response("server failed", { status: 500 }),
    sleep: async () => {},
    maxTransientRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "all-providers-failed");
  assert.ok(result.attempts.length >= 2);
  assert.ok(!JSON.stringify(result).includes("test-secret"));
});

test("three transport failures cool down a profile for five minutes", async () => {
  const health = new Map();
  const now = Date.parse("2026-10-23T00:00:00Z");
  const result = await requestWithFallback({
    profiles: [profiles[0]],
    prompt: "hello",
    credentialStore: credentials,
    fetchImpl: async () => new Response("server failed", { status: 500 }),
    sleep: async () => {},
    health,
    now: () => now,
    maxTransientRetries: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(health.get("primary").cooldownUntilMs, now + 300000);
});
