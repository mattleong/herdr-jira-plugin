import { spawn } from "node:child_process";
import { WorkflowError, safeText, diagnosticText } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}
export type Run = (binary: string, args: string[], options?: RunOptions) => Promise<string>;
export const run: Run = (binary, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) return reject(new WorkflowError(`${binary} aborted.`));
  const child = spawn(binary, args, {
    cwd: options.cwd, env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "", size = 0;
  const diagnostics = () => [stderr && `stderr:\n${diagnosticText(stderr)}`, stdout && `stdout:\n${diagnosticText(stdout)}`].filter(Boolean).join("\n\n");
  let failure: string | undefined;
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
    options.signal?.removeEventListener("abort", abort);
    if (error) reject(error); else resolve(stdout);
  }
  function terminate(reason: string): void {
    if (failure || settled) return;
    const summary = `${binary} ${reason}. Its operation may have completed; inspect before retrying.`;
    failure = summary;
    signal("SIGTERM");
    // Even if the leader exits on TERM, ensure a child holding inherited pipes cannot outlive it.
    escalation = setTimeout(() => {
      signal("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(new WorkflowError(failure!, false, `${failure}\n\n${diagnostics()}`));
    }, 250);
  }
  function abort(): void {
    if (settled) return;
    // Abort is used immediately before form process.exit: do not defer group cleanup.
    signal("SIGKILL");
    clearTimeout(escalation);
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    finish(new WorkflowError(`${binary} aborted.`, false, `${binary} aborted.\n\n${diagnostics()}`));
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) { abort(); return; }
  deadline = setTimeout(() => terminate("timed out"), options.timeout ?? 30_000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    size += Buffer.byteLength(text);
    if (size > 2 * 1024 * 1024) return terminate("exceeded the output limit");
    stdout += text;
    try { options.onOutput?.(text, "stdout"); } catch { terminate("output observer failed"); }
  });
  child.stderr.on("data", (text: string) => {
    size += Buffer.byteLength(text);
    if (size > 2 * 1024 * 1024) return terminate("exceeded the output limit");
    stderr += text;
    try { options.onOutput?.(text, "stderr"); } catch { terminate("output observer failed"); }
  });
  child.on("error", error => {
    clearTimeout(escalation);
    finish(new WorkflowError(`${binary} could not run: ${safeText(error.message)}`, false, error.message));
  });
  child.on("close", (code, killedBy) => {
    if (failure) {
      // Keep the escalation timer to clean the full process group before returning.
      return;
    }
    const detail = safeText((stderr || stdout).trim());
    const summary = `${binary} failed${detail ? `: ${detail}` : ` (exit ${code ?? killedBy ?? "unknown"})`}.`;
    finish(code === 0 ? undefined : new WorkflowError(summary, false, `${binary} failed (exit ${code ?? killedBy ?? "unknown"}).\n\n${diagnostics()}`));
  });
});
