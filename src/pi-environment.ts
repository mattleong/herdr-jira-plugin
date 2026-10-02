import { realpath } from "node:fs/promises";
import {
  assertBashEvidence, candidateEnvironment, clearProof, environmentPaths, publishProof,
  pythonContamination, pythonProbeScript, validateBinding,
} from "./environment-probe.js";
import { WorkflowError } from "./errors.js";
import type { EnvironmentBinding, EnvironmentTarget } from "./setup-types.js";

// Structural slice of Pi's public extension API; the generated extension imports the
// host-provided createBashTool (never a second Pi installation or a checkout module).
export interface EnvironmentExtensionAPI {
  on(event: "session_start", handler: (event: unknown, ctx: { cwd: string }) => Promise<void>): unknown;
  getActiveTools(): string[];
  getAllTools(): { name: string; sourceInfo: { source: string; path: string } }[];
  getSettings(): { shellPath?: string; shellCommandPrefix?: string };
}
export type BashToolFactory = (cwd: string, options: { shellPath?: string; commandPrefix?: string }) => {
  execute(id: string, args: { command: string; timeout: number }, signal?: AbortSignal): Promise<{
    isError?: boolean; structuredContent?: unknown;
  }>;
};
export interface PiEnvironmentConfig { target: EnvironmentTarget; binding: EnvironmentBinding }

/** Awaited extension factory: bind Pi itself, not its parent terminal shell. */
export async function bindPiEnvironment(pi: EnvironmentExtensionAPI, createBashTool: BashToolFactory, config: PiEnvironmentConfig): Promise<void> {
  const { target, binding } = config;
  // Always revoke earlier success, including /reload and failed factory validation.
  await clearProof(binding.proofPath);
  await validateBinding(target, binding);
  const paths = await environmentPaths(target.checkout, target.venv);
  if (paths.checkout !== target.checkout || paths.venv !== target.venv || await realpath(process.cwd()) !== paths.checkout) throw new WorkflowError("Pi did not start in the bound checkout.");
  const env = candidateEnvironment(paths, process.env);
  for (const key of ["VIRTUAL_ENV", "PATH", "PYTHONNOUSERSITE"]) process.env[key] = env[key];
  for (const key of pythonContamination) delete process.env[key];

  pi.on("session_start", async (_event, ctx) => {
    await clearProof(binding.proofPath);
    try {
      await validateBinding(target, binding);
      if (await realpath(ctx.cwd) !== paths.checkout || await realpath(process.cwd()) !== paths.checkout) throw new WorkflowError("Pi's session cwd changed before environment verification.");
      const bash = pi.getAllTools().find(tool => tool.name === "bash");
      if (!pi.getActiveTools().includes("bash") || bash?.sourceInfo.source !== "builtin" || bash.sourceInfo.path !== "builtin:bash") throw new WorkflowError("Python binding requires the active built-in Bash tool; custom/disabled Bash is not supported.");
      const settings = pi.getSettings();
      const timeoutMs = Math.min(target.timeoutMs, 10_000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WorkflowError("Invalid Python verification timeout.");
      // Use the same exported backend and effective settings as Pi's built-in tool.
      // Do not override tools, prefix, BASH_ENV, or shellPath to make a probe pass.
      const tool = createBashTool(paths.checkout, { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix });
      const result = await tool.execute("herdr-environment-" + binding.nonce, {
        command: "python -B -c '" + pythonProbeScript.replaceAll("'", "'\\''") + "'",
        timeout: timeoutMs / 1000,
      }, AbortSignal.timeout(timeoutMs));
      const output = result.structuredContent as { output?: unknown; truncated?: unknown; exit_code?: unknown } | undefined;
      if (result.isError || output?.exit_code !== 0 || output.truncated !== false || typeof output.output !== "string" || Buffer.byteLength(output.output) > 16 * 1024) throw new WorkflowError("Pi's Bash environment probe failed or returned unsupported output.");
      const evidence: unknown = JSON.parse(output.output);
      assertBashEvidence(evidence, paths);
      // Detect process-environment changes by other extensions as well as shell startup sabotage.
      if (process.env.VIRTUAL_ENV !== paths.venv || process.env.PATH?.split(":")[0] !== paths.bin || process.env.PYTHONNOUSERSITE !== "1" || pythonContamination.some(key => process.env[key] !== undefined)) throw new WorkflowError("Pi's process environment changed before verification.");
      const current = await environmentPaths(target.checkout, target.venv);
      if (current.checkout !== paths.checkout || current.venv !== paths.venv) throw new WorkflowError("The bound environment moved during verification.");
      await publishProof(binding.proofPath, {
        version: 1, nonce: binding.nonce, piPid: process.pid, shellPid: binding.shellPid, piPathFirst: paths.bin,
        checkout: paths.checkout, venv: paths.venv, workspaceId: target.workspaceId, paneId: target.paneId, terminalId: target.terminalId,
        pythonPrefix: evidence.pythonPrefix, pythonCwd: evidence.pythonCwd, pythonExecutable: evidence.pythonExecutable,
        virtualEnv: evidence.virtualEnv, pathFirst: evidence.pathFirst, noUserSite: evidence.noUserSite, contaminated: evidence.contaminated,
      });
    } catch (error) {
      await clearProof(binding.proofPath);
      throw error; // Pi reports extension errors nonfatally; the parent requires the receipt.
    }
  });
}
