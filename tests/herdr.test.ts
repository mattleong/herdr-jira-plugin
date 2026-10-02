import { test } from "node:test";
import assert from "node:assert/strict";
import { Herdr } from "../src/herdr.js";
import { detailsOf, messageOf } from "../src/errors.js";

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
test("Herdr errors retain full diagnostics beyond the short summary", async () => {
  const herdr = new Herdr(async () => JSON.stringify({ error: { message: "x".repeat(4000) + "\nLAST DETAIL", data: { hint: "A useful hint" } } }), { HERDR_SOCKET_PATH: "/socket" });
  await assert.rejects(herdr.call(["status"]), error => {
    assert.match(detailsOf(error), /LAST DETAIL/); assert.match(detailsOf(error), /A useful hint/);
    assert.ok(messageOf(error).length < 1600); return true;
  });
});
test("process-info unwraps the installed CLI shape", async () => {
  const info = { foreground_process_group_id: 85148, foreground_processes: [{ argv0: "pi", cwd: "/work tree", name: "node", pid: 85148 }], pane_id: "w1S:p1", shell_pid: 84832 };
  const calls: string[][] = [];
  const herdr = new Herdr(async (_binary, args) => {
    calls.push(args);
    return JSON.stringify({ result: args[1] === "process-info" ? { process_info: info, type: "pane_process_info" } : { type: "ok" } });
  }, { HERDR_SOCKET_PATH: "/socket" });
  assert.deepEqual(await herdr.processInfo("w1S:p1"), info);
  assert.deepEqual(calls, [["pane", "process-info", "--pane", "w1S:p1"]]);
});
test("process-info rejects incomplete, null, mismatched and malformed identity evidence", async () => {
  const valid = { pane_id: "pane", shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ name: "bash", argv0: "-bash", cwd: "/repo", pid: 42 }] };
  for (const info of [{}, { ...valid, pane_id: "other" }, { ...valid, shell_pid: null }, { ...valid, shell_pid: 0 }, { ...valid, foreground_process_group_id: "42" }, { ...valid, foreground_processes: null }, { ...valid, foreground_processes: [{ name: "bash", argv0: null, cwd: "/repo", pid: 42 }] }]) {
    const herdr = new Herdr(async () => JSON.stringify({ result: { type: "pane_process_info", process_info: info } }), { HERDR_SOCKET_PATH: "/socket" });
    await assert.rejects(herdr.processInfo("pane"));
  }
});
test("invalid or incomplete Herdr responses fail closed", async () => {
  for (const output of ["not json", "{}", JSON.stringify({ result: {} }), JSON.stringify({ result: { workspace: {} } })]) {
    const herdr = new Herdr(async () => output, { HERDR_SOCKET_PATH: "/socket" });
    await assert.rejects(herdr.create("/repo", "MAIL-1", "a".repeat(40)));
  }
});
