import { chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { detailsOf, messageOf, WorkflowError } from "./errors.js";
import type { Herdr, PaneProcessInfo } from "./herdr.js";
import type { EnvironmentBinding, EnvironmentTarget } from "./setup-types.js";
import {
  assertBashEvidence, environmentPaths, inside, readPrivateFile, safeArgument, validateBinding,
  verifyCandidate, type EnvironmentPaths, type EnvironmentProof,
} from "./environment-probe.js";
import type { Run } from "./process.js";

function diagnostics(error: unknown): string { return messageOf(error) + "\n\n" + detailsOf(error); }
function shellName(value: string): string { return basename(value).replace(/^-/, ""); }
function deadline(timeoutMs: number): () => number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new WorkflowError("Environment verification requires a finite positive timeout.");
  const end = Date.now() + timeoutMs;
  return () => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new WorkflowError("Python environment verification timed out without a private Pi receipt. No start or prompt was repeated; inspect the workspace.");
    return remaining;
  };
}
async function targetPane(target: EnvironmentTarget, paths: EnvironmentPaths, herdr: Herdr, timeout: number) {
  const pane = await herdr.pane(target.paneId, timeout);
  if (pane.pane_id !== target.paneId || pane.workspace_id !== target.workspaceId || pane.terminal_id !== target.terminalId) throw new WorkflowError("The environment target pane moved or changed workspace/terminal.");
  const cwds = [pane.cwd, pane.foreground_cwd].filter((value): value is string => value !== undefined && value !== null);
  if (!cwds.length) throw new WorkflowError("Herdr did not report the target pane's cwd.");
  for (const cwd of cwds) if (await realpath(safeArgument(cwd)) !== paths.checkout) throw new WorkflowError("The target pane is not in the canonical target checkout.");
  return pane;
}
async function targetShell(target: EnvironmentTarget, paths: EnvironmentPaths, herdr: Herdr, remaining: () => number, expectedPid?: number): Promise<PaneProcessInfo> {
  const pane = await targetPane(target, paths, herdr, remaining());
  if (pane.agent || (pane.agent_status && pane.agent_status !== "unknown")) throw new WorkflowError("The target pane has an agent; environment binding must be prepared before Pi starts.");
  const info = await herdr.processInfo(target.paneId, remaining());
  if (info.pane_id !== target.paneId || (expectedPid !== undefined && info.shell_pid !== expectedPid)) throw new WorkflowError("The target pane's shell changed during environment preparation.");
  const foreground = info.foreground_processes[0];
  if (info.foreground_process_group_id !== info.shell_pid || info.foreground_processes.length !== 1 || foreground?.pid !== info.shell_pid) throw new WorkflowError("The target pane is busy or its foreground shell cannot be verified.");
  const supported = new Set(["bash", "zsh", "sh"]);
  if (!supported.has(shellName(foreground.name)) || !supported.has(shellName(foreground.argv0))) throw new WorkflowError(`Unsupported target shell ${foreground.name}; expected interactive bash, zsh, or sh.`);
  if (await realpath(safeArgument(foreground.cwd)) !== paths.checkout) throw new WorkflowError("The foreground shell is not in the canonical target checkout.");
  return info;
}
/** Disk validation supplements the Pi receipt; it is never sufficient for startup recovery. */
export async function verifyEnvironment(checkout: string, venv: string, execute?: Run): Promise<void> {
  try { await verifyCandidate(await environmentPaths(checkout, venv), 10_000, execute); }
  catch (error) { throw new WorkflowError("The recorded Python environment could not be verified.", false, diagnostics(error)); }
}
/** Prepare an explicit private extension. Never send exports or any other terminal input. */
export async function activateEnvironment(target: EnvironmentTarget, herdr: Herdr): Promise<EnvironmentBinding> {
  try {
    const remaining = deadline(target.timeoutMs);
    for (const value of [target.checkout, target.venv, target.workspaceId, target.paneId, target.terminalId, target.stateDirectory]) safeArgument(value);
    const paths = await environmentPaths(target.checkout, target.venv);
    if (target.checkout !== paths.checkout || target.venv !== paths.venv) throw new WorkflowError("Environment binding requires canonical checkout and venv paths.");
    const initial = await targetShell(target, paths, herdr, remaining);
    await verifyCandidate(paths, Math.min(10_000, remaining()));
    await mkdir(target.stateDirectory, { recursive: true, mode: 0o700 });
    const stateDirectory = await realpath(target.stateDirectory);
    if (stateDirectory === paths.checkout || inside(paths.checkout, stateDirectory)) throw new WorkflowError("Pi binding artifacts must be outside the checkout.");
    // Herdr creates its state root as 0755. Only our per-attempt child must be 0700;
    // reject a root another user can replace, without changing Herdr's directory mode.
    const stateInfo = await lstat(stateDirectory);
    if (!stateInfo.isDirectory() || (stateInfo.mode & 0o022) !== 0 || (process.getuid && stateInfo.uid !== process.getuid())) throw new WorkflowError("The environment state directory must be owned by this user and not writable by other users.");
    const directory = await mkdtemp(join(stateDirectory, "pi-environment-"));
    await chmod(directory, 0o700);
    const binding: EnvironmentBinding = { version: 1, extensionPath: join(directory, "extension.mjs"), proofPath: join(directory, "proof.json"), nonce: randomBytes(32).toString("hex"), shellPid: initial.shell_pid };
    // Absolute trusted plugin helper, never an activate script or module from the target checkout.
    const helper = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pi-environment.ts" : "./pi-environment.js", import.meta.url));
    if (inside(paths.checkout, await realpath(helper))) throw new WorkflowError("Pi environment helper must be installed outside the target checkout.");
    // Revoke before importing the helper too: a failed helper reload cannot retain old success.
    const source = `import { createBashTool } from "@earendil-works/pi-coding-agent";\nimport { unlink } from "node:fs/promises";\nexport default async function(pi) {\n  await unlink(${JSON.stringify(binding.proofPath)}).catch(error => { if (error.code !== "ENOENT") throw error; });\n  const { bindPiEnvironment } = await import(${JSON.stringify(helper)});\n  await bindPiEnvironment(pi, createBashTool, ${JSON.stringify({ target: { ...target, stateDirectory }, binding })});\n}\n`;
    await writeFile(binding.extensionPath, source, { flag: "wx", mode: 0o600 });
    await chmod(binding.extensionPath, 0o600);
    await validateBinding(target, binding);
    await targetShell(target, paths, herdr, remaining, initial.shell_pid);
    remaining();
    // Retained for recovery and /reload. The launch journal records this before Herdr.start.
    return binding;
  } catch (error) {
    throw new WorkflowError("Python binding could not be prepared; Pi was not started. Open the workspace for manual inspection.", false, diagnostics(error));
  }
}
/** Require evidence from the actual Pi foreground process before ANY initial prompt. */
export async function verifyPiEnvironment(target: EnvironmentTarget, binding: EnvironmentBinding, herdr: Herdr): Promise<void> {
  try {
    const remaining = deadline(target.timeoutMs);
    await validateBinding(target, binding);
    const paths = await environmentPaths(target.checkout, target.venv);
    if (paths.checkout !== target.checkout || paths.venv !== target.venv) throw new WorkflowError("The bound checkout or venv moved.");
    let text: string | undefined;
    while (text === undefined) {
      remaining();
      try { text = await readPrivateFile(binding.proofPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(Math.min(50, remaining()));
      }
    }
    const proof = JSON.parse(text) as EnvironmentProof | null;
    if (!proof || proof.version !== 1 || proof.nonce !== binding.nonce || proof.shellPid !== binding.shellPid || !Number.isSafeInteger(proof.piPid) || proof.piPid <= 0 || proof.piPid === binding.shellPid) throw new WorkflowError("Pi environment receipt has a missing/invalid PID or stale nonce.");
    for (const key of ["checkout", "venv", "workspaceId", "paneId", "terminalId"] as const) if (proof[key] !== target[key]) throw new WorkflowError("Pi environment receipt does not match this checkout/workspace/pane/terminal.");
    assertBashEvidence(proof, paths);
    if (proof.piPathFirst !== paths.bin) throw new WorkflowError("Pi process PATH does not lead with the bound venv bin.");
    await verifyCandidate(paths, Math.min(10_000, remaining()));
    const pane = await targetPane(target, paths, herdr, remaining());
    if (pane.agent !== "pi") throw new WorkflowError("The bound pane no longer contains Pi.");
    const info = await herdr.processInfo(target.paneId, remaining());
    const pi = info.foreground_processes.filter(entry => entry.pid === proof.piPid);
    if (info.pane_id !== target.paneId || info.shell_pid !== binding.shellPid || info.foreground_process_group_id === info.shell_pid || pi.length !== 1 || await realpath(safeArgument(pi[0]!.cwd)) !== paths.checkout) throw new WorkflowError("The receipt PID is not Pi in the current target pane's foreground processes.");
    // A concurrent reload revokes/replaces the receipt. Never accept the old snapshot.
    if (await readPrivateFile(binding.proofPath) !== text) throw new WorkflowError("Pi's environment receipt changed during verification; inspect before recovery.");
    remaining();
  } catch (error) {
    throw new WorkflowError("Pi's Python binding is unverified. Open the workspace; no setup, start or prompt will be repeated automatically.", false, diagnostics(error));
  }
}
