import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/process.js";
import { detailsOf, messageOf } from "../src/errors.js";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("executes argv without shell expansion and captures output", async () => {
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo injected); spaces"]), "$(echo injected); spaces");
});
test("timeout escalates when SIGTERM is ignored and never reports late success", async () => {
  const started = Date.now();
  await assert.rejects(run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2000)"], { timeout: 100 }), /timed out/);
  assert.ok(Date.now() - started < 1500);
});
test("failure details retain complete stdout/stderr separately from bounded summaries", async () => {
  const diagnostic = "x".repeat(4000) + "\nLAST STDOUT", stderr = "y".repeat(4000) + "\nLAST STDERR";
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exitCode = 1", diagnostic, stderr]), error => {
    assert.match(detailsOf(error), /LAST STDOUT/); assert.match(detailsOf(error), /LAST STDERR/);
    assert.ok(messageOf(error).length < 1600); return true;
  });
  await assert.rejects(run(process.execPath, ["-e", "console.log('stdout-only failure'); process.exitCode = 1"]), /stdout-only failure/);
});
test("nonzero exit and missing commands reject without unbounded output", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.stderr.write('failure'); process.exit(2)"]), /failure/);
  await assert.rejects(run("/nonexistent/herdr-jira-command", []), /could not run/);
});
test("output observers receive stdout and stderr on successful commands", async () => {
  const streams = { stdout: "", stderr: "" };
  const result = await run(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
    onOutput: (text, stream) => { streams[stream] += text; },
  });
  assert.equal(result, "out"); assert.deepEqual(streams, { stdout: "out", stderr: "err" });
});
test("output is bounded and an observer failure terminates the command", async () => {
  let bytes = 0;
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024))"], {
    onOutput: text => { bytes += Buffer.byteLength(text); },
  }), /output limit/);
  assert.ok(bytes <= 2 * 1024 * 1024);
  await assert.rejects(run(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    onOutput: () => { throw new Error("observer"); },
  }), /observer failed/);
});
test("output-limit errors identify omitted data and drop incomplete credential records", async () => {
  const script = "process.stdout.write('SAFE RECORD\\nhttps://user:OVERFLOW_SECRET' + 'x'.repeat(3 * 1024 * 1024) + '@host.test\\n')";
  await assert.rejects(run(process.execPath, ["-e", script], { timeout: 5000 }), error => {
    assert.match(messageOf(error), /output limit/);
    assert.match(detailsOf(error), /SAFE RECORD/); assert.match(detailsOf(error), /Output truncated/);
    assert.doesNotMatch(detailsOf(error), /OVERFLOW_SECRET/); return true;
  });
});
test("timeout diagnostics preserve output produced during termination", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.on('SIGTERM', () => { process.stderr.write('TERM DIAGNOSTIC'); process.exit(0); }); setInterval(() => {}, 1000)"], { timeout: 200 }), error => {
    assert.match(detailsOf(error), /TERM DIAGNOSTIC/); return true;
  });
});
test("an already aborted signal never starts a child", async t => {
  const root = await mkdtemp(join(tmpdir(), "herdr-process-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "marker"), controller = new AbortController(); controller.abort();
  await assert.rejects(run(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", marker], { signal: controller.signal }), /aborted/);
  await assert.rejects(access(marker));
});
test("abort synchronously kills the owned process group before the caller immediately exits", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const root = await mkdtemp(join(tmpdir(), "herdr-process-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "escaped"), module = new URL("../src/process.ts", import.meta.url).href;
  const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 500);`;
  const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);`;
  const caller = `import {run} from ${JSON.stringify(module)}; const controller = new AbortController(); run(process.execPath, ['-e', ${JSON.stringify(leader)}], {signal:controller.signal,onOutput(text) {if(text.includes('READY')) {controller.abort();process.exit(0);}}}).catch(() => {});`;
  await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", caller], { timeout: 5_000 });
  await delay(750); await assert.rejects(access(marker));
});
test("timeout still kills descendants when their wrapper exits on TERM", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const root = await mkdtemp(join(tmpdir(), "herdr-process-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "escaped");
  const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 900);`;
  const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
  await assert.rejects(run(process.execPath, ["-e", leader], { timeout: 200 }), /timed out/);
  await delay(700); await assert.rejects(access(marker));
});
