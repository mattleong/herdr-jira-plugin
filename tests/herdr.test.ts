import { test } from "node:test";
import assert from "node:assert/strict";
import { Herdr } from "../src/herdr.js";

test("uses originating binary/socket, manifest popup defaults, and argv-safe context", async () => {
  const calls: string[][] = [];
  const herdr = new Herdr(async (binary, args, options) => {
    assert.equal(binary, "/path with spaces/herdr");
    assert.equal(options?.env?.HERDR_SOCKET_PATH, "/session/socket");
    calls.push(args);
    return JSON.stringify({ id: "cli", result: { type: "ok" } });
  }, { HERDR_SOCKET_PATH: "/session/socket", HERDR_BIN_PATH: "/path with spaces/herdr" });
  await herdr.openForm('{"repo":"path with spaces"}');
  assert.deepEqual(calls[0], ["plugin", "pane", "open", "--plugin", "local.jira", "--entrypoint", "form", "--env", 'HERDR_JIRA_ORIGIN={"repo":"path with spaces"}']);
  assert.equal(calls[0]?.includes("--placement"), false);
});
test("invalid or incomplete Herdr responses fail closed", async () => {
  for (const output of ["not json", "{}", JSON.stringify({ result: {} }), JSON.stringify({ result: { workspace: {} } })]) {
    const herdr = new Herdr(async () => output, { HERDR_SOCKET_PATH: "/socket" });
    await assert.rejects(herdr.create("/repo", "MAIL-1", "a".repeat(40)));
  }
});
