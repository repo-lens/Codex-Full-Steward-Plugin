import { spawnSync } from "node:child_process";

const DEFAULT_SERVICE = "codex-guardian";
const REF_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function assertReference(ref) {
  const value = String(ref || "");
  if (!REF_PATTERN.test(value)) throw new Error("Invalid credential reference");
  return value;
}

export function defaultSecurityRunner(args) {
  return spawnSync("/usr/bin/security", args, { encoding: "utf8" });
}

export function createCredentialStore({
  runner = defaultSecurityRunner,
  service = DEFAULT_SERVICE,
} = {}) {
  if (typeof runner !== "function") throw new Error("Credential runner must be a function");
  const serviceName = String(service || "").trim();
  if (!serviceName) throw new Error("Credential service is required");

  async function get(ref) {
    const account = assertReference(ref);
    const result = runner([
      "find-generic-password",
      "-s", serviceName,
      "-a", account,
      "-w",
    ]);
    if (result?.status === 44) return null;
    if (result?.status !== 0) throw new Error("Keychain read failed");
    return String(result.stdout || "").replace(/\r?\n$/, "");
  }

  async function has(ref) {
    return (await get(ref)) !== null;
  }

  async function set(ref, value) {
    const account = assertReference(ref);
    const secret = String(value || "");
    if (!secret) throw new Error("Credential value is required");
    let result;
    try {
      result = runner([
        "add-generic-password",
        "-U",
        "-s", serviceName,
        "-a", account,
        "-w", secret,
      ]);
    } catch {
      throw new Error("Keychain write failed");
    }
    if (result?.status !== 0) throw new Error("Keychain write failed");
  }

  async function remove(ref) {
    const account = assertReference(ref);
    const result = runner([
      "delete-generic-password",
      "-s", serviceName,
      "-a", account,
    ]);
    if (result?.status !== 0 && result?.status !== 44) {
      throw new Error("Keychain delete failed");
    }
  }

  return { has, get, set, remove };
}
