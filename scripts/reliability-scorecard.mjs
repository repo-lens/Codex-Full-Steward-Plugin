import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { classifyTask, validateProposedPlan, requiredChecksFor, evaluateDeliveryReadiness } from "./policy-engine.mjs";
import { normalizeProfiles, requestWithFallback } from "./llm-adapters.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { createDeliveryPreview, createDelivery, verifyDelivery, applyCleanup } from "./delivery-manager.mjs";

export function scoreChecks(checks = []) {
  const list = Array.isArray(checks) ? checks : [];
  const total = list.reduce((sum, check) => sum + (Number(check.weight) || 1), 0);
  if (!total) return 0;
  const passed = list.reduce((sum, check) => sum + (check.passed ? (Number(check.weight) || 1) : 0), 0);
  return Math.round((passed / total) * 100) / 10;
}

export function overallScore(dimensions = {}) {
  const values = Object.values(dimensions).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function check(id, dimension, passed, weight = 1, detail = "") {
  return { id, dimension, passed: Boolean(passed), weight, detail };
}

async function functionalChecks() {
  const checks = [];
  const feature = classifyTask({ taskText: "Add export feature", changedPaths: ["src/export.js"] });
  const highRisk = classifyTask({ taskText: "Migrate login auth data", changedPaths: ["src/auth.js"] });
  checks.push(check("policy-feature", "functional", feature.level === "feature", 2, feature.level));
  checks.push(check("policy-high-risk", "security", highRisk.level === "high-risk", 2, highRisk.level));

  const badPlan = validateProposedPlan({
    planText: "Install clap and update to latest",
    sourceText: "README promises --dry-run but src/main.rs has no implementation",
  });
  const goodPlan = validateProposedPlan({
    planText: "Implement --dry-run in src/main.rs. Acceptance: cargo run -- --dry-run prints files and writes nothing",
    sourceText: "README promises --dry-run but src/main.rs has no implementation",
  });
  checks.push(check("plan-reject-low-quality", "quality", !badPlan.ok, 2, badPlan.reasons.map((item) => item.code).join(",")));
  checks.push(check("plan-accept-behavior", "quality", goodPlan.ok, 2, goodPlan.coveredAnchors.join(",")));

  const profiles = [
    { id: "primary", provider: "openai", baseUrl: "https://primary.example/v1", model: "primary", enabled: true, priority: 1, credentialRef: "primary" },
    { id: "backup", provider: "openai", baseUrl: "https://backup.example/v1", model: "backup", enabled: true, priority: 2, credentialRef: "backup" },
  ];
  const fallbackResult = await requestWithFallback({
    profiles,
    prompt: "score",
    credentialStore: { get: async () => "hidden" },
    fetchImpl: async (url) => url.includes("primary")
      ? new Response("unauthorized", { status: 401 })
      : Response.json({ choices: [{ message: { content: "ok" } }] }),
    sleep: async () => {},
  });
  checks.push(check("provider-fallback", "resilience", fallbackResult.ok && fallbackResult.profileId === "backup", 3, fallbackResult.profileId || fallbackResult.errorCode));

  const failedResult = await requestWithFallback({
    profiles,
    prompt: "score",
    credentialStore: { get: async () => "super-secret" },
    fetchImpl: async () => new Response("failed", { status: 500 }),
    sleep: async () => {},
    maxTransientRetries: 0,
  });
  checks.push(check("provider-failure-safe", "observability", !failedResult.ok && !JSON.stringify(failedResult).includes("super-secret"), 2, failedResult.errorCode));

  const decision = evaluateDeliveryReadiness({
    taskLevel: "feature",
    planEntries: [{ text: "done", done: false }],
    reviewErrors: [],
    checks: requiredChecksFor("feature").map((item) => ({ ...item, status: "pass" })),
    backupVerified: false,
  });
  checks.push(check("delivery-gated", "delivery", decision.deliveryState === "needs-work", 2, `${decision.blockingIssues.length} blockers`));
  return checks;
}

async function makeFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "guardian-score-"));
  const write = async (rel, value) => {
    const file = path.join(root, rel);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, value);
  };
  await write("src/index.js", "export const ok = true;\n");
  await write("README.md", "# Score fixture\n");
  await write(".env", "SECRET=never-archive\n");
  await write("node_modules/pkg/index.js", "dependency\n");
  await write(".guardian/cache/cache.json", "{}\n");
  await write("outputs/user.txt", "keep\n");
  return root;
}

