# Codex Guardian Complete Lifecycle Design

- Date: 2026-10-23
- Status: Approved in conversation; pending written-spec review
- Target: v2.0.0
- Scope: steward responsibilities, LLM provider resilience, delivery backup and conservative cleanup

## 1. Objective

Codex Guardian must behave like a responsible project steward rather than only an LLM reviewer.

The steward must:

1. Understand the current task and project state.
2. Classify task risk and apply the required quality gates.
3. Use LLM analysis for synthesis and expression without allowing the LLM to bypass deterministic controls.
4. Continue through a reliable primary/fallback model chain.
5. Detect when a project is ready for manual delivery confirmation.
6. Generate a verifiable delivery backup before any cleanup.
7. Clean only reproducible or runtime data, with preview and recovery.

Final delivery and cleanup are never fully automatic. The user must explicitly confirm.

## 2. Non-goals

- Automatically declaring a project delivered without user confirmation.
- Deleting source, documentation, configuration, Git data, evidence files, or user outputs.
- Providing a hosted credential service.
- Supporting every provider-specific API shape in the first release.
- Replacing project tests or accepting a model's claim as verification evidence.

## 3. Architecture

The implementation is split into focused native modules:

```text
guardian.js                         UI, plan board, CDP bridge
scripts/steward-daemon.mjs          orchestration and CDP loop
scripts/policy-engine.mjs            task classification and quality gates
scripts/llm-adapters.mjs             provider presets and fallback chain
scripts/credential-store.mjs         macOS Keychain access
scripts/delivery-manager.mjs         delivery backup, manifest, cleanup
```

The modules expose pure or file-system-isolated interfaces so they can be tested without a live Codex window.

### 3.1 Orchestration flow

```text
completed and stable task result
-> capture session/project/git/plan state
-> policy engine builds required checks
-> context collector reads allowed project documents
-> LLM adapter requests analysis through primary/fallback models
-> policy engine validates proposed plan and evidence
-> write clean plan or evidence request
-> when all required work is complete, compute delivery readiness
-> UI displays manual delivery confirmation
-> user opens preview and confirms twice
-> delivery manager builds and verifies backup
-> conservative cleanup candidates move to Trash
-> write final delivery record
```

## 4. Core Contracts

### 4.1 StewardDecision

The policy engine produces one normalized decision:

```js
{
  taskLevel: "micro" | "feature" | "high-risk" | "delivery",
  requiredChecks: [
    {
      id: "implementation",
      title: "Implementation exists",
      required: true,
      status: "pass" | "fail" | "unknown"
    }
  ],
  passedChecks: ["implementation", "verification"],
  blockingIssues: [
    {
      code: "missing-verification",
      message: "The primary user path has no verification evidence",
      evidence: "src/foo.js + tests/foo.test.js"
    }
  ],
  missingEvidence: ["test output", "delivery manifest"],
  deliveryState: "in-progress" | "needs-work" | "ready-for-confirmation" | "delivered",
  nextAction: "continue" | "request-evidence" | "propose-plan" | "confirm-delivery"
}
```

LLMs may suggest values, but only the policy engine can set `deliveryState` to `ready-for-confirmation`.

### 4.2 ProviderProfile

```js
{
  id: "primary",
  provider: "openai" | "anthropic" | "dashscope" | "deepseek" |
            "openrouter" | "ollama" | "custom",
  baseUrl: "https://...",
  model: "model-id",
  enabled: true,
  priority: 10,
  timeoutMs: 90000,
  maxOutputTokens: 1600,
  credentialRef: "codex-guardian:primary",
  customHeaders: {}
}
```

The profile list is ordered by priority. It must contain at least one enabled profile.

## 5. Policy Engine

### 5.1 Task classification

Classification uses deterministic signals:

| Level | Signals |
|---|---|
| micro | Documentation, copy, metadata, low-risk isolated edit |
| feature | Source behavior change, new UI, new command, new integration |
| high-risk | Authentication, authorization, billing, data migration, destructive operations, external boundaries, broad cross-module changes |
| delivery | Final readiness evaluation after required work is complete |

An unknown classification defaults to `feature`. A high-risk signal always upgrades the level.

### 5.2 Required checks

Every task requires:

- Actual implementation or documented change.
- Evidence grounded in project files or command output.
- No unresolved task-running or parse-failure state.
- Session isolation.
- No duplicate plan entry.

Feature tasks additionally require:

- Requirement-to-implementation mapping.
- Verification of the primary path.
- Relevant documentation update when behavior or setup changes.

High-risk tasks additionally require:

- Regression verification.
- Compatibility or migration notes.
- Failure recovery or rollback path when state can be changed.

Delivery requires:

