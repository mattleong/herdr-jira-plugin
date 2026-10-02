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
test("corrupt state and orphan locks fail closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jira-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new State(directory);
  await writeFile(join(directory, "bad.json"), "{broken");
  await assert.rejects(state.load("bad"), /corrupt/);
  await writeFile(join(directory, "bad.lock"), JSON.stringify({ pid: 99999999 }));
  await assert.rejects(state.lock("bad"), /interrupted/);
});
