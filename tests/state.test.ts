import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, type RecordState } from "../src/state.js";
import { parseTicket } from "../src/ticket.js";

test("atomic records, restrictive permissions, and exact-branch locking across sites", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory), ticket = parseTicket("MAIL-1");
  const key = state.key("/repo/.git", ticket);
  assert.equal(key, state.key("/repo/.git", { ...ticket, site: "other.test" }));
  assert.equal(await state.load(key), undefined);
  const release = await state.lock(key);
  await assert.rejects(state.lock(key), /lock/);
  const record: RecordState = { version: 1, repo: "/repo/.git", ticket, harness: "pi", socket: "/socket", branch: "MAIL-1", baseSha: "a".repeat(40), phase: "submitting", agentName: "jira-mail-1", updatedAt: "" };
  await state.save(key, record);
  assert.equal((await state.load(key))?.phase, "submitting");
  assert.match(await readFile(join(directory, key + ".json"), "utf8"), /updatedAt/);
  await release();
  await (await state.lock(key))();
});
test("branch locks are separate from ticket locks and shared across ticket identities", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory), ticket = parseTicket("MAIL-1");
  assert.notEqual(state.branchKey("/repo", "MAIL-1"), state.key("/repo", ticket));
  assert.notEqual(state.branchKey("/repo", "one"), state.branchKey("/repo", "two"));
  assert.notEqual(state.branchKey("/repo", "one"), state.branchKey("/other", "one"));
  const release = await state.lock(state.branchKey("/repo", "shared"));
  await assert.rejects(state.lock(state.branchKey("/repo", "shared")), /lock/);
  await release();
});
test("saved records require a nonempty string branch", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory);
  for (const branch of [undefined, null, 42, ""]) {
    await writeFile(join(directory, "bad.json"), JSON.stringify({ version: 1, branch }));
    await assert.rejects(state.load("bad"), /invalid/);
  }
  await writeFile(join(directory, "bad.json"), "null");
  await assert.rejects(state.load("bad"), /invalid/);
});
test("optional version-one setup journal validates statuses, fields and contained paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory);
  const record: RecordState = { version: 1, repo: "/repo/.git", checkout: "/repo", ticket: parseTicket("MAIL-1"), harness: "pi", socket: "/socket", branch: "MAIL-1", baseSha: "a".repeat(40), phase: "created", agentName: "jira-mail-1", updatedAt: "" };
  for (const status of ["running", "failed", "succeeded", "skipped"] as const) {
    record.setup = { status, stage: status === "succeeded" ? "activation" : "dependencies", summary: "Summary", logPath: join(directory, "setup-test.log"), ...(status === "succeeded" ? { venv: "/repo/.venv" } : {}) };
    await state.save("record", record); assert.deepEqual((await state.load("record"))!.setup, record.setup);
  }
  for (const setup of [null, [], {}, { status: "bad" }, { status: ["failed"] }, { status: "failed", stage: "bad" }, { status: "failed", stage: [] }, { status: "failed", command: "evil" }, { status: "failed", summary: 1 }, { status: "succeeded", venv: "/outside" }, { status: "failed", venv: "/repo/.venv" }, { status: "succeeded", venv: "/repo/../outside" }, { status: "failed", logPath: "/outside/log" }, { status: "failed", summary: "bad\nline" }]) {
    await writeFile(join(directory, "record.json"), JSON.stringify({ ...record, setup }));
    await assert.rejects(state.load("record"), /setup state is invalid/);
  }
  delete record.setup; await state.save("record", record);
  assert.equal((await state.load("record"))!.setup, undefined);
});
test("Pi binding journal validates nonce, shell PID and private sibling artifact paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory), parent = join(directory, "pi-environment-test");
  const binding = { version: 1 as const, nonce: "a".repeat(64), shellPid: 1234, extensionPath: join(parent, "extension.mjs"), proofPath: join(parent, "proof.json") };
  const record: RecordState = { version: 1, repo: "/repo/.git", checkout: "/repo", ticket: parseTicket("MAIL-1"), harness: "pi", socket: "/socket", branch: "MAIL-1", baseSha: "a".repeat(40), phase: "starting", agentName: "jira-mail-1", updatedAt: "", setup: { status: "succeeded", stage: "activation", venv: "/repo/.venv", binding } };
  await state.save("record", record); assert.deepEqual((await state.load("record"))!.setup!.binding, binding);
  for (const invalid of [null, [], {}, { ...binding, nonce: "old" }, { ...binding, shellPid: 0 }, { ...binding, shellPid: "1234" }, { ...binding, version: 2 }, { ...binding, unexpected: true }, { ...binding, proofPath: "/outside/proof.json" }, { ...binding, proofPath: join(directory, "other/proof.json") }, { ...binding, extensionPath: join(parent, "../extension.mjs") }, { ...binding, extensionPath: "/repo/extension.mjs", proofPath: "/repo/proof.json" }]) {
    await writeFile(join(directory, "record.json"), JSON.stringify({ ...record, setup: { ...record.setup, binding: invalid } }));
    await assert.rejects(state.load("record"), /setup state is invalid/);
  }
});
test("corrupt state and orphan locks fail closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory);
  await writeFile(join(directory, "bad.json"), "{broken");
  await assert.rejects(state.load("bad"), /corrupt/);
  await writeFile(join(directory, "bad.lock"), JSON.stringify({ pid: 99999999 }));
  await assert.rejects(state.lock("bad"), /interrupted/);
});