- All required plan entries complete.
- Zero blocking issues.
- No unresolved review errors.
- A verified delivery backup.
- An explicit user confirmation.

### 5.3 LLM validation

The policy engine validates every proposed plan for:

- At least one concrete project anchor when a blocker names one.
- Bounded plan size.
- No dependency-only or scaffold-only answer when a feature is requested.
- Acceptance evidence that exercises the behavior, not only build or help text.
- No forbidden latest-version upgrades unless explicitly required.
- No evidence text written to the plan board.
- No duplicate or already-completed work.

Invalid output is retried once with a stricter prompt. If retry fails, the plan board remains unchanged and a tagged audit error is recorded.

## 6. LLM Adapter Layer

### 6.1 Provider presets

The first release includes:

- OpenAI
- Anthropic
- DashScope
- DeepSeek
- OpenRouter
- Ollama
- Custom OpenAI-compatible endpoint

Each preset supplies a default protocol, base URL pattern, authentication mode, and response parser. Local Ollama profiles may omit credentials.

### 6.2 Fallback policy

The adapter tries enabled profiles in priority order.

| Failure | Action |
|---|---|
| HTTP 401/403 | Mark profile configuration error; switch immediately |
| HTTP 429 | Honor short backoff, then switch |
| HTTP 5xx | Exponential backoff, then switch |
| Network/DNS/timeout | Exponential backoff, then switch |
| Invalid JSON/response shape | One strict retry, then switch |
| Policy/evidence rejection | One policy retry, then allow the next profile to analyze |

Backoff sequence is 1s, 2s, 4s. A profile with three consecutive transport failures enters a five-minute cooldown. Successful calls reset its health counters.

### 6.3 All-provider failure

If every profile fails:

- Do not write an LLM-generated plan or an error placeholder into the plan board.
- Write a tagged audit record containing provider IDs, failure classes, retry count, and elapsed time.
- Return a deterministic policy result:
  - `deliveryState` remains non-delivery-ready.
  - `blockingIssues` reports the unavailable model chain.
  - `nextAction` is `request-configuration-fix`.
- The UI exposes a concise configuration action, not a long network error dump.

## 7. Credential Store

Credentials are stored in macOS Keychain under service `codex-guardian`.

- The page never receives or displays an API key after configuration.
- The UI displays only `configured` or `missing`.
- The native daemon reads credentials through `security find-generic-password`.
- Saving or replacing a credential uses `security add-generic-password -U`.
- Existing plaintext keys are migrated once to Keychain and then removed from `localStorage`.
- Logs, manifests, trace events, and delivery packages never contain key values.
- Tests use a temporary keychain abstraction implementation, not the real Keychain.

## 8. Delivery Manager

### 8.1 Delivery readiness

The UI exposes a delivery control only when `StewardDecision.deliveryState` is `ready-for-confirmation`.

The preview displays:

- Project root and session key.
- Git branch, commit, and dirty files.
- Required checks and results.
- Blocking issue count.
- File count and estimated archive size.
- Backup destination.
- Cleanup candidates and reasons.
- Excluded secret/runtime paths.

The user must confirm the preview and then confirm execution a second time.

### 8.2 Backup layout

```text
<projectRoot>/outputs/guardian-delivery-YYYYMMDD-HHmmss/
├── delivery.zip
├── MANIFEST.json
├── SHA256SUMS
└── DELIVERY-README.md
```

### 8.3 Archive inclusion

Include:

- Git-tracked source, tests, documentation, configuration templates, and assets.
- Non-ignored untracked project files that are not excluded.
- Existing user files under `outputs/` except prior `guardian-delivery-*` directories.

Exclude:

- `.git`
- `node_modules`
- `dist`, `build`, `coverage`, `.next`, `target`, caches
- `.guardian/cache`, `.guardian/tmp`
- the new delivery directory itself
- `.env`, key material, certificate private keys, credentials
- local state and secret-bearing files matching `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.npmrc`, `.netrc`, and project-local database files configured as sensitive
- symlinks and paths resolving outside the project root

The manifest records every exclusion category and the path count excluded by category.

### 8.4 Manifest

`MANIFEST.json` contains:

- Guardian version, timestamp, project root, session key
- Task level, required checks, results, blockers
- Git branch, commit, tracked status, and non-ignored untracked files
- Provider/model IDs used, without credentials
- Included file list with size and SHA-256
- Exclusion summary
- Cleanup candidates with reason and original path
- Archive SHA-256

### 8.5 Verification

Delivery succeeds only if:

1. The project fingerprint is unchanged before and after archive creation; the fingerprint excludes the new delivery directory itself.
2. ZIP structure validation succeeds.
3. Every included file hash matches the manifest.
4. `SHA256SUMS` contains the archive and manifest hashes.

