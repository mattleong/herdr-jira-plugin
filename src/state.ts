import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, type Ticket } from "./ticket.js";
import { WorkflowError } from "./errors.js";
import type { SetupState } from "./setup-types.js";
export type { SetupState } from "./setup-types.js";

function validSetup(value: unknown, checkout: string | undefined, directory: string): value is SetupState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const setup = value as Record<string, unknown>;
  if (Object.keys(setup).some(key => !["status", "stage", "summary", "venv", "binding", "logPath"].includes(key)) || typeof setup.status !== "string" || !["running", "failed", "succeeded", "skipped"].includes(setup.status)) return false;
  if (setup.stage !== undefined && setup.stage !== "dependencies" && setup.stage !== "activation") return false;
  for (const key of ["summary", "venv", "logPath"]) {
    if (setup[key] !== undefined && (typeof setup[key] !== "string" || !setup[key] || setup[key].length > 8192 || /[\x00-\x1f\x7f]/.test(setup[key]))) return false;
  }
  const contained = (root: string, path: string) => {
    const rel = relative(root, path);
    return isAbsolute(path) && !!rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  };
  if (setup.venv !== undefined && (!checkout || !contained(checkout, setup.venv as string) || setup.status !== "succeeded")) return false;
  if (setup.logPath !== undefined && !contained(directory, setup.logPath as string)) return false;
  if (setup.binding !== undefined) {
    if (!setup.venv || setup.stage !== "activation" || setup.status !== "succeeded" || !setup.binding || typeof setup.binding !== "object" || Array.isArray(setup.binding)) return false;
    const binding = setup.binding as Record<string, unknown>;
    if (Object.keys(binding).some(key => !["version", "extensionPath", "proofPath", "nonce", "shellPid"].includes(key)) || binding.version !== 1 || typeof binding.nonce !== "string" || !/^[a-f0-9]{64}$/.test(binding.nonce) || !Number.isSafeInteger(binding.shellPid) || Number(binding.shellPid) <= 0) return false;
    for (const key of ["extensionPath", "proofPath"]) {
      const path = binding[key];
      if (typeof path !== "string" || path.length > 8192 || /[\x00-\x1f\x7f]/.test(path) || !contained(directory, path) || (checkout && contained(checkout, path))) return false;
    }
    const parent = dirname(binding.extensionPath as string);
    if (binding.extensionPath !== join(parent, "extension.mjs") || binding.proofPath !== join(parent, "proof.json")) return false;
  }
  // Legacy venv records still load, but launch refuses to resume them without a binding.
  return true;
}

export type Phase = "reserving" | "reserved" | "creating" | "created" | "starting" | "ready" | "submitting" | "dispatched";
export interface RecordState {
  version: 1; repo: string; ticket: Ticket; harness: string; socket: string;
  branch: string; baseSha: string; baseRef?: string; phase: Phase; agentName: string; updatedAt: string;
  checkout?: string; workspaceId?: string; paneId?: string; terminalId?: string;
  setup?: SetupState;
}
export class State {
  constructor(readonly directory: string) {}
  // Retain existing ticket record keys for backward compatibility and cross-site ambiguity checks.
  key(repo: string, ticket: Ticket): string { return hash(repo + "\0" + ticket.key, 32); }
  branchKey(repo: string, branch: string): string { return "branch-" + hash(repo + "\0" + branch, 32); }
  private path(key: string): string { return join(this.directory, `${key}.json`); }
  async load(key: string): Promise<RecordState | undefined> {
    let text: string;
    try { text = await readFile(this.path(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let value: RecordState;
    try { value = JSON.parse(text) as RecordState; } catch { throw new WorkflowError("Ticket state is corrupt. Inspect its file before recovery."); }
    if (!value || value.version !== 1 || typeof value.branch !== "string" || !value.branch || typeof value.repo !== "string" || !value.ticket || typeof value.ticket.key !== "string" || typeof value.ticket.site !== "string" || typeof value.socket !== "string" || typeof value.baseSha !== "string" || typeof value.agentName !== "string" || !["reserving","reserved","creating","created","starting","ready","submitting","dispatched"].includes(value.phase)) throw new WorkflowError("Ticket state is invalid or from an unsupported version. Inspect before recovery.");
    if (value.setup !== undefined && !validSetup(value.setup, value.checkout, this.directory)) throw new WorkflowError("Ticket setup state is invalid. Inspect before recovery.");
    return value;
  }
  async assertBranchAvailable(repo: string, branch: string, ownKey: string): Promise<void> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const file of files) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const key = file.slice(0, -5);
      if (key === ownKey) continue;
      const record = await this.load(key);
      if (record?.repo === repo && record.branch === branch) throw new WorkflowError(`Branch ${branch} is already tracked for ${record.ticket.key}. Inspect its workspace/state; it cannot be reassigned silently.`);
    }
  }
  async save(key: string, value: RecordState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.path(key) + "." + randomUUID() + ".tmp";
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, this.path(key)); } finally { await unlink(temporary).catch(() => {}); }
  }
  async lock(key: string): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, key + ".lock");
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new WorkflowError(`Another launch or interrupted process holds the ticket lock. Inspect ${path}; remove it only after confirming the recorded process and any interrupted installer children have exited.`);
    }
    await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }) + "\n");
    await file.close();
    return async () => { await unlink(path); };
  }
}
