import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { activateEnvironment, verifyEnvironment, verifyPiEnvironment } from "../src/environment.js";
import { candidateEnvironment, environmentPaths } from "../src/environment-probe.js";
import { Herdr, type Pane, type PaneProcessInfo } from "../src/herdr.js";
import { detailsOf, SetupError, WorkflowError } from "../src/errors.js";
import { run } from "../src/process.js";
import type { EnvironmentBinding, EnvironmentTarget } from "../src/setup-types.js";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function fixture(t: TestContext, fancy = false): Promise<EnvironmentTarget> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-environment-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const checkout = join(root, fancy ? "checkout ' $(touch OWNED); space" : "checkout"), stateDirectory = join(root, "state");
  await mkdir(checkout); await mkdir(stateDirectory, { mode: 0o700 });
  const venv = join(checkout, ".venv");
  await run("python3", ["-m", "venv", "--without-pip", venv], { timeout: 15_000 });
  return { checkout, venv, stateDirectory, paneId: "workspace:pane", workspaceId: "workspace", terminalId: "terminal", timeoutMs: 8_000 };
}
interface MockOptions {
  pid?: number; piPid?: number; shell?: string;
  pane?: (pane: Pane, count: number) => void;
  info?: (info: PaneProcessInfo, count: number) => void;
}
function mock(target: EnvironmentTarget, options: MockOptions = {}) {
  let paneReads = 0, infoReads = 0;
  const pid = options.pid ?? 4242, shell = options.shell ?? "bash";
  const herdr = new Herdr(async (_binary, args) => {
    if (args[1] === "get") {
      const pane: Pane = { pane_id: target.paneId, workspace_id: target.workspaceId, terminal_id: target.terminalId, cwd: target.checkout, agent_status: options.piPid ? "idle" : "unknown", ...(options.piPid ? { agent: "pi" } : {}) };
      options.pane?.(pane, ++paneReads);
      return JSON.stringify({ result: { pane } });
    }
    if (args[1] === "process-info") {
      const info: PaneProcessInfo = { pane_id: target.paneId, shell_pid: pid, foreground_process_group_id: options.piPid ?? pid, foreground_processes: [{ argv0: options.piPid ? "pi" : "-" + shell, name: options.piPid ? "node" : shell, cwd: target.checkout, pid: options.piPid ?? pid }] };
      options.info?.(info, ++infoReads);
      return JSON.stringify({ result: { type: "pane_process_info", process_info: info } });
    }
    assert.fail("Environment binding must never send terminal input: " + args.join(" "));
  }, { HERDR_SOCKET_PATH: "/mock/socket" });
  return herdr;
}
async function fakeProof(target: EnvironmentTarget, binding: EnvironmentBinding, extra: Record<string, unknown> = {}) {
  const proof = { version: 1, nonce: binding.nonce, shellPid: binding.shellPid, piPid: 4343, piPathFirst: join(target.venv, "bin"), checkout: target.checkout, venv: target.venv, workspaceId: target.workspaceId, paneId: target.paneId, terminalId: target.terminalId, virtualEnv: target.venv, pathFirst: join(target.venv, "bin"), noUserSite: "1", contaminated: false, pythonPrefix: target.venv, pythonCwd: target.checkout, pythonExecutable: join(target.venv, "bin/python"), ...extra };
  await writeFile(binding.proofPath, JSON.stringify(proof), { mode: 0o600 });
}
async function rejectsDetails(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof WorkflowError); assert.equal(error instanceof SetupError, false); assert.equal(error.recoverable, false);
    assert.match(detailsOf(error), pattern); return true;
  });
}
async function waitFile(path: string, diagnostics: () => string = () => ""): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try { const content = await readFile(path, "utf8"); if (content.trim()) return content; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(20);
  }
  throw new Error("Timed out waiting for " + path + "\n" + diagnostics());
}
// Exercise the installed public Bash backend without starting Pi, a model, or Herdr.
async function bashModule(t: TestContext): Promise<string | undefined> {
  try { return pathToFileURL(join(dirname(await realpath((await run("which", ["pi"])).trim())), "index.js")).href; }
  catch { t.skip("Installed Pi unavailable; parent runs the real Pi smoke separately"); return; }
}
async function runner(target: EnvironmentTarget, binding: EnvironmentBinding, module: string, options: { settings?: Record<string, string>; source?: string; inactive?: boolean; reload?: boolean; failureAfterSuccess?: boolean } = {}) {
  const path = join(target.stateDirectory, "runner-" + binding.nonce + ".mjs");
  await writeFile(path, `
import { createBashTool } from ${JSON.stringify(module)};
import { bindPiEnvironment } from ${JSON.stringify(new URL("../src/pi-environment.ts", import.meta.url).href)};
import { writeFile, readFile } from 'node:fs/promises';
const config = ${JSON.stringify({ target, binding })};
const settings = ${JSON.stringify(options.settings ?? {})};
let handler;
const pi = { on(event, fn) { if(event !== 'session_start') throw Error(event); handler = fn; }, getActiveTools() { return ${JSON.stringify(options.inactive ? [] : ["bash"])}; }, getAllTools() { return [{ name: 'bash', sourceInfo: { source: ${JSON.stringify(options.source ?? "builtin")}, path: 'builtin:bash' } }]; }, getSettings() { return settings; } };
try {
  await bindPiEnvironment(pi, createBashTool, config);
  await handler({}, {cwd: process.cwd()});
  const firstPath = process.env.PATH;
  if (${!!options.reload}) {
    await bindPiEnvironment(pi, createBashTool, config);
    if (firstPath !== process.env.PATH) throw Error('PATH grew on reload');
    await handler({}, {cwd: process.cwd()});
  }
  if (${!!options.failureAfterSuccess}) {
    settings.shellCommandPrefix = 'unset VIRTUAL_ENV';
    await handler({}, {cwd: process.cwd()});
    throw Error('sabotage should fail');
  }
  const proof = JSON.parse(await readFile(config.binding.proofPath, 'utf8'));
  if (proof.piPid !== process.pid) throw Error('not actual Pi process PID');
  await writeFile(${JSON.stringify(join(target.stateDirectory, "runner-result"))}, JSON.stringify({pid: process.pid, path: process.env.PATH, venv: process.env.VIRTUAL_ENV}));
} catch(error) { console.error(error); process.exitCode = 1; }
`);
  return path;
}

