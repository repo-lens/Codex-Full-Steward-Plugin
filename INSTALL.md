# Installation

## Requirements

- macOS
- Codex desktop app installed at `/Applications/ChatGPT.app`
- Node.js 24 from the Codex runtime
- Permission to save one credential item in macOS Keychain

Codex Full Steward Plugin is designed for the local Codex desktop environment. It uses CDP on loopback `127.0.0.1:9229`.

## Install

```bash
git clone https://github.com/repo-lens/Codex-Full-Steward-Plugin.git
cd Codex-Full-Steward-Plugin
bash install.sh
```

The installer copies the user script and registers the native steward daemon with launchd.

Reload the Codex window after installation.

## Verify

```bash
launchctl list | grep codex.guardian.steward
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9229/json
```

Expected:

- One steward launchd entry
- CDP status `200`

Run the repository checks:

```bash
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --test test/*.test.cjs test/*.test.mjs
$NODE --check guardian.js
$NODE --check scripts/steward-daemon.mjs
```

## Configure

1. Open the Full Steward panel from the **管家** pill.
2. Set **项目目录** to the absolute project path.
3. Select a Provider and enter a model.
4. Enter an API key and click **保存**.
5. Confirm the Keychain status becomes configured.
6. Optionally enable and configure a fallback Provider/model.
7. Enable **管家模式**. It is the primary review and planning surface.
8. Configure the plan board only after steward mode is working; 429 recovery is optional.

Ollama profiles may run without an API key when using the local OpenAI-compatible endpoint.

## Upgrade

```bash
git pull --ff-only
bash install.sh
launchctl kickstart -k gui/$(id -u)/codex.guardian.steward
```

Reload the Codex window after the upgrade.

## Optional Legacy Proxy

The current steward calls LLM providers from the native daemon and does not require a browser proxy.

The legacy HTTPS proxy is optional. Private certificate keys are never included in the public repository. Generate local-only credentials when needed:

```bash
bash scripts/generate-local-cert.sh
```

Then follow `scripts/trust-cert.sh` locally.

## Uninstall

```bash
bash uninstall.sh
```

The uninstall script removes the user script, steward launch agent, and stored primary/backup credentials. Project source and delivery archives are not touched.

## Troubleshooting

### Panel does not appear

Reload Codex once after `install.sh`.

### CDP is unavailable

Confirm the Codex desktop window is open. CDP is expected to be unavailable when Codex is closed.

### Keychain reports missing

Open the panel, enter the key again, click **保存**, and approve the macOS Keychain prompt.

### Provider fails

Check the audit log error tag. Common tags include `auth`, `network`, `ratelimit`, `upstream`, and `format`.
