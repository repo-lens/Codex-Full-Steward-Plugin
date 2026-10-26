# Codex Full Steward Plugin Public Release Design

- Date: 2026-10-23
- Status: Approved in conversation; pending written-spec review
- Product: Codex Full Steward Plugin
- Version: v2.0.0
- Repository: `repo-lens/Codex-Full-Steward-Plugin`
- Visibility: Public
- License: MIT

## 1. Objective

Publish the completed Codex Guardian v2.0.0 as a polished public product repository while improving the floating panel interaction and product presentation.

The release must:

1. Make the floating panel movable from non-interactive panel space.
2. Persist and clamp the panel position and provide a reset action.
3. Embed `Built By Yang YiZhu` in the plugin UI and source metadata.
4. Create a clean public repository without private keys or internal history.
5. Provide complete installation, usage, architecture, security, competitive, and scoring documentation.
6. Include dark HUD-style horizontal and vertical promotional posters.
7. Publish a v2.0.0 tag and GitHub release.

## 2. Non-goals

- Publishing the existing `.git` history.
- Publishing private certificate keys, local credentials, caches, or test artifacts.
- Claiming the product is the only tool in the market.
- Presenting generated marketing copy as independently verified benchmarks.
- Changing the steward lifecycle architecture beyond what is needed for this release.

## 3. Floating Panel Movement

### 3.1 Drag surface

The entire floating panel is draggable except interactions with:

- `button`
- `input`
- `textarea`
- `select`
- links
- contenteditable fields
- elements explicitly marked `data-no-drag`
- scrollable content while the pointer is actively scrolling

Dragging is initiated by a pointer press on eligible blank panel space.

### 3.2 Position behavior

- Position is stored in viewport coordinates.
- The panel must remain fully inside the current browser viewport.
- A minimum visible margin of 8px is enforced horizontally and vertically.
- Position is persisted in localStorage under `codex429Guardian.panel.pos.v1`.
- Position is restored on page load if still valid.
- Window resize re-clamps the panel.
- A reset-position action restores the default bottom-right placement.

### 3.3 Accessibility and interaction safety

- Buttons and input interactions must not trigger dragging.
- Text selection inside editable elements must not be disrupted.
- Clicking a control after a pointer near-drag must not be swallowed.
- Dragging updates transform/position without rebuilding the panel DOM.
- Keyboard access to all controls remains unchanged.

### 3.4 Attribution

`Built By Yang YiZhu` is present:

- In the panel footer.
- In a source-level product metadata constant.
- In README and repository metadata.

## 4. Public Repository Construction

### 4.1 Clean snapshot strategy

The public repository is built from a fresh snapshot of the current v2.0.0 working tree.

No original `.git` directory or historical commits are copied.

The snapshot excludes:

- `.git`
- `.worktrees`
- `node_modules`
- `.guardian`
- `outputs/guardian-tests`
- `.DS_Store`
- `*.log`
- `resources/cert/*.key`
- any API keys, local settings, credentials, or machine-specific paths

The repository begins with a clean initial commit.

### 4.2 Required public files

```text
Codex-Full-Steward-Plugin/
├── README.md
├── INSTALL.md
├── USAGE.md
├── COMPETITIVE-ANALYSIS.md
├── SECURITY.md
├── ARCHITECTURE.md
├── SCORECARD.md
├── LICENSE
├── guardian.js
├── package.json
├── install.sh
├── uninstall.sh
├── scripts/
├── resources/
├── assets/
├── test/
└── docs/
```

### 4.3 Optional local proxy certificates

Pre-generated private keys are not included.

A local certificate generation script may be added so users can create their own optional development proxy credentials. Public certificate files must never be committed by default.

## 5. GitHub Repository

Repository slug:

```text
repo-lens/Codex-Full-Steward-Plugin
```

Settings:

- Public
- Description: `Local-first AI task steward for Codex: quality gates, model fallback, plan execution, delivery backup, and unattended review.`
- Default branch: `main`
- Topics: `codex`, `ai-agent`, `code-review`, `automation`, `llm`, `macos`, `launchd`, `cdp`, `developer-tools`
- License: MIT
- Social preview: horizontal HUD poster

### 5.1 Release

Create tag `v2.0.0` and publish a GitHub Release containing:

- Release notes
- Installer ZIP
- SHA-256 checksum
- Link to installation and security docs

## 6. Documentation

### 6.1 README

Required sections:

- Product name and poster
- One-sentence positioning
- Current version and compatibility
- Screenshots
- Core lifecycle flow
- Feature overview
- Installation quick start
- Usage summary
- Provider fallback and Keychain
- Delivery and cleanup
- Security model
- Competitive differentiation summary
- Test and score summary
- License and attribution

### 6.2 INSTALL.md

Document:

