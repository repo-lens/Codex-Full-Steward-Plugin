# Architecture

## Overview

```text
Codex page
  guardian.js
    UI, plan board, provider settings, delivery preview, draggable panel
        |
        | localStorage request flags + CDP loopback
        v
Native steward daemon
  steward-daemon.mjs
    orchestration, context collection, CDP bridge, request handling
        |
        +-- policy-engine.mjs
        +-- llm-adapters.mjs
        +-- credential-store.mjs
        +-- delivery-manager.mjs
```

## Why a Native Daemon

Codex runs in an `app://` security context. Browser-origin fetch requests to external providers and local proxy services are blocked by CORS, mixed-content, private-network, and certificate policy.

The page therefore performs no LLM network request. It writes a small request flag to localStorage. The native daemon reads the flag through loopback CDP and performs the provider request using Node.

## Modules

### `guardian.js`

Responsibilities:

- Render the floating panel.
- Manage session-specific plan boards.
- Detect task states.
- Detect and recover 429 states.
- Manage provider and delivery UI state.
- Preserve panel position.
- Bridge requests through localStorage.

### `scripts/steward-daemon.mjs`

Responsibilities:

- Poll Codex through CDP.
- Collect task output, project documents, Git state, plan state, and review logs.
- Invoke the policy engine and provider chain.
- Validate model output.
- Write clean plans or evidence requests back to the page.
- Handle credential and delivery requests.

### `scripts/policy-engine.mjs`

Pure deterministic functions for:

- task classification;
- required quality checks;
- delivery readiness;
- plan quality validation.

The model can propose an action but cannot mark delivery ready.

### `scripts/llm-adapters.mjs`

- Provider presets and protocol normalization.
- Primary/fallback ordering.
- Timeouts, 429 retries, 5xx retries, and cooldowns.
- Response parsing.
- Secret-free attempt records.

### `scripts/credential-store.mjs`

Wraps macOS `security` commands for Keychain access. Tests inject a fake runner and never touch the real Keychain.

### `scripts/delivery-manager.mjs`

- Builds a delivery preview.
- Enumerates included and excluded files.
- Creates a ZIP and manifest.
- Verifies hashes and archive structure.
- Moves only pre-approved runtime candidates to Trash.

## Lifecycle

```text
completed stable task
  -> policy classification
  -> context collection
  -> model analysis with fallback
  -> deterministic validation
  -> plan writeback or evidence request
  -> next task
  -> delivery readiness
  -> user preview
  -> first confirmation
  -> second confirmation
  -> verified backup
  -> conservative Trash cleanup
```

## Session Isolation

Plans are keyed by a content fingerprint derived from the first message of the Codex session. Session-specific docs live under:

```text
.guardian/sessions/<session-key>/
```

The daemon refuses to read another session's private directory.

## Security Boundaries

- CDP is loopback-only.
- LLM requests execute in the native daemon.
- API keys are stored in Keychain.
- Delivery is explicitly user-confirmed.
- Project fingerprints detect changes during backup.
- Cleanup never follows symlinks or leaves the project root.

See [SECURITY.md](SECURITY.md).
