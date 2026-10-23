# Security

## Credential Storage

API keys are stored in macOS Keychain under service `codex-guardian`.

The page never displays an existing key. After migration, `llmApiKey` is removed from settings in localStorage.

Credentials are never written to:

- plugin logs;
- delivery manifests;
- ZIP archives;
- trace output;
- error messages.

## Public Repository Secret Policy

The public repository must not contain:

- private certificate keys;
- `.env` files;
- API tokens;
- local `.guardian` state;
- machine-specific settings;
- delivery test archives.

`resources/cert/*.key` is ignored and excluded from the public release snapshot.

## CDP

The daemon connects only to loopback CDP at `127.0.0.1:9229`.

CDP can expose page content. Users should:

- keep the Codex desktop app local;
- avoid untrusted local processes that can access the debug port;
- close Codex when not in use if the debug port is not needed.

## Prompt Injection

Project files, web content, issue text, and task output are untrusted data.

The steward must not follow instructions embedded in analyzed files that ask it to:

- reveal credentials;
- change its security policy;
- execute unrelated commands;
- upload private data;
- bypass delivery confirmation.

The native policy engine and the user confirmation gate remain authoritative.

## Delivery Safety

Delivery requires:

- a ready decision from the policy engine;
- a fresh preview token;
- explicit user confirmation twice;
- unchanged project fingerprint;
- valid ZIP structure;
- matching SHA-256 hashes.

If any check fails, cleanup is skipped.

## Cleanup Safety

Only these paths may move to Trash:

- `.guardian/cache/**`
- `.guardian/tmp/**`
- current-session `context-cache.json`
- `.guardian/**/*.tmp`

Never eligible:

- Git-tracked files;
- source, tests, docs, evidence files;
- configuration;
- user outputs;
- symlinks;
- paths outside the project root.

## Reporting a Vulnerability

Open a private GitHub security advisory in the repository:

```text
Security -> Advisories -> New draft security advisory
```

Do not include API keys, private project files, or personal data in a public issue.