- macOS requirements
- Codex desktop requirement
- Node runtime
- Installer
- launchd service
- Keychain authorization
- Provider configuration
- Verification commands
- Upgrade and uninstall

### 6.3 USAGE.md

Document:

- Plan board
- Steward trigger modes
- Provider profiles and fallback
- Review modes
- Delivery readiness
- Backup preview
- Two-step confirmation
- Trash recovery
- Troubleshooting

### 6.4 ARCHITECTURE.md

Document:

- Page UI and CDP bridge
- Native daemon
- Policy engine
- Provider adapters
- Keychain
- Delivery manager
- State and request flags
- Security boundaries

### 6.5 SECURITY.md

Document:

- Keychain-only credentials
- Secret exclusions
- Untrusted target content
- CDP scope
- Prompt injection boundaries
- Cleanup safety
- Public-release secret policy
- Vulnerability reporting

### 6.6 SCORECARD.md

Record:

- Unit test count
- E2E result
- Functional round score
- Safety round score
- UI overlap audit
- Installed artifact hash
- Residual risks

### 6.7 COMPETITIVE-ANALYSIS.md

Research method:

- Search GitHub repositories and official product documentation.
- Use only observable public capabilities.
- Include research date.
- Distinguish verified facts from inference.
- Avoid unsupported “best” or “only” claims.

Comparison categories:

- Primary use case
- Codex desktop integration
- Automatic review
- Plan writeback
- Unattended loop
- Quality gates
- Multi-provider fallback
- Keychain credentials
- Session isolation
- 429 recovery
- Delivery backup
- Manual delivery confirmation

Candidate products:

- GitHub Copilot code review and coding agent
- Claude Code
- Cline
- OpenHands
- Aider
- Sweep
- Continue

Candidates may be changed if current research identifies more relevant public tools.

## 7. Poster Design

### 7.1 Shared direction

Style:

- Dark control-room / HUD
- Deep navy-black background
- Cyan, blue, amber, and restrained red accents
- Technical grid and workflow traces
- Product UI fragments
- Clear hierarchy
- Exact product name rendered by deterministic typography overlay

Core message:

```text
Codex Full Steward Plugin
Review. Decide. Plan. Deliver.
```

Supporting capabilities:

- Quality gates
- Model fallback
- Plan execution
- Verified delivery
- Safe cleanup

### 7.2 Horizontal poster

- Size: 1280×640
- Use: GitHub Social Preview and README hero
- Product name prominent in first visual scan
- Avoid small unreadable text
- Include `Built By Yang YiZhu`

### 7.3 Vertical poster

- Preferred size: 1080×1440
- Use: social sharing and project introduction
- Feature flow from review to delivery
- Strong product title and concise capability labels
- Include `Built By Yang YiZhu`

### 7.4 Asset generation

- Generate a dark HUD bitmap background with the image-generation skill.
- Overlay product name, feature copy, score, and attribution using deterministic local rendering.
- Validate exported PNG dimensions, text fit, and visual readability.

## 8. Safe Publish Workflow

1. Create clean staging directory.
2. Copy allowlisted release files.
3. Scan for secrets and private keys.
4. Verify no symlinks escape the snapshot.
5. Run tests inside the staging directory.
6. Create new Git repository and initial commit.
7. Create GitHub repository under `repo-lens`.
8. Push `main`.
9. Create tag and release.
10. Upload posters and release asset.
11. Verify repository visibility, default branch, README rendering, release asset, and social preview.

If the repository already exists, stop and inspect before modifying it.

## 9. Verification

### Code tests

- Existing unit and integration tests pass.
- Syntax checks pass.
- Functional score round passes.
- Safety score round passes.
- Real CDP E2E passes.

### Panel tests

- Drag from blank panel areas.
- Controls do not initiate drag.
- Position persists after reload.
- Position clamps after viewport resize.
- Reset returns to default.
- Attribution appears.
- DOM overlap audit reports zero overlaps.

### Public repository checks

- No private keys in tracked files.
- No internal history copied.
- README links resolve.
- Posters render at intended dimensions.
- GitHub repository is Public.
- `main` is default.
- Release asset checksum verifies.

## 10. Acceptance Criteria

The release is accepted when:

1. The floating panel is movable from blank areas and position persists.
2. `Built By Yang YiZhu` appears in UI and source.
3. A clean Public repository exists at `repo-lens/Codex-Full-Steward-Plugin`.
4. No private key or local credential is tracked.
5. Complete documentation files are present.
6. Competitive analysis uses current public sources and records limitations.
7. Horizontal and vertical dark HUD posters are included.
8. v2.0.0 tag and release exist.
9. Tests and UI overlap checks pass.
10. The final report includes installation path, GitHub URL, release URL, and comprehensive score.
