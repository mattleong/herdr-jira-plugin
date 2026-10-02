import { spawn } from "node:child_process";
import { WorkflowError, safeText } from "./errors.js";

export type Run = (binary: string, args: string[], options?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<string>;
export const run: Run = (binary, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, {
    cwd: options.cwd, env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "", size = 0;
  let failure: WorkflowError | undefined;
  let settled = false;
  let escalation: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  function signal(value: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid, value); // Terminate wrappers and their descendants too.
    } catch { /* A process group that already exited needs no signal. */ }
  }
  function finish(error?: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (error) reject(error); else resolve(stdout);
  }
  function terminate(reason: string): void {
    if (failure || settled) return;
    failure = new WorkflowError(`${binary} ${reason}. Its operation may have completed; inspect before retrying.`);
    signal("SIGTERM");
    // Even if the leader exits on TERM, ensure a child holding inherited pipes cannot outlive it.
    escalation = setTimeout(() => {
      signal("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(failure);
    }, 250);
  }
  deadline = setTimeout(() => terminate("timed out"), options.timeout ?? 30_000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    size += Buffer.byteLength(text);
    if (size > 2 * 1024 * 1024) return terminate("exceeded the output limit");
    stdout += text;
  });
  child.stderr.on("data", (text: string) => {
    size += Buffer.byteLength(text);
    if (size > 2 * 1024 * 1024) return terminate("exceeded the output limit");
    stderr += text;
  });
  child.on("error", error => {
    clearTimeout(escalation);
    finish(new WorkflowError(`${binary} could not run: ${safeText(error.message)}`));
  });
  child.on("close", (code, killedBy) => {
    if (failure) {
      // Keep the escalation timer to clean the full process group before returning.
      return;
    }
    const detail = safeText(stderr.trim());
    finish(code === 0 ? undefined : new WorkflowError(`${binary} failed${detail ? `: ${detail}` : ` (exit ${code ?? killedBy ?? "unknown"})`}.`));
  });
});
