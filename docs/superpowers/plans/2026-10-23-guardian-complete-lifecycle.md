# Codex Guardian v2.0 Complete Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a deterministic steward policy layer, resilient multi-provider LLM adapters, Keychain credentials, and manual-confirmation delivery backup with conservative cleanup.

**Architecture:** Keep the Codex page as a UI/CDP bridge. Move task policy, model fallback, credentials, and delivery operations into focused native ESM modules. The policy engine remains authoritative; LLM output can propose a plan but cannot mark a delivery ready.

**Tech Stack:** Node.js 24 ESM, CommonJS-compatible shared functions in `guardian.js`, macOS `security`, `zip`/`unzip`, `ditto`, launchd, `node:test`, CDP.

**Spec:** `docs/superpowers/specs/2026-10-23-guardian-complete-lifecycle-design.md`

## Global Constraints

- Target version: `2.0.0`.
- Node runtime: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`.
- No npm runtime dependencies.
- LLM network requests run only in the native daemon.
- API keys never return to the page after Keychain migration.
- Delivery and cleanup require explicit user confirmation.
- Cleanup never touches source, docs, tests, tracked files, evidence files, configuration, or user outputs.
- Every new behavior starts with a failing test.
- Tests must not call a real external LLM or modify the real Keychain.
- All file operations are restricted to the project root or a test-owned temporary root.

---

## File Structure

Create:

- `scripts/policy-engine.mjs` - deterministic task and delivery policy.
- `scripts/credential-store.mjs` - injectable Keychain adapter.
- `scripts/llm-adapters.mjs` - provider presets, retries, fallback, cooldown.
- `scripts/delivery-manager.mjs` - preview, archive, manifest, checksum, cleanup.
- `scripts/reliability-scorecard.mjs` - two-round validation scorecard.
- `test/policy-engine.test.mjs`
- `test/credential-store.test.mjs`
- `test/llm-adapters.test.mjs`
- `test/delivery-manager.test.mjs`
- `test/fixtures/project-basic/` fixture project.
- `docs/superpowers/plans/2026-10-23-guardian-complete-lifecycle.md` - this plan.

Modify:

- `scripts/steward-daemon.mjs` - orchestration, provider chain, Keychain, delivery requests.
- `guardian.js` - provider UI, Keychain status, delivery strip and preview.
- `scripts/e2e-self-test.mjs` - provider and delivery E2E assertions.
- `package.json` - version and test command.
- `README.md` - v2.0 workflow and safety model.
- `HANDOFF-STEWARD.md` - current architecture and remaining risks.

---

### Task 1: Deterministic Policy Engine

**Files:**
- Create: `scripts/policy-engine.mjs`
- Test: `test/policy-engine.test.mjs`

**Interfaces:**
- Consumes: `{ taskText, changedPaths, planEntries, reviewErrors, checks }`
- Produces:
  - `classifyTask(input): { level, reasons }`
  - `requiredChecksFor(level): Check[]`
  - `evaluateDeliveryReadiness(input): StewardDecision`
  - `validateProposedPlan(input): { ok, reasons, anchors, coveredAnchors }`

- [ ] **Step 1: Write failing classification tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../scripts/policy-engine.mjs";

test("documentation-only change is micro", () => {
  assert.equal(classifyTask({ taskText: "Update README wording", changedPaths: ["README.md"] }).level, "micro");
});

test("new user-facing feature is feature", () => {
  assert.equal(classifyTask({ taskText: "Add export button", changedPaths: ["src/ui.js"] }).level, "feature");
});

test("auth and migration signals upgrade to high-risk", () => {
  assert.equal(classifyTask({ taskText: "Change login token handling and migrate users table", changedPaths: ["src/auth.js"], }).level, "high-risk");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/policy-engine.test.mjs
```

Expected: module-not-found failure for `policy-engine.mjs`.

- [ ] **Step 3: Implement classification and required checks**

