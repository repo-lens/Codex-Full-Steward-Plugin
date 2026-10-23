# Usage

## Start

1. Open the Full Steward panel from the **管家** pill.
2. Set the project root.
3. Configure the primary model and optional fallback model.
4. Enable the steward.
5. Choose a review focus.

Product order: steward review first, plan-board execution second, optional 429 recovery last.

## Movable Panel

Drag from any non-interactive blank area of the panel.

The panel:

- stays inside the Codex viewport;
- re-clamps after window resize;
- restores its position after reload;
- provides **复位位置** in the footer.

Buttons, inputs, text areas, selects, links, and editable fields never initiate dragging.

## Plan Board

- Each Codex session has an isolated plan bucket.
- The current entry is imported only after the latest task is complete and its result is stable.
- The default countdown is 30 seconds.
- Disable the countdown to pause automatic import.
- Use **立即导入** when paused.
- Entries can be edited, reordered, or cleared.

## Steward Review

The steward:

1. Classifies the task and risk level.
2. Reads the main task output, project docs, plan board, and Git changes.
3. Requests an evidence document if the available context is insufficient.
4. Uses the primary model with automatic fallback.
5. Validates the proposed next plan with deterministic gates.
6. Writes only the clean instruction to the plan board.

## Review Focuses

- 全量
- 下一步
- 修改
- 优化
- 开发
- 验收
- 性能
- 文档

## Provider Fallback

Supported providers:

- OpenAI
- Anthropic
- DashScope
- DeepSeek
- OpenRouter
- Ollama
- Custom OpenAI-compatible endpoint

Fallback behavior:

| Failure | Behavior |
|---|---|
| 401 / 403 | Switch Provider immediately |
| 429 / 5xx | Backoff, retry, then switch |
| Network / timeout | Backoff, retry, then switch |
| Invalid response format | One stricter retry, then switch |
| All Providers fail | Keep the plan board unchanged; record a tagged error |

## Credentials

API keys are stored in macOS Keychain under service `codex-guardian`.

The page receives only configured/missing status. It does not display the saved secret.

## Delivery

Delivery becomes available only when:

- all required plan entries are complete;
- required quality checks pass;
- blocking issues are zero;
- no unresolved review error remains;
- a verified backup is available.

Click **预览交付** to inspect included files, exclusions, and cleanup candidates. Click **继续确认**, then **确认执行交付**. Both confirmations are mandatory.

## Backup Output

```text
outputs/guardian-delivery-YYYYMMDD-HHmmss/
├── delivery.zip
├── MANIFEST.json
├── SHA256SUMS
└── DELIVERY-README.md
```

## Conservative Cleanup

Cleanup candidates are limited to:

- `.guardian/cache/**`
- `.guardian/tmp/**`
- current session `context-cache.json`
- `.guardian/**/*.tmp`

Source, docs, tracked files, evidence Markdown, configuration, and user outputs are never cleanup candidates.

Files move to Finder Trash, with a `~/.Trash` fallback when needed.

## Troubleshooting

See [INSTALL.md](INSTALL.md#troubleshooting) and [SECURITY.md](SECURITY.md).
