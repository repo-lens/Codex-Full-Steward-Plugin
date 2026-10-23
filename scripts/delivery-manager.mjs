import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const TEXT_ENCODING = "utf8";
const VERSION = "2.0.0";
const DELIVERY_PREFIX = "guardian-delivery-";
const HARD_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "target", "cache", "out", "vendor"]);
const SECRET_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /\.(?:db|sqlite|sqlite3)$/i,
];
const GENERATED_PATTERNS = [/\.log$/i, /\.tmp$/i, /^\.DS_Store$/i];

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function relative(root, absolute) {
  return slash(path.relative(root, absolute));
}

function isWithin(root, candidate) {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  return candidateAbs === rootAbs || candidateAbs.startsWith(rootAbs + path.sep);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function classifyExcluded(root, absolute, stat) {
  const rel = relative(root, absolute);
  const parts = rel.split("/");
  const base = parts.at(-1) || "";
  if (stat.isSymbolicLink()) return "symlink";
  if (parts[0] === ".git") return "git";
  if (parts.includes("node_modules")) return "dependencies";
  if (parts[0] === "outputs" && parts[1]?.startsWith(DELIVERY_PREFIX)) return "prior-delivery";
  if (HARD_EXCLUDED_DIRS.has(parts[0])) return "build-cache";
  if (rel === ".guardian/cache" || rel.startsWith(".guardian/cache/")) return "runtime-cache";
  if (rel === ".guardian/tmp" || rel.startsWith(".guardian/tmp/")) return "runtime-tmp";
  if (SECRET_PATTERNS.some((pattern) => pattern.test(base))) return "secret";
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(base))) return "generated";
  return null;
}

function listFiles(root) {
  const include = [];
  const exclude = [];
  const cleanupCandidates = [];
  const excludedCounts = {};

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      const rel = relative(root, absolute);
      if (stat.isDirectory() && (rel === ".guardian/cache" || rel === ".guardian/tmp")) {
        walk(absolute);
        continue;
      }
      if (stat.isFile() && isCleanupCandidate(rel)) {
        cleanupCandidates.push({ path: rel, reason: "conservative-runtime-cleanup" });
      }
      const category = classifyExcluded(root, absolute, stat);
      if (category) {
        exclude.push({ path: rel, category });
        excludedCounts[category] = (excludedCounts[category] || 0) + 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        exclude.push({ path: rel, category: "symlink" });
        excludedCounts.symlink = (excludedCounts.symlink || 0) + 1;
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) {
        exclude.push({ path: rel, category: "special-file" });
        excludedCounts["special-file"] = (excludedCounts["special-file"] || 0) + 1;
        continue;
      }
      include.push(rel);
    }
  }

  walk(root);
  include.sort();
  exclude.sort((left, right) => left.path.localeCompare(right.path));
  cleanupCandidates.sort((left, right) => left.path.localeCompare(right.path));
  return { include, exclude, cleanupCandidates, excludedCounts };
}

function isCleanupCandidate(rel) {
  return (
    rel.startsWith(".guardian/cache/") ||
    rel.startsWith(".guardian/tmp/") ||
    /(?:^|\/)context-cache\.json$/.test(rel) && rel.startsWith(".guardian/sessions/") ||
    rel.endsWith(".tmp") && rel.startsWith(".guardian/")
  );
}

function fingerprintProject(root) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const rel = relative(root, absolute);
      const parts = rel.split("/");
      if (parts.includes("node_modules") || parts[0] === ".git" || parts[0] === "dist" || parts[0] === "build" || parts[0] === "target") continue;
      if (parts[0] === "outputs" && parts[1]?.startsWith(DELIVERY_PREFIX)) continue;
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        files.push(`${rel}\0symlink`);
      } else if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        files.push(`${rel}\0${stat.size}\0${stat.mtimeMs}`);
      }
    }
  }
  walk(root);
  files.sort();
  return sha256(files.join("\n"));
}

function createToken(preview) {
  return sha256(JSON.stringify({
    projectRoot: preview.projectRoot,
    fingerprint: preview.projectFingerprint,
    include: preview.include,
    exclude: preview.exclude,
    cleanupCandidates: preview.cleanupCandidates,
    createdAtMs: preview.createdAtMs,
  }));
}

