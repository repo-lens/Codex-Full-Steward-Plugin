# Codex Full Steward Plugin Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Codex Full Steward Plugin v2.0.0 with a draggable floating panel, complete public documentation, competitive analysis, dark HUD posters, and a clean public GitHub repository.

**Architecture:** Extend the page UI with pure position-clamping and drag-start helpers plus Pointer Events. Build the public repository from an allowlisted clean snapshot, never from existing Git history. Generate poster backgrounds with the image-generation skill, overlay exact text locally, then publish and verify the repository and release.

**Tech Stack:** Node.js 24, vanilla JavaScript, CDP, `node:test`, GitHub CLI, ImageGen, local image compositing.

**Spec:** `docs/superpowers/specs/2026-10-23-codex-full-steward-public-release-design.md`

## Global Constraints

- Product name: `Codex Full Steward Plugin`.
- Version: `v2.0.0`.
- Repository: `repo-lens/Codex-Full-Steward-Plugin`.
- Visibility: Public.
- License: MIT.
- Attribution: `Built By Yang YiZhu`.
- No existing `.git` history in the public repository.
- Never publish `resources/cert/*.key`, credentials, caches, logs, outputs, or machine-specific data.
- Horizontal poster: 1280×640.
- Vertical poster: 1080×1440.
- No claim may say the product is the only or best product in its category.
- Every code behavior begins with a failing test.

---

### Task 1: Panel Position Helpers

**Files:**
- Modify: `guardian.js`
- Test: `test/panel-drag.test.cjs`

**Interfaces:**
- Produces:
  - `clampPanelPosition({ x, y, width, height, viewportWidth, viewportHeight, margin })`
  - `defaultPanelPosition({ width, height, viewportWidth, viewportHeight, margin })`
  - `canStartPanelDrag({ tagName, isContentEditable, noDrag, disabled })`

- [ ] **Step 1: Write failing tests**

```js
test("clamps positions fully inside the viewport", () => {
  assert.deepEqual(
    core.clampPanelPosition({ x: -50, y: 9999, width: 248, height: 600, viewportWidth: 1440, viewportHeight: 900 }),
    { x: 8, y: 292 },
  );
});

test("buttons and editable nodes cannot start dragging", () => {
  assert.equal(core.canStartPanelDrag({ tagName: "BUTTON" }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV", isContentEditable: true }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV", noDrag: true }), false);
  assert.equal(core.canStartPanelDrag({ tagName: "DIV" }), true);
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/panel-drag.test.cjs
```

Expected: FAIL with missing functions.

- [ ] **Step 3: Implement pure helpers and export them**

Implement margin default `8`, viewport clamping, default bottom-right position, and interactive-element blocking.

