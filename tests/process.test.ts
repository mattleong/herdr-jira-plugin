import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/process.js";

test("executes argv without shell expansion and captures output", async () => {
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo injected); spaces"]), "$(echo injected); spaces");
});
test("timeout escalates when SIGTERM is ignored and never reports late success", async () => {
  const started = Date.now();
  await assert.rejects(run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2000)"], { timeout: 100 }), /timed out/);
  assert.ok(Date.now() - started < 1500);
});
test("nonzero exit and missing commands reject without unbounded output", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.stderr.write('failure'); process.exit(2)"]), /failure/);
  await assert.rejects(run("/nonexistent/herdr-jira-command", []), /could not run/);
});