Any failure aborts cleanup and leaves the project untouched.

## 9. Conservative Cleanup

Cleanup runs only after delivery verification.

Eligible candidates:

- `.guardian/cache/**`
- `.guardian/tmp/**`
- `context-cache.json` for the completed current session
- Explicit `*.tmp` files inside `.guardian` or generated output directories
- Generated local logs explicitly marked by Guardian

Never eligible:

- Git-tracked files
- Source, tests, docs, evidence Markdown, configuration, assets
- Untracked non-ignored source
- `.git`
- Dependencies
- User outputs
- Any path outside the project root
- Any symlink target

Deletion behavior:

1. Resolve and validate the candidate remains inside the project root.
2. Reject symlinks.
3. Request Finder deletion through AppleScript.
4. If Finder deletion fails, move to `~/.Trash` with a collision-safe timestamp suffix.
5. Record original path, new Trash path, hash if the candidate is a file, and result.

If cleanup fails, delivery remains valid and the report marks remaining candidates. Cleanup is never retried automatically.

## 10. UI Changes

The plan board adds one delivery status strip:

```text
交付状态: 进行中 | 待补齐 | 可确认交付 | 已交付
```

When ready, the strip exposes `预览并确认交付`.

The preview is a modal with:

- Backup contents and exclusions.
- Cleanup candidates.
- Quality checks.
- Final confirmation button.

The LLM configuration area adds:

- Provider preset selector.
- Primary/fallback profile list.
- Keychain status.
- Provider health and current cooldown.
- A compact last-error tag.

No new modal or settings surface uses explanatory marketing copy.

## 11. Persistence

New versioned local-storage keys:

- `codex429Guardian.llmProfiles.v2`
- `codex429Guardian.deliveryState.v1`
- `codex429Guardian.deliveryHistory.v1`

Secrets are stored in Keychain, not local storage.

Delivery history stores the latest 20 records:

- timestamp
- project/session
- delivery result
- archive path
- cleanup candidate/result counts
- manifest hash

## 12. Error Handling and Recovery

- Provider failures use the adapter fallback policy.
- Policy failures leave the plan board unchanged.
- Delivery build failures abort cleanup.
- Trash failures do not invalidate the backup.
- A delivery interrupted after archive creation but before cleanup is resumable from `MANIFEST.json`.
- A duplicate confirmation for the same session and commit reuses the completed delivery record rather than creating a duplicate archive.

## 13. Testing

### Unit tests

- Task classification and risk upgrades.
- Required checks for each task level.
- Delivery readiness state machine.
- Provider preset normalization.
- Fallback order, retries, cooldowns, and all-provider failure.
- Keychain adapter behavior with an injected fake.
- Archive inclusion/exclusion rules.
- Cleanup candidate validation and symlink rejection.
- Trash fallback behavior.
- Manifest and hash determinism where timestamps are injected.

### Integration tests

- Mock HTTP servers for OpenAI-compatible, Anthropic, and malformed response scenarios.
- Temporary project with tracked/untracked files.
- ZIP creation, readback, hash verification, and cleanup preview.
- Interrupted delivery resume.
- Duplicate delivery guard.

### E2E tests

- Stable task completes and plan is written.
- Primary provider fails and fallback provider succeeds.
- All providers fail without plan-board pollution.
- Manual delivery confirmation produces a valid archive.
- Cleanup moves only approved candidates to Trash.
- A changed project fingerprint aborts delivery without cleanup.

## 14. Acceptance Criteria

The release is accepted when:

1. The module boundaries in Section 3 exist.
2. No LLM response can directly set delivery-ready state.
3. All supported provider presets share one adapter contract.
4. Primary-to-fallback switching works for auth, timeout, 429, 5xx, and malformed output.
5. API keys are absent from `localStorage`, logs, manifests, and delivery archives after migration.
6. Delivery readiness requires completed plan entries and zero blockers.
7. Delivery always builds a verified backup before cleanup.
8. Cleanup never touches tracked source, docs, evidence, configuration, or user outputs.
9. The second confirmation is mandatory.
10. Unit, integration, and E2E suites pass.
11. Installed `guardian.js` hash matches the repository artifact.
12. A real CDP run demonstrates ready-state detection, backup, and conservative cleanup on a fixture project.

## 15. Rollout

1. Ship behind the new delivery panel state while keeping existing review and plan behavior.
2. Migrate existing credentials on first successful native-daemon start.
3. Preserve existing settings through versioned normalization.
4. Support legacy single-provider configuration as one primary profile.
5. Update README and `HANDOFF-STEWARD.md` after implementation and verification.