test("private binding preparation is non-mutating, retained, canonical and unique per attempt", async t => {
  const target = await fixture(t, true), before = process.env.VIRTUAL_ENV;
  const first = await activateEnvironment(target, mock(target)), second = await activateEnvironment(target, mock(target));
  assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.extensionPath, second.extensionPath);
  assert.equal((await stat(dirname(first.extensionPath))).mode & 0o777, 0o700);
  assert.equal((await stat(first.extensionPath)).mode & 0o777, 0o600);
  const source = await readFile(first.extensionPath, "utf8");
  assert.match(source, /createBashTool/); assert.match(source, /bindPiEnvironment/); assert.doesNotMatch(source, /bin\/activate|registerTool|setActiveTools/);
  assert.ok(source.includes(JSON.stringify(target.checkout))); assert.equal(process.env.VIRTUAL_ENV, before);
  await assert.rejects(access(first.proofPath)); assert.equal((await readdir(target.stateDirectory)).length, 2);
});
test("Herdr's 0755 state root permits private bindings but shared-writable roots do not", async t => {
  const target = await fixture(t);
  await chmod(target.stateDirectory, 0o755);
  const binding = await activateEnvironment(target, mock(target));
  assert.equal((await stat(target.stateDirectory)).mode & 0o777, 0o755);
  assert.equal((await stat(dirname(binding.extensionPath))).mode & 0o777, 0o700);
  await chmod(target.stateDirectory, 0o777);
  await rejectsDetails(activateEnvironment(target, mock(target)), /not writable by other users/);
});
test("PROMPT_COMMAND can erase shell activation, but startup binds the actual Pi process and Bash backend; reload is idempotent", async t => {
  const module = await bashModule(t); if (!module) return;
  const target = await fixture(t, true), marker = join(target.stateDirectory, "ACTIVATE_SOURCED");
  await writeFile(join(target.venv, "bin/activate"), `touch ${quote(marker)}\nreturn 99\n`);
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-i"], { cwd: target.checkout, env: { ...process.env, PS1: "", HOME: target.stateDirectory, PYTHONHOME: "/invalid", PYTHONPATH: "/invalid" }, stdio: "pipe" });
  assert.ok(child.pid);
  let output = ""; child.stdout.on("data", text => { output += text; }); child.stderr.on("data", text => { output += text; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  t.after(async () => { child.stdin.end("exit\n"); if (child.exitCode === null) child.kill("SIGKILL"); await closed; });
  const binding = await activateEnvironment(target, mock(target, { pid: child.pid }));
  const path = await runner(target, binding, module, { reload: true, settings: { shellPath: "/bin/bash", shellCommandPrefix: "export HERDR_TEST_PREFIX=1" } });
  child.stdin.write(`PROMPT_COMMAND='unset VIRTUAL_ENV; export PATH=/usr/bin:/bin'\nexport VIRTUAL_ENV=${quote(target.venv)}\n`);
  const shellEnv = join(target.stateDirectory, "shell-env");
  child.stdin.write(`printf 'env=%s' "$VIRTUAL_ENV" > ${quote(shellEnv)}\n`);
  assert.equal(await waitFile(shellEnv, () => output), "env=");
  child.stdin.write(`${quote(process.execPath)} --import ${quote(import.meta.resolve("tsx"))} ${quote(path)}\n`);
  const result = JSON.parse(await waitFile(join(target.stateDirectory, "runner-result"), () => output));
  const proof = JSON.parse(await readFile(binding.proofPath, "utf8"));
  assert.equal(proof.piPid, result.pid); assert.notEqual(result.pid, child.pid);
  assert.equal(proof.pythonPrefix, target.venv); assert.equal(proof.pythonCwd, target.checkout); assert.equal(proof.virtualEnv, target.venv);
  assert.equal(result.path.split(":").filter((entry: string) => entry === join(target.venv, "bin")).length, 1);
  await assert.rejects(access(marker)); await assert.rejects(access(join(target.checkout, "OWNED")));
});
test("effective shell prefix, BASH_ENV, replacement/disabled Bash and failed reload revoke receipts", async t => {
  const module = await bashModule(t); if (!module) return;
  const target = await fixture(t), bashEnv = join(target.stateDirectory, "bash-env");
  await writeFile(bashEnv, "unset VIRTUAL_ENV\n");
  for (const scenario of ["prefix", "bash-env", "replacement", "inactive", "failed-reload", "cwd", "bad-shell"] as const) {
    const binding = await activateEnvironment(target, mock(target));
    await fakeProof(target, binding);
    const path = await runner(target, binding, module, {
      settings: scenario === "prefix" ? { shellCommandPrefix: "unset VIRTUAL_ENV" } : scenario === "bad-shell" ? { shellPath: "/not/a/shell" } : {},
      source: scenario === "replacement" ? "extension" : undefined, inactive: scenario === "inactive", failureAfterSuccess: scenario === "failed-reload",
    });
    await assert.rejects(run(process.execPath, ["--import", import.meta.resolve("tsx"), path], { cwd: scenario === "cwd" ? target.stateDirectory : target.checkout, env: { ...process.env, ...(scenario === "bash-env" ? { BASH_ENV: bashEnv } : {}) }, timeout: 15_000 }));
    await assert.rejects(access(binding.proofPath), { code: "ENOENT" });
  }
});
test("busy, replaced or unidentified shells never receive terminal input", async t => {
  const target = await fixture(t);
  for (const options of [
    { piPid: 5555 }, { shell: "fish" }, { pane: (p: Pane) => { p.agent_status = "idle"; } },
    { info: (i: PaneProcessInfo) => { i.foreground_processes = []; } },
    { info: (i: PaneProcessInfo) => { i.foreground_processes.push({ ...i.foreground_processes[0]!, pid: 5555 }); } },
    { pane: (p: Pane) => { p.terminal_id = "other"; } }, { pane: (p: Pane) => { p.workspace_id = "other"; } },
    { pane: (p: Pane) => { p.cwd = target.stateDirectory; } },
    { info: (i: PaneProcessInfo, count: number) => { if (count === 2) i.shell_pid = 9999; } },
  ]) await assert.rejects(activateEnvironment(target, mock(target, options)));
});
test("valid receipt requires matching live foreground PID, exact target, Python evidence and disk environment", async t => {
  const target = await fixture(t), binding = await activateEnvironment(target, mock(target));
  await fakeProof(target, binding);
  await verifyPiEnvironment(target, binding, mock(target, { piPid: 4343 }));
  for (const extra of [{ piPid: undefined }, { piPid: 9999 }, { piPid: binding.shellPid }, { nonce: "a".repeat(64) }, { shellPid: 2222 }, { workspaceId: "other" }, { paneId: "other" }, { terminalId: "other" }, { checkout: "/other" }, { pythonPrefix: "/other" }, { pythonCwd: "/other" }, { pythonExecutable: "/usr/bin/python" }, { virtualEnv: "/other" }, { piPathFirst: "/other" }, { contaminated: true }, { noUserSite: "0" }]) {
    await fakeProof(target, binding, extra);
    await assert.rejects(verifyPiEnvironment(target, binding, mock(target, { piPid: 4343 })));
  }
  await fakeProof(target, binding);
  for (const options of [
    { piPid: 7777 }, { piPid: 4343, pid: 2222 },
    { piPid: 4343, pane: (p: Pane) => { p.terminal_id = "recycled"; } },
    { piPid: 4343, pane: (p: Pane) => { p.foreground_cwd = target.stateDirectory; } },
    { piPid: 4343, info: (i: PaneProcessInfo) => { i.foreground_processes[0]!.cwd = target.stateDirectory; } },
  ]) await assert.rejects(verifyPiEnvironment(target, binding, mock(target, options)));
  await rm(join(target.venv, "pyvenv.cfg"));
  await assert.rejects(verifyPiEnvironment(target, binding, mock(target, { piPid: 4343 })));
});
test("missing, symlinked, oversized or non-private receipt and unsafe binding paths fail closed", async t => {
  const target = await fixture(t), binding = await activateEnvironment(target, mock(target)), herdr = mock(target, { piPid: 4343 });
  await rejectsDetails(verifyPiEnvironment({ ...target, timeoutMs: 100 }, binding, herdr), /timed out/);
  await fakeProof(target, binding); await chmod(binding.proofPath, 0o644);
  await rejectsDetails(verifyPiEnvironment(target, binding, herdr), /private/);
  await rm(binding.proofPath); await symlink(binding.extensionPath, binding.proofPath);
  await assert.rejects(verifyPiEnvironment(target, binding, herdr));
  await rm(binding.proofPath); await writeFile(binding.proofPath, " ".repeat(20_000), { mode: 0o600 });
  await rejectsDetails(verifyPiEnvironment(target, binding, herdr), /bounded/);
  await assert.rejects(verifyPiEnvironment(target, { ...binding, proofPath: join(target.checkout, "proof.json") }, herdr));
  await chmod(dirname(binding.extensionPath), 0o755);
  await rejectsDetails(verifyPiEnvironment(target, binding, herdr), /private/);
});
test("external symlinks, controls, PATH colons, checkout artifacts and pi shadowing fail before start", async t => {
  const target = await fixture(t), other = await fixture(t);
  const outside = join(target.checkout, "external"); await symlink(other.venv, outside);
  for (const entry of [{ ...target, venv: outside }, { ...target, checkout: target.checkout + "\n" }, { ...target, paneId: "pane\u001b" }, { ...target, stateDirectory: join(target.checkout, "state") }]) await assert.rejects(activateEnvironment(entry, mock(entry)));
  await writeFile(join(target.venv, "bin/pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await rejectsDetails(activateEnvironment(target, mock(target)), /shadow the coding harness/);
  const venv = join(target.checkout, "colon:venv"); await mkdir(venv); await mkdir(join(venv, "bin"));
  await rejectsDetails(activateEnvironment({ ...target, venv }, mock(target)), /cannot be represented safely in PATH/);
});
test("disk verification does not mutate caller environment; candidate PATH is reload-idempotent", async t => {
  const target = await fixture(t), before = process.env.VIRTUAL_ENV, paths = await environmentPaths(target.checkout, target.venv);
  await verifyEnvironment(target.checkout, target.venv); assert.equal(process.env.VIRTUAL_ENV, before);
  const env = candidateEnvironment(paths, { ...process.env, PYTHONHOME: "/bad", PATH: paths.bin + ":/bin:" + paths.bin });
  assert.equal(env.PATH, paths.bin + ":/bin"); assert.equal(env.PYTHONHOME, undefined);
  assert.deepEqual(candidateEnvironment(paths, env), env);
  await rejectsDetails(verifyEnvironment(target.checkout, target.venv, async binary => JSON.stringify({ pythonPrefix: "/other", pythonCwd: target.checkout, pythonExecutable: binary })), /actual interpreter/);
});