```js
const HIGH_RISK = [
  /\bauth(?:entication|orization)?\b/i,
  /权限|鉴权|登录|支付|账单|迁移|migration|delete|destroy|drop\s+table/i,
];

const MICRO_PATH = /^(?:README|docs\/|.*\.md$|.*\.json$)/i;

export function classifyTask({ taskText = "", changedPaths = [] } = {}) {
  const text = String(taskText || "");
  const paths = changedPaths.map(String);
  const reasons = [];
  if (HIGH_RISK.some((re) => re.test(text) || paths.some((p) => re.test(p)))) {
    return { level: "high-risk", reasons: ["high-risk signal"] };
  }
  const behaviorChange = paths.some((p) => !MICRO_PATH.test(p));
  if (behaviorChange || /add|feature|implement|新增|实现|开发/i.test(text)) {
    return { level: "feature", reasons: ["behavior change"] };
  }
  return { level: "micro", reasons: ["documentation or metadata only"] };
}

export function requiredChecksFor(level) {
  const base = [
    { id: "implementation", title: "Implementation evidence exists", required: true },
    { id: "verification", title: "Observable verification exists", required: true },
  ];
  if (level === "feature") base.push({ id: "documentation", title: "Relevant docs are current", required: true });
  if (level === "high-risk") base.push(
    { id: "regression", title: "Regression verification exists", required: true },
    { id: "recovery", title: "Rollback or recovery path exists", required: true },
  );
  if (level === "delivery") base.push({ id: "backup", title: "Verified delivery backup exists", required: true });
  return base;
}
```

- [ ] **Step 4: Add failing delivery-readiness tests**

```js
test("delivery is blocked when any required plan entry is pending", () => {
  const decision = evaluateDeliveryReadiness({
    planEntries: [{ text: "Implement export", done: false }],
    reviewErrors: [],
    checks: [],
    backupVerified: false,
  });
  assert.equal(decision.deliveryState, "needs-work");
  assert.ok(decision.blockingIssues.some((item) => item.code === "pending-plan"));
});

test("delivery is ready only with complete plan, no blockers, and verified backup", () => {
  const decision = evaluateDeliveryReadiness({
    planEntries: [{ text: "Implement export", done: true }],
    reviewErrors: [],
    checks: [{ id: "verification", required: true, status: "pass" }],
    backupVerified: true,
  });
  assert.equal(decision.deliveryState, "ready-for-confirmation");
});
```

- [ ] **Step 5: Implement readiness and plan validation**

`evaluateDeliveryReadiness` must return `needs-work` when any item is pending, any required check is not `pass`, `reviewErrors` is non-empty, or `backupVerified` is false. It returns `ready-for-confirmation` only when all conditions pass.

`validateProposedPlan` must reuse the existing anchor, acceptance, dependency-only, latest-version, and grounding rules currently embedded in `guardian.js`; expose them through the new module and keep `guardian.js` exports as compatibility wrappers.

