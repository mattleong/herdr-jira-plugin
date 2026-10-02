import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClipboard } from "../src/clipboard.js";

const options = { input: "sample diagnostic", timeout: 3000, env: process.env };
test("clipboard runner accepts stdin without capturing inherited daemon pipes", async t => {
  const root = await mkdtemp(join(tmpdir(), "jira-clipboard-test-")), file = join(root, "owner.pid");
  let owner: number | undefined;
  t.after(async () => { if (owner) { try { process.kill(owner, "SIGKILL"); } catch {} } await rm(root, { recursive: true, force: true }); });
  const code = `
    const { spawn } = require('node:child_process'), fs = require('node:fs');
    let text = ''; process.stdin.on('data', chunk => text += chunk);
    process.stdin.on('end', () => {
      if (text !== 'sample diagnostic') process.exit(2);
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' });
      fs.writeFileSync(process.argv[1], String(child.pid)); process.exit(0);
    });`;
  await runClipboard(process.execPath, ["-e", code, file], options);
  owner = Number(await readFile(file, "utf8"));
  assert.ok(owner > 0); process.kill(owner, 0); // Successful clipboard owner survives its parent.
});
test("clipboard timeout and cancellation terminate an unacknowledged process group", async t => {
  const root = await mkdtemp(join(tmpdir(), "jira-clipboard-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ["timeout", "abort"] as const) {
    const controller = new AbortController(), file = join(root, mode + ".pid");
    const pending = runClipboard(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdin.resume(); setTimeout(() => {}, 10000)", file], { ...options, timeout: mode === "timeout" ? 800 : 5000, signal: controller.signal });
    // Attach the rejection assertion before aborting or waiting for process startup.
    const rejected = assert.rejects(pending, mode === "timeout" ? /timed out/ : /cancelled/);
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) { pid = Number(await readFile(file, "utf8").catch(() => "0")); if (!pid) await new Promise(r => setTimeout(r, 10)); }
    assert.ok(pid > 0);
    if (mode === "abort") controller.abort();
    await rejected;
    let exited = false;
    for (let i = 0; i < 50 && !exited; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 10)); } catch { exited = true; }
    }
    assert.equal(exited, true);
  }
});
test("clipboard command failures reject rather than claiming a copy", async () => {
  await assert.rejects(runClipboard("/nonexistent/jira-clipboard", [], options));
  await assert.rejects(runClipboard(process.execPath, ["-e", "process.exit(1)"], options));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runClipboard(process.execPath, [], { ...options, signal: controller.signal }), /cancelled/);
});