export function createDeliveryPreview({
  projectRoot,
  sessionKey = "default",
  decision = {},
  now = Date.now,
} = {}) {
  const root = path.resolve(String(projectRoot || ""));
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("Project root is not a directory");
  const listing = listFiles(root);
  const createdAtMs = Number(now());
  const preview = {
    projectRoot: root,
    sessionKey: String(sessionKey || "default"),
    decision,
    createdAtMs,
    projectFingerprint: fingerprintProject(root),
    include: listing.include,
    exclude: listing.exclude,
    cleanupCandidates: listing.cleanupCandidates,
    excludedCounts: listing.excludedCounts,
    estimatedBytes: listing.include.reduce((sum, rel) => {
      try { return sum + fs.statSync(path.join(root, rel)).size; } catch { return sum; }
    }, 0),
  };
  preview.executeToken = createToken(preview);
  return preview;
}

function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function uniqueDeliveryDir(root, stamp) {
  const base = path.join(root, "outputs", `${DELIVERY_PREFIX}${stamp}`);
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function defaultZipRunner(args, input, options) {
  return spawnSync("/usr/bin/zip", args, { ...options, input });
}

function defaultUnzipRunner(args, options) {
  return spawnSync("/usr/bin/unzip", args, options);
}

async function buildFileManifest(root, include) {
  const files = [];
  for (const rel of include) {
    const absolute = path.join(root, rel);
    const stat = fs.statSync(absolute);
    files.push({ path: rel, size: stat.size, sha256: await hashFile(absolute) });
  }
  return files;
}

export async function createDelivery({
  projectRoot,
  preview,
  userConfirmed = false,
  now = Date.now,
  zipRunner = defaultZipRunner,
  unzipRunner = defaultUnzipRunner,
  version = VERSION,
} = {}) {
  if (!userConfirmed) return { ok: false, errorCode: "confirmation-required", error: "Explicit confirmation is required" };
  if (!preview || !preview.executeToken) return { ok: false, errorCode: "preview-required", error: "A delivery preview is required" };
  if (preview.decision?.deliveryState !== "ready-for-confirmation") {
    return { ok: false, errorCode: "delivery-not-ready", error: "Delivery readiness is not confirmed" };
  }

  const root = path.resolve(String(projectRoot || ""));
  if (!isWithin(root, root) || preview.projectRoot !== root) {
    return { ok: false, errorCode: "invalid-project", error: "Project root does not match preview" };
  }
  const currentFingerprint = fingerprintProject(root);
  if (currentFingerprint !== preview.projectFingerprint) {
    return { ok: false, errorCode: "project-changed", error: "Project changed after preview" };
  }

  const deliveryDir = uniqueDeliveryDir(root, formatTimestamp(now()));
  fs.mkdirSync(deliveryDir, { recursive: true });
  const archivePath = path.join(deliveryDir, "delivery.zip");
  const list = preview.include.join("\n") + (preview.include.length ? "\n" : "");
  const zipArgs = ["-q", "-@", archivePath];
  let zipResult;
  try {
    zipResult = zipRunner(zipArgs, list, { cwd: root, encoding: TEXT_ENCODING });
  } catch (error) {
    fs.rmSync(deliveryDir, { recursive: true, force: true });
    return { ok: false, errorCode: "archive-failed", error: String(error.message || error) };
  }
  if (zipResult?.status !== 0) {
    fs.rmSync(deliveryDir, { recursive: true, force: true });
    return { ok: false, errorCode: "archive-failed", error: String(zipResult?.stderr || "zip failed").slice(0, 300) };
  }

  const afterFingerprint = fingerprintProject(root);
  if (afterFingerprint !== preview.projectFingerprint) {
    fs.rmSync(deliveryDir, { recursive: true, force: true });
    return { ok: false, errorCode: "project-changed", error: "Project changed during backup" };
  }

  const test = unzipRunner(["-t", archivePath], { encoding: TEXT_ENCODING });
  if (test?.status !== 0) {
    fs.rmSync(deliveryDir, { recursive: true, force: true });
    return { ok: false, errorCode: "archive-invalid", error: String(test?.stderr || test?.stdout || "unzip test failed").slice(0, 300) };
  }

  const archiveSha256 = await hashFile(archivePath);
  const manifest = {
    version,
    createdAt: new Date(now()).toISOString(),
    projectRoot: root,
    sessionKey: preview.sessionKey,
    decision: preview.decision,
    projectFingerprint: preview.projectFingerprint,
    include: await buildFileManifest(root, preview.include),
    exclude: preview.exclude,
    excludedCounts: preview.excludedCounts,
    cleanupCandidates: preview.cleanupCandidates,
    provider: preview.provider || null,
    archiveSha256,
  };
  const manifestPath = path.join(deliveryDir, "MANIFEST.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestSha256 = await hashFile(manifestPath);
  const checksumsPath = path.join(deliveryDir, "SHA256SUMS");
  fs.writeFileSync(checksumsPath, [
    `${archiveSha256}  delivery.zip`,
    `${manifestSha256}  MANIFEST.json`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(deliveryDir, "DELIVERY-README.md"), [
    "# Guardian Delivery",
    "",
    `Project: ${root}`,
    `Version: ${version}`,
    `Created: ${manifest.createdAt}`,
    "",
    "Verify this package with `shasum -a 256 -c SHA256SUMS` and inspect `MANIFEST.json` for exclusions and cleanup records.",
    "",
  ].join("\n"));

  return {
    ok: true,
    deliveryDir,
    archivePath,
    manifestPath,
    checksumsPath,
    archiveSha256,
    manifest,
  };
}

export async function verifyDelivery({ deliveryDir, unzipRunner = defaultUnzipRunner } = {}) {
  const dir = path.resolve(String(deliveryDir || ""));
  const archivePath = path.join(dir, "delivery.zip");
  const manifestPath = path.join(dir, "MANIFEST.json");
  const checksumsPath = path.join(dir, "SHA256SUMS");
  if (!fs.existsSync(archivePath) || !fs.existsSync(manifestPath) || !fs.existsSync(checksumsPath)) {
    return { ok: false, error: "Delivery files are incomplete" };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const archiveSha256 = await hashFile(archivePath);
  if (archiveSha256 !== manifest.archiveSha256) return { ok: false, error: "Archive hash mismatch" };
  const test = unzipRunner(["-t", archivePath], { encoding: TEXT_ENCODING });
  if (test?.status !== 0) return { ok: false, error: "ZIP validation failed" };
  const listing = unzipRunner(["-Z1", archivePath], { encoding: TEXT_ENCODING });
  if (listing?.status !== 0) return { ok: false, error: "ZIP listing failed" };
  const archived = new Set(String(listing.stdout || "").split(/\r?\n/).filter(Boolean));
  const missing = manifest.include.map((file) => file.path).filter((rel) => !archived.has(rel));
  if (missing.length) return { ok: false, error: "Archive is missing manifest files", missing };
  const checksums = fs.readFileSync(checksumsPath, "utf8");
  if (!checksums.includes(archiveSha256)) return { ok: false, error: "Checksums file does not contain archive hash" };
  return { ok: true, archiveSha256, fileCount: manifest.include.length };
}

function uniqueTrashPath(home, basename) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = path.join(home, ".Trash");
  fs.mkdirSync(trash, { recursive: true });
  let candidate = path.join(trash, `${basename}-${stamp}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(trash, `${basename}-${stamp}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

export function defaultTrashImpl({ absolutePath, relativePath, projectRoot, home = os.homedir() }) {
  const escaped = JSON.stringify(absolutePath);
  const finder = spawnSync("/usr/bin/osascript", ["-e", `tell application \"Finder\" to delete POSIX file ${escaped}`], { encoding: TEXT_ENCODING });
  const destination = path.join(home, ".Trash", path.basename(absolutePath));
  if (finder.status === 0) return { ok: true, mode: "finder", relativePath, destination };
  try {
    const fallback = uniqueTrashPath(home, path.basename(absolutePath));
    fs.renameSync(absolutePath, fallback);
    return { ok: true, mode: "trash", relativePath, destination: fallback };
  } catch (error) {
    return { ok: false, relativePath, error: String(error.message || error) };
  }
}

export async function applyCleanup({
  projectRoot,
  preview,
  trashImpl = defaultTrashImpl,
} = {}) {
  const root = path.resolve(String(projectRoot || ""));
  const results = [];
  for (const candidate of preview?.cleanupCandidates || []) {
    const absolutePath = path.resolve(root, candidate.path);
    if (!isWithin(root, absolutePath) || absolutePath === root) {
      results.push({ ...candidate, ok: false, error: "Path escapes project root" });
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      results.push({ ...candidate, ok: false, error: "Path no longer exists" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      results.push({ ...candidate, ok: false, error: "Symlink cleanup is forbidden" });
      continue;
    }
    const result = await trashImpl({
      absolutePath,
      relativePath: candidate.path,
      projectRoot: root,
    });
    results.push({ ...candidate, ...result });
  }
  return {
    ok: results.every((item) => item.ok),
    deliveryValid: true,
    moved: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

export function deliveryProjectFingerprint(projectRoot) {
  return fingerprintProject(path.resolve(projectRoot));
}
