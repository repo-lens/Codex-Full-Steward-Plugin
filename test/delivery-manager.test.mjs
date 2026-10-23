import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createDeliveryPreview,
  createDelivery,
  applyCleanup,
  verifyDelivery,
} from "../scripts/delivery-manager.mjs";

function readyDecision() {
  return {
    taskLevel: "feature",
    deliveryState: "ready-for-confirmation",
    blockingIssues: [],
  };
}

async function makeProject(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "guardian-delivery-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const write = async (relative, body) => {
    const file = path.join(root, relative);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, body);
  };
  await write("src/index.js", "export const value = 1;\n");
  await write("README.md", "# Fixture\n");
  await write("docs/guide.md", "# Guide\n");
  await write("package.json", "{\"name\":\"fixture\"}\n");
  await write("outputs/asset.txt", "deliver me\n");
  await write("outputs/guardian-delivery-old/old.zip", "old\n");
  await write(".env", "SECRET=do-not-archive\n");
  await write("node_modules/fake/index.js", "dependency\n");
  await write(".git/config", "git metadata\n");
  await write(".guardian/cache/cache.json", "{}\n");
  await write(".guardian/tmp/temp.tmp", "tmp\n");
  await write(".guardian/sessions/fp_test/context-cache.json", "{}\n");
  return root;
}

test("preview includes source outputs and excludes secrets Git dependencies and prior deliveries", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({
    projectRoot: root,
    sessionKey: "fp_test",
    decision: readyDecision(),
  });
  assert.ok(preview.include.includes("src/index.js"));
  assert.ok(preview.include.includes("README.md"));
  assert.ok(preview.include.includes("docs/guide.md"));
  assert.ok(preview.include.includes("outputs/asset.txt"));
  assert.ok(preview.exclude.some((item) => item.path === ".env"));
  assert.ok(preview.exclude.some((item) => item.path === ".git"));
  assert.ok(preview.exclude.some((item) => item.path === "node_modules"));
  assert.ok(preview.exclude.some((item) => item.path === "outputs/guardian-delivery-old"));
  assert.ok(preview.cleanupCandidates.some((item) => item.path === ".guardian/cache/cache.json"));
  assert.ok(preview.cleanupCandidates.some((item) => item.path === ".guardian/tmp/temp.tmp"));
  assert.ok(preview.cleanupCandidates.some((item) => item.path === ".guardian/sessions/fp_test/context-cache.json"));
  assert.ok(!preview.cleanupCandidates.some((item) => item.path === "src/index.js"));
});

test("delivery creates zip manifest checksums and verifies readback", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  const result = await createDelivery({
    projectRoot: root,
    preview,
    userConfirmed: true,
    now: () => new Date("2026-10-23T00:00:00Z"),
  });
  assert.equal(result.ok, true, result.error);
  assert.ok(fs.existsSync(result.archivePath));
  assert.ok(fs.existsSync(path.join(result.deliveryDir, "MANIFEST.json")));
  assert.ok(fs.existsSync(path.join(result.deliveryDir, "SHA256SUMS")));
  const listing = spawnSync("/usr/bin/unzip", ["-Z1", result.archivePath], { encoding: "utf8" });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /src\/index\.js/);
  assert.doesNotMatch(listing.stdout, /(?:^|\n)\.env(?:\n|$)/);
  assert.doesNotMatch(listing.stdout, /node_modules/);
  assert.doesNotMatch(listing.stdout, /guardian-delivery-old/);
  const verification = await verifyDelivery({ deliveryDir: result.deliveryDir });
  assert.equal(verification.ok, true);
});

test("cleanup moves only approved runtime candidates", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  const moved = [];
  const cleanup = await applyCleanup({
    projectRoot: root,
    preview,
    trashImpl: async ({ relativePath, destination }) => {
      moved.push(relativePath);
      return { ok: true, mode: "trash", destination };
    },
  });
  assert.equal(cleanup.ok, true);
  assert.ok(moved.includes(".guardian/cache/cache.json"));
  assert.ok(moved.includes(".guardian/tmp/temp.tmp"));
  assert.ok(!moved.includes("src/index.js"));
  assert.equal(cleanup.deliveryValid, true);
});

test("cleanup failure keeps delivery valid", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  const cleanup = await applyCleanup({
    projectRoot: root,
    preview,
    trashImpl: async () => ({ ok: false, error: "finder denied" }),
  });
  assert.equal(cleanup.ok, false);
  assert.equal(cleanup.deliveryValid, true);
});

test("cleanup excludes symlinks", async (t) => {
  const root = await makeProject(t);
  const link = path.join(root, ".guardian/cache/link");
  await fs.promises.symlink(path.join(root, "src/index.js"), link);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  assert.ok(!preview.cleanupCandidates.some((item) => item.path === ".guardian/cache/link"));
  assert.ok(preview.exclude.some((item) => item.path === ".guardian/cache/link" && item.category === "symlink"));
});

test("delivery abort on changed fingerprint before verification", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  const result = await createDelivery({
    projectRoot: root,
    preview,
    userConfirmed: true,
    zipRunner(args, input, options) {
      fs.writeFileSync(path.join(root, "src/changed-after-preview.js"), "changed\n");
      return spawnSync("/usr/bin/zip", args, { ...options, input });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "project-changed");
});

test("delivery requires explicit user confirmation", async (t) => {
  const root = await makeProject(t);
  const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp_test", decision: readyDecision() });
  const result = await createDelivery({ projectRoot: root, preview, userConfirmed: false });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "confirmation-required");
});