async function safetyChecks() {
  const checks = [];
  const root = await makeFixture();
  try {
    const decision = {
      deliveryState: "ready-for-confirmation",
      taskLevel: "feature",
      blockingIssues: [],
    };
    const preview = createDeliveryPreview({ projectRoot: root, sessionKey: "fp:score", decision, now: () => Date.parse("2026-10-23T00:00:00Z") });
    const archive = await createDelivery({ projectRoot: root, preview, userConfirmed: true, now: () => new Date("2026-10-23T00:00:00Z") });
    checks.push(check("archive-created", "delivery", archive.ok, 2, archive.errorCode || archive.deliveryDir));
    if (archive.ok) {
      const listing = spawnSync("/usr/bin/unzip", ["-Z1", archive.archivePath], { encoding: "utf8" });
      const text = String(listing.stdout || "");
      checks.push(check("secret-excluded", "security", !/(?:^|\n)\.env(?:\n|$)/.test(text), 3));
      checks.push(check("source-included", "delivery", /src\/index\.js/.test(text), 2));
      checks.push(check("dependencies-excluded", "security", !/node_modules/.test(text), 2));
      checks.push(check("manifest-readable", "observability", fs.existsSync(path.join(archive.deliveryDir, "MANIFEST.json")), 1));
      const verification = await verifyDelivery({ deliveryDir: archive.deliveryDir });
      checks.push(check("hash-verification", "security", verification.ok, 3, verification.error || `${verification.fileCount} files`));
    }

    const cleanupPaths = preview.cleanupCandidates.map((item) => item.path);
    checks.push(check("cleanup-runtime-only", "security", cleanupPaths.includes(".guardian/cache/cache.json") && !cleanupPaths.includes("src/index.js"), 3, cleanupPaths.join(",")));
    const cleanup = await applyCleanup({
      projectRoot: root,
      preview,
      trashImpl: async () => ({ ok: true, mode: "trash", destination: "/tmp/fake-trash" }),
    });
    checks.push(check("cleanup-verified-backup", "delivery", cleanup.deliveryValid && cleanup.ok, 2));

    const rejected = await createDelivery({ projectRoot: root, preview, userConfirmed: false });
    checks.push(check("second-confirmation", "security", rejected.errorCode === "confirmation-required", 3, rejected.errorCode));

    const fakeRunner = (() => {
      const records = new Map();
      return (args) => {
        if (args[0] === "add-generic-password") records.set(args[args.indexOf("-a") + 1], args[args.indexOf("-w") + 1]);
        if (args[0] === "find-generic-password") {
          const value = records.get(args[args.indexOf("-a") + 1]);
          return value ? { status: 0, stdout: value + "\n", stderr: "" } : { status: 44, stdout: "", stderr: "" };
        }
        if (args[0] === "delete-generic-password") records.delete(args[args.indexOf("-a") + 1]);
        return { status: 0, stdout: "", stderr: "" };
      };
    })();
    const store = createCredentialStore({ runner: fakeRunner });
    await store.set("primary", "score-secret");
    const credentialOk = (await store.get("primary")) === "score-secret" && !JSON.stringify({ checks }).includes("score-secret");
    checks.push(check("keychain-adapter", "security", credentialOk, 2));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  return checks;
}

function dimensionsFor(checks) {
  const names = [...new Set(checks.map((item) => item.dimension))];
  return Object.fromEntries(names.map((name) => [name, scoreChecks(checks.filter((item) => item.dimension === name))]));
}

function reportMarkdown(round, checks, dimensions, overall) {
  return [
    `# Guardian ${round} Round`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Overall: ${overall}/10`,
    "",
    "| Dimension | Score |",
    "|---|---:|",
    ...Object.entries(dimensions).map(([name, score]) => `| ${name} | ${score} |`),
    "",
    "## Checks",
    "",
    ...checks.map((item) => `- [${item.passed ? "x" : " "}] ${item.id} (${item.weight}) ${item.detail || ""}`.trim()),
    "",
  ].join("\n");
}

function writeReport(round, payload) {
  const dir = path.join(process.cwd(), "outputs", "guardian-tests");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `${round}-${stamp}.json`);
  const mdPath = path.join(dir, `${round}-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, reportMarkdown(round, payload.checks, payload.dimensions, payload.overall));
  return { jsonPath, mdPath };
}

export async function runRound(round) {
  const checks = round === "functional" ? await functionalChecks() : await safetyChecks();
  const dimensions = dimensionsFor(checks);
  const overall = overallScore(dimensions);
  const payload = {
    round,
    checks,
    dimensions,
    overall,
    passed: checks.every((item) => item.passed),
    digest: crypto.createHash("sha256").update(JSON.stringify(checks)).digest("hex"),
  };
  payload.report = writeReport(round, payload);
  return payload;
}

async function main() {
  const eqArg = process.argv.find((value) => value.startsWith("--round="));
  const flagIndex = process.argv.indexOf("--round");
  const round = eqArg ? eqArg.split("=")[1] : (flagIndex >= 0 ? process.argv[flagIndex + 1] : "both");
  for (const name of round === "both" ? ["functional", "safety"] : [round]) {
    const result = await runRound(name);
    console.log(`${name}: ${result.overall}/10 (${result.passed ? "PASS" : "FAIL"})`);
    console.log(result.report.mdPath);
    if (!result.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