- [ ] **Step 6: Run tests and full suite**

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/policy-engine.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
```

Expected: policy tests pass and existing tests remain green.

- [ ] **Step 7: Commit**

```bash
git add scripts/policy-engine.mjs test/policy-engine.test.mjs guardian.js
git commit -m "feat: add deterministic steward policy engine"
```

---

### Task 2: Keychain Credential Store

**Files:**
- Create: `scripts/credential-store.mjs`
- Test: `test/credential-store.test.mjs`

**Interfaces:**
- Produces: `createCredentialStore({ runner, service = "codex-guardian" })`
- Store methods:
  - `has(ref): Promise<boolean>`
  - `get(ref): Promise<string | null>`
  - `set(ref, value): Promise<void>`
  - `remove(ref): Promise<void>`

- [ ] **Step 1: Write failing tests with an injected runner**

```js
test("stores and reads a secret without exposing it in returned metadata", async () => {
  const records = new Map();
  const store = createCredentialStore({
    runner(args, input) {
      if (args[0] === "add-generic-password") {
        records.set(args.at(-2), input);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const value = records.get(args.at(-1));
        return value ? { status: 0, stdout: value + "\\n", stderr: "" } : { status: 44, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await store.set("primary", "secret-value");
  assert.equal(await store.has("primary"), true);
  assert.equal(await store.get("primary"), "secret-value");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/credential-store.test.mjs
```

Expected: FAIL because `credential-store.mjs` does not exist.

- [ ] **Step 3: Implement the adapter**

Use `spawnSync("/usr/bin/security", args, { input, encoding: "utf8" })` in the default runner.

Commands:

```text
find-generic-password -s codex-guardian -a <ref> -w
add-generic-password -U -s codex-guardian -a <ref> -w <value>
delete-generic-password -s codex-guardian -a <ref>
```

Never include the secret in an error message. Status `44` from `find` means missing.

- [ ] **Step 4: Run test and full suite**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/credential-store.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/credential-store.mjs test/credential-store.test.mjs
git commit -m "feat: add macOS Keychain credential store"
```

---

### Task 3: LLM Provider Adapters and Fallback

**Files:**
- Create: `scripts/llm-adapters.mjs`
- Test: `test/llm-adapters.test.mjs`

**Interfaces:**
- Produces:
  - `PROVIDER_PRESETS`
  - `normalizeProfiles(settings, credentialStatus)`
  - `requestWithFallback({ profiles, prompt, credentialStore, fetchImpl, sleep, now })`
- Returns:
  - `{ ok: true, text, profileId, provider, model, attempts }`
  - `{ ok: false, errorCode, attempts }`

- [ ] **Step 1: Write failing preset and fallback tests**

```js
test("normalizes legacy settings into a primary profile", () => {
  const profiles = normalizeProfiles({ llmProvider: "custom", llmBaseUrl: "https://x/v1", llmModel: "m", llmApiKey: "legacy" }, { primary: true });
  assert.equal(profiles[0].id, "primary");
  assert.equal(profiles[0].provider, "custom");
});

test("401 switches immediately to the fallback profile", async () => {
  const calls = [];
  const result = await requestWithFallback({
    profiles: [
      { id: "primary", provider: "openai", model: "a", baseUrl: "https://a/v1", enabled: true, priority: 1 },
      { id: "backup", provider: "openai", model: "b", baseUrl: "https://b/v1", enabled: true, priority: 2 },
    ],
    prompt: "hello",
    credentialStore: { get: async () => "secret" },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith("https://a/")) return new Response("unauthorized", { status: 401 });
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.profileId, "backup");
  assert.equal(calls.length, 2);
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/llm-adapters.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement presets and protocol builders**

Presets:

```js
export const PROVIDER_PRESETS = Object.freeze({
  openai: { protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  dashscope: { protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
  openrouter: { protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  ollama: { protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", auth: false },
  custom: { protocol: "openai", baseUrl: "" },
});
```

- [ ] **Step 4: Implement retry and cooldown tests**

Add tests for 429/5xx retry, malformed JSON one retry, network fallback, all-provider failure, and three failures causing five-minute cooldown.

- [ ] **Step 5: Implement requestWithFallback**

Rules:

- Sort enabled profiles by ascending `priority`.
- Skip profiles in cooldown.
- Resolve credentials from Keychain unless provider is Ollama/auth is disabled.
- Use `AbortSignal.timeout(profile.timeoutMs || 90000)`.
- 401/403: no retry on the same profile.
- 429/5xx/network/timeout: retry after 1s, 2s, 4s, then next profile.
- Malformed response: one strict retry on the same profile, then next profile.
- Never return a key in attempts or errors.

- [ ] **Step 6: Run tests and full suite**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/llm-adapters.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/llm-adapters.mjs test/llm-adapters.test.mjs
git commit -m "feat: add resilient multi-provider LLM adapters"
```

---

### Task 4: Delivery Manager

**Files:**
- Create: `scripts/delivery-manager.mjs`
- Test: `test/delivery-manager.test.mjs`

**Interfaces:**
- Produces:
  - `createDeliveryPreview({ projectRoot, sessionKey, decision })`
  - `createDelivery({ projectRoot, preview, now })`
  - `applyCleanup({ projectRoot, preview, trashImpl })`
  - `verifyDelivery({ deliveryDir })`

- [ ] **Step 1: Write failing inclusion/exclusion tests**

```js
test("preview includes source and excludes secrets, Git, dependencies, and prior deliveries", async () => {
  const root = await makeFixtureProject();
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp:test", decision: readyDecision() });
  assert.ok(preview.include.includes("src/index.js"));
  assert.ok(preview.include.includes("README.md"));
  assert.ok(preview.exclude.some((item) => item.path === ".git"));
  assert.ok(preview.exclude.some((item) => item.path === ".env"));
  assert.ok(preview.exclude.some((item) => item.path === "node_modules"));
  assert.ok(preview.exclude.some((item) => item.path === "outputs/guardian-delivery-old"));
});
```

- [ ] **Step 2: Run test and verify failure**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/delivery-manager.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement preview and path safety**

Requirements:

- Resolve every path under `projectRoot`.
- Reject symlinks and escaping paths.
- Exclude exact categories from the spec.
- Return deterministic include/exclude lists sorted by path.
- Cleanup candidates are limited to `.guardian/cache`, `.guardian/tmp`, current session `context-cache.json`, and `.guardian/**/*.tmp`.

- [ ] **Step 4: Add failing archive and manifest tests**

```js
test("delivery creates zip, manifest, checksums, and verifies readback", async () => {
  const result = await createDelivery({ projectRoot: root, preview, now: () => new Date("2026-10-23T00:00:00Z") });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.archivePath));
  assert.ok(fs.existsSync(path.join(result.deliveryDir, "MANIFEST.json")));
  assert.ok(fs.existsSync(path.join(result.deliveryDir, "SHA256SUMS")));
  assert.equal((await verifyDelivery({ deliveryDir: result.deliveryDir })).ok, true);
});
```

- [ ] **Step 5: Implement archive and verification**

Use `/usr/bin/zip -r -q` and `/usr/bin/unzip -t`. Create `SHA256SUMS` from actual file hashes. Abort if project fingerprint changes or verification fails. Never run cleanup on failure.

- [ ] **Step 6: Add failing cleanup tests**

Test that:

- Source, docs, tracked files, and user outputs are never candidates.
- Symlinks are rejected.
- Injected Finder/trash success records original and destination.
- Injected Finder failure uses `~/.Trash` fallback.
- Cleanup failure does not invalidate delivery.

- [ ] **Step 7: Run tests and full suite**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/delivery-manager.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/delivery-manager.mjs test/delivery-manager.test.mjs
git commit -m "feat: add verified delivery backup and conservative cleanup"
```

---

### Task 5: Daemon Integration

**Files:**
- Modify: `scripts/steward-daemon.mjs`
- Modify: `scripts/e2e-self-test.mjs`
- Test: existing unit suites plus daemon E2E

**Interfaces:**
- Consumes modules from Tasks 1-4.
- Adds page request types:
  - `credential-set`
  - `credential-status`
  - `delivery-preview`
  - `delivery-execute`
- Writes normalized delivery state to `codex429Guardian.deliveryState.v1`.

- [ ] **Step 1: Read provider settings and migrate legacy credentials**

On daemon start:

```js
const settings = await readSettingsFromPage(cdp);
if (settings.llmApiKey) {
  await credentialStore.set("primary", settings.llmApiKey);
  await cdp.eval(`removeLegacyPlaintextKey()`);
}
```

- [ ] **Step 2: Replace direct callLlm with adapter chain**

All calls, including review, chat, strict retry, and grounding retry, use `requestWithFallback`. Trace records provider ID, model, attempt count, and failure codes, never keys.

- [ ] **Step 3: Persist delivery state after each plan update**

Compute readiness from current plan, checks, errors, and backup state. Store:

```js
{
  state: "in-progress" | "needs-work" | "ready-for-confirmation" | "delivered",
  decision,
  preview: null,
  lastDelivery: null
}
```

- [ ] **Step 4: Handle delivery preview and execute requests**

Preview requires `ready-for-confirmation` and user-confirmed request. Execute requires a preview token generated during preview. Reject stale tokens and changed project fingerprints.

- [ ] **Step 5: Run unit suites**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check scripts/steward-daemon.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/steward-daemon.mjs scripts/e2e-self-test.mjs
git commit -m "feat: integrate policy, providers, and delivery into daemon"
```

---

### Task 6: UI and Settings

**Files:**
- Modify: `guardian.js`
- Test: `test/guardian.test.cjs`
- Test: `test/steward-plan-quality.test.cjs`

**Interfaces:**
- Adds selectors for delivery strip, preview modal, provider select, fallback select, Keychain status.
- Adds API:
  - `getDeliveryState()`
  - `setDeliveryState(state)`
  - `openDeliveryPreview(preview)`

- [ ] **Step 1: Write failing selector and state tests**

```js
test("delivery selectors are centralized", () => {
  assert.ok(core.SELECTORS.ui.deliveryStrip);
  assert.ok(core.SELECTORS.ui.deliveryPreview);
  assert.ok(core.SELECTORS.ui.providerPrimary);
  assert.ok(core.SELECTORS.ui.providerFallback);
});

test("delivery status normalization rejects invalid states", () => {
  assert.equal(core.normalizeDeliveryState({ state: "ready-for-confirmation" }).state, "ready-for-confirmation");
  assert.equal(core.normalizeDeliveryState({ state: "auto-delete" }).state, "in-progress");
});
```

- [ ] **Step 2: Implement UI fields**

Add:

- Delivery strip under plan progress.
- Provider preset selectors for primary and fallback.
- Model fields for each profile.
- Keychain status labels.
- Delivery preview modal with two confirmation buttons.

- [ ] **Step 3: Remove plaintext-key usage from UI**

After migration, the key input shows `已保存到 Keychain` and an explicit replace action. `runtime.settings.llmApiKey` is removed from normalized persisted settings.

- [ ] **Step 4: Add manual confirmation flow tests**

Test that:

- Delivery button is disabled unless state is ready.
- First click opens preview and does not call execute.
- Second click writes execute request.
- Cancel leaves project untouched.

- [ ] **Step 5: Run tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check guardian.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add guardian.js test/guardian.test.cjs test/steward-plan-quality.test.cjs
git commit -m "feat: add provider and delivery lifecycle UI"
```

---

### Task 7: End-to-End and Two-Round Scorecard

**Files:**
- Create: `scripts/reliability-scorecard.mjs`
- Modify: `scripts/e2e-self-test.mjs`
- Create fixture files under `test/fixtures/project-basic/`

**Interfaces:**
- `runFunctionalRound()` validates provider fallback, plan quality, and delivery readiness.
- `runSafetyRound()` validates backup exclusions, hashes, cleanup safety, and second confirmation.
- Produces JSON and Markdown score reports in `outputs/guardian-tests/`.

- [ ] **Step 1: Create fixture project**

Include tracked source, README, `.env`, `node_modules/fake`, `.guardian/cache/cache.json`, `.guardian/tmp/temp.tmp`, and a symlink when supported.

- [ ] **Step 2: Write failing scorecard tests**

Assert:

- Functional round fails if fallback provider is not used.
- Safety round fails if `.env` is archived.
- Safety round fails if cleanup includes source.
- Safety round fails if second confirmation is missing.

- [ ] **Step 3: Implement two rounds**

Round 1: policy + fallback + plan quality + countdown.

Round 2: delivery preview + archive + hashes + cleanup + final state.

Output scores with dimensions:

```text
functional
quality
resilience
security
delivery
observability
```

- [ ] **Step 4: Run round 1**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/reliability-scorecard.mjs --round functional
```

Expected: all mandatory checks pass; report path printed.

- [ ] **Step 5: Run round 2**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/reliability-scorecard.mjs --round safety
```

Expected: all mandatory checks pass; report path printed.

- [ ] **Step 6: Commit**

```bash
git add scripts/reliability-scorecard.mjs scripts/e2e-self-test.mjs test/fixtures/project-basic
git commit -m "test: add two-round lifecycle scorecard"
```

---

### Task 8: Documentation, Version, Install, and Verification

**Files:**
- Modify: `package.json`
- Modify: `guardian.js`
- Modify: `README.md`
- Modify: `HANDOFF-STEWARD.md`

- [ ] **Step 1: Update version to 2.0.0**

Change `package.json`, `guardian.js` version constant, and visible version tag.

- [ ] **Step 2: Update README**

Document:

- Primary/fallback provider setup.
- Keychain migration.
- Delivery readiness state.
- Preview and two-step confirmation.
- Backup manifest and exclusion rules.
- Conservative cleanup and Trash recovery.

- [ ] **Step 3: Update HANDOFF-STEWARD.md**

Replace stale line counts and version references. Record module responsibilities, test counts, newest verification commands, and residual risks.

- [ ] **Step 4: Run complete verification**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check guardian.js
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check scripts/steward-daemon.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/e2e-self-test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/reliability-scorecard.mjs --round functional
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/reliability-scorecard.mjs --round safety
bash install.sh
```

Expected:

- Unit tests pass.
- Syntax checks pass.
- E2E passes.
- Both score rounds pass.
- Installed hash matches repository `guardian.js`.

- [ ] **Step 5: Reload and inspect live runtime**

Run:

```bash
launchctl kickstart -k gui/$(id -u)/codex.guardian.steward
```

Reload the Codex page through CDP and verify:

- Guardian API available.
- Delivery selectors present.
- Provider profiles normalized.
- Keychain status reports configured.
- No plaintext key remains in localStorage.
- Plan board is clean after tests.

- [ ] **Step 6: Commit**

```bash
git add package.json guardian.js README.md HANDOFF-STEWARD.md
git commit -m "release: guardian v2.0 complete lifecycle"
```

---

## Plan Self-Review

- Spec coverage: policy engine, provider presets/fallback, Keychain, delivery archive, conservative cleanup, UI, persistence, E2E, docs, and rollout each map to a task.
- Placeholder scan: no unresolved implementation placeholders.
- Type consistency: `StewardDecision`, `ProviderProfile`, provider result, delivery preview, delivery result, and request names are consistent across tasks.
- Scope: the work is sequential and each task produces a testable module before integration.
