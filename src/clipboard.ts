import { spawn } from "node:child_process";
import { diagnosticText, WorkflowError } from "./errors.js";

type ClipboardOptions = { input: string; timeout: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
export type ClipboardRun = (binary: string, args: string[], options: ClipboardOptions) => Promise<unknown>;

// xclip/wl-copy may fork a persistent clipboard owner. Ignore their output pipes and wait
// for the original process's exit, not inherited-pipe closure. Successful owners must survive.
export const runClipboard: ClipboardRun = (binary, args, options) => new Promise<void>((resolve, reject) => {
  if (options.signal?.aborted) { reject(new WorkflowError("Clipboard copy cancelled.")); return; }
  const child = spawn(binary, args, { stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32", env: options.env });
  let settled = false;
  function kill(): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch { /* Already exited. */ }
  }
  function finish(error?: Error): void {
    if (settled) return;
    settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    if (error) { kill(); reject(error); } else resolve();
  }
  const abort = () => finish(new WorkflowError("Clipboard copy cancelled."));
  const timer = setTimeout(() => finish(new WorkflowError("Clipboard copy timed out.")), options.timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.on("error", error => finish(error));
  child.stdin.on("error", error => finish(error));
  child.on("exit", code => finish(code === 0 ? undefined : new WorkflowError("Clipboard command failed.")));
  child.stdin.end(options.input);
});
export async function copyErrorDetails(text: string, options: { execute?: ClipboardRun; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<void> {
  const { execute = runClipboard, platform = process.platform, env = process.env, signal } = options;
  const command = platform === "darwin" ? ["pbcopy"]
    : env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  await execute(command[0]!, command.slice(1), { input: diagnosticText(text), timeout: 5000, env, signal });
}