- [ ] **Step 4: Run tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/panel-drag.test.cjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/*.test.cjs test/*.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add guardian.js test/panel-drag.test.cjs
git commit -m "feat: add floating panel position helpers"
```

---

### Task 2: Pointer Drag, Persistence, Reset, and Attribution

**Files:**
- Modify: `guardian.js`
- Test: `test/panel-drag.test.cjs`
- Test: `test/guardian.test.cjs`

**Interfaces:**
- Consumes helpers from Task 1.
- Adds `SELECTORS.ui.panelResetPosition`.
- Adds `api.resetPanelPosition()`.

- [ ] **Step 1: Add failing selector and attribution tests**

```js
test("panel controls expose reset and attribution selectors", () => {
  assert.ok(core.SELECTORS.ui.panelResetPosition);
  assert.ok(core.SELECTORS.ui.attribution);
});
```

- [ ] **Step 2: Implement drag behavior**

Pointer-down on blank panel space:

```js
if (!canStartPanelDrag({ tagName: target.tagName, isContentEditable: target.isContentEditable, noDrag: target.closest("[data-no-drag]"), disabled: target.disabled })) return;
```

Use pointer capture. Track delta. Compute clamped position with `clampPanelPosition`. Apply `left` and `top`; set `right: auto` and `bottom: auto`. Persist on pointer-up.

On startup and resize, re-clamp the saved position. Add footer button `复位位置` and `Built By Yang YiZhu`.

- [ ] **Step 3: Add runtime reset API**

```js
resetPanelPosition: () => {
  position = defaultPanelPosition(...);
  localStorage.removeItem(PANEL_POS_KEY);
  applyPanelPosition();
  return position;
}
```

- [ ] **Step 4: Run tests and syntax checks**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/*.test.cjs test/*.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check guardian.js
```

- [ ] **Step 5: Commit**

```bash
git add guardian.js test/panel-drag.test.cjs test/guardian.test.cjs
git commit -m "feat: make floating panel draggable and persistent"
```

---

### Task 3: Competitive Research and Product Documentation

**Files:**
- Create: `INSTALL.md`
- Create: `USAGE.md`
- Create: `ARCHITECTURE.md`
- Create: `SECURITY.md`
- Create: `SCORECARD.md`
- Create: `COMPETITIVE-ANALYSIS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes current test outputs, UI screenshots, and verified feature list.
- Produces public product documentation.

- [ ] **Step 1: Research current GitHub products**

Use GitHub search and official sources for:

- GitHub Copilot coding agent / code review
- Claude Code
- Cline
- OpenHands
- Aider
- Sweep
- Continue

Record research date, repository URL, primary workflow, and observable capabilities.

- [ ] **Step 2: Write competitive analysis**

Include:

- Method and limitations.
- Product category distinction.
- Feature matrix.
- Where Codex Full Steward Plugin is differentiated.
- Where other products are stronger.
- No unsupported superiority claims.

- [ ] **Step 3: Write public docs**

Required content follows the spec. Use exact install commands and verified test results.

- [ ] **Step 4: Rewrite README**

README order:

1. Horizontal poster
2. Product title and value proposition
3. Screenshot
4. Core lifecycle diagram
5. Features
6. Quick install
7. Usage
8. Provider fallback and Keychain
9. Delivery safety
10. Competitive summary link
11. Scorecard link
12. Attribution

- [ ] **Step 5: Validate links and commands**

```bash
rg -n "TODO|TBD|FIXME" README.md INSTALL.md USAGE.md ARCHITECTURE.md SECURITY.md SCORECARD.md COMPETITIVE-ANALYSIS.md
```

Expected: no placeholder output.

- [ ] **Step 6: Commit**

```bash
git add README.md INSTALL.md USAGE.md ARCHITECTURE.md SECURITY.md SCORECARD.md COMPETITIVE-ANALYSIS.md
git commit -m "docs: add public product and competitive documentation"
```

---

### Task 4: Dark HUD Posters

**Files:**
- Create: `assets/poster-horizontal.png`
- Create: `assets/poster-vertical.png`
- Create: `assets/poster-source/` intermediate files as needed.
- Modify: `README.md`

**Interfaces:**
- Consumes product positioning and feature copy.
- Produces exact-size, text-verified poster assets.

- [ ] **Step 1: Read the ImageGen skill instructions**

Use the `imagegen` skill before generating assets.

- [ ] **Step 2: Generate the visual base**

Generate a dark control-room/HUD visual without relying on small generated text. Reserve large safe areas for deterministic copy.

- [ ] **Step 3: Overlay deterministic text**

Horizontal:

```text
Codex Full Steward Plugin
Review. Decide. Plan. Deliver.
Quality gates · Model fallback · Verified delivery
```

Vertical:

```text
Codex Full Steward Plugin
Your Codex task steward
Review → Plan → Execute → Deliver
```

Both include `Built By Yang YiZhu`.

- [ ] **Step 4: Verify dimensions and readability**

Check:

- Horizontal exactly 1280×640.
- Vertical exactly 1080×1440.
- Title and attribution are not clipped.
- No overlapping text.
- PNG files are nonblank.
- Visual inspection passes.

- [ ] **Step 5: Add posters to README and commit**

```bash
git add assets/poster-horizontal.png assets/poster-vertical.png README.md
git commit -m "docs: add dark HUD product posters"
```

---

### Task 5: Clean Public Snapshot

**Files:**
- Create outside existing Git history: clean staging directory.
- Create: optional `scripts/generate-local-cert.sh`
- Modify: `.gitignore`

**Interfaces:**
- Consumes release files from the current working tree.
- Produces a fresh Git repository with one initial commit.

- [ ] **Step 1: Remove private keys from the release working tree**

- Delete tracked `resources/cert/*.key` from the release branch.
- Add `resources/cert/*.key` to `.gitignore`.
- Add `scripts/generate-local-cert.sh` to create local-only optional proxy credentials.
- Keep public certificates and configuration only if they contain no private material.

- [ ] **Step 2: Create clean staging directory**

Copy an allowlist of release files into `/tmp/Codex-Full-Steward-Plugin-release`.

- [ ] **Step 3: Scan for secrets**

Run checks for private keys, API tokens, local home paths, caches, and artifact directories.

- [ ] **Step 4: Run the full test suite in staging**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/*.test.cjs test/*.test.mjs
```

- [ ] **Step 5: Initialize clean Git history**

```bash
git init
git add .
git commit -m "Initial release: Codex Full Steward Plugin v2.0.0"
git tag v2.0.0
```

- [ ] **Step 6: Create release ZIP and checksum**

Exclude `.git` from the asset. Verify with `unzip -t` and SHA-256.

---

### Task 6: GitHub Publication and Final Verification

**Files:**
- GitHub repository: `repo-lens/Codex-Full-Steward-Plugin`
- Release: `v2.0.0`

**Interfaces:**
- Consumes clean snapshot Git repository.
- Produces public repository, release, social preview, and final score.

- [ ] **Step 1: Check repository does not already exist**

```bash
gh repo view repo-lens/Codex-Full-Steward-Plugin
```

Expected: not found. If found, stop and inspect.

- [ ] **Step 2: Create the public repository**

```bash
gh repo create repo-lens/Codex-Full-Steward-Plugin --public --source . --remote origin --push
```

- [ ] **Step 3: Configure metadata**

Set description, homepage if available, and topics.

- [ ] **Step 4: Create release**

Upload:

- `Codex-Full-Steward-Plugin-v2.0.0.zip`
- `SHA256SUMS`

- [ ] **Step 5: Upload social preview**

Use `assets/poster-horizontal.png`.

- [ ] **Step 6: Verify public state**

- Repository visibility is Public.
- Default branch is `main`.
- README renders.
- Posters render.
- Release and tag exist.
- No secrets tracked.
- Installer ZIP validates.
- Repository URL is reachable.

- [ ] **Step 7: Run final installed-plugin verification**

- Installed guardian hash matches local `guardian.js`.
- UI version is v2.0.0.
- steward and LLM proxy are running.
- CDP responds.
- Panel drag persists and clamps.
- DOM overlap audit reports zero overlaps.
- Real E2E passes.

- [ ] **Step 8: Produce comprehensive score**

Score:

- Functional completeness
- Quality/strategy
- Resilience
- Security/delivery
- UI/UX
- Documentation
- Competitive clarity
- Commercial readiness

Report the public repository URL, release URL, installation path, test results, and residual risks.
