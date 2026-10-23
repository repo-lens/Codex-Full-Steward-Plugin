import test from "node:test";
import assert from "node:assert/strict";
import { createCredentialStore } from "../scripts/credential-store.mjs";

function fakeSecurity() {
  const records = new Map();
  const calls = [];
  const runner = (args) => {
    calls.push({ args: [...args] });
    if (args[0] === "add-generic-password") {
      records.set(args[args.indexOf("-a") + 1], args[args.indexOf("-w") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      const value = records.get(args[args.indexOf("-a") + 1]);
      return value
        ? { status: 0, stdout: `${value}\n`, stderr: "" }
        : { status: 44, stdout: "", stderr: "could not be found" };
    }
    if (args[0] === "delete-generic-password") {
      records.delete(args[args.indexOf("-a") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unsupported" };
  };
  return { records, calls, runner };
}

test("stores and reads a secret without exposing it in returned metadata", async () => {
  const { runner } = fakeSecurity();
  const store = createCredentialStore({ runner });
  await store.set("primary", "secret-value");
  assert.equal(await store.has("primary"), true);
  assert.equal(await store.get("primary"), "secret-value");
});

test("missing credentials return null and false", async () => {
  const { runner } = fakeSecurity();
  const store = createCredentialStore({ runner });
  assert.equal(await store.has("missing"), false);
  assert.equal(await store.get("missing"), null);
});

test("remove deletes only the selected account", async () => {
  const { runner } = fakeSecurity();
  const store = createCredentialStore({ runner });
  await store.set("primary", "a");
  await store.set("backup", "b");
  await store.remove("primary");
  assert.equal(await store.get("primary"), null);
  assert.equal(await store.get("backup"), "b");
});

test("set rejects empty references and values", async () => {
  const { runner } = fakeSecurity();
  const store = createCredentialStore({ runner });
  await assert.rejects(() => store.set("", "value"), /reference/i);
  await assert.rejects(() => store.set("primary", ""), /value/i);
});

test("runner failures never include the secret value in the error", async () => {
  const store = createCredentialStore({
    runner() {
      return { status: 1, stdout: "", stderr: "keychain denied secret-value" };
    },
  });
  await assert.rejects(
    () => store.set("primary", "secret-value"),
    (error) => !String(error.message).includes("secret-value"),
  );
});
