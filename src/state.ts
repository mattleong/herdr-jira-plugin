import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, type Ticket } from "./ticket.js";
import { WorkflowError } from "./errors.js";

export type Phase = "reserving" | "reserved" | "creating" | "created" | "starting" | "ready" | "submitting" | "dispatched";
export interface RecordState {
  version: 1; repo: string; ticket: Ticket; harness: string; socket: string;
  branch: string; baseSha: string; phase: Phase; agentName: string; updatedAt: string;
  checkout?: string; workspaceId?: string; paneId?: string; terminalId?: string;
}
export class State {
  constructor(readonly directory: string) {}
  // The branch is the ticket ID even across sites, so all sites must share this lock.
  key(repo: string, ticket: Ticket): string { return hash(repo + "\0" + ticket.key, 32); }
  private path(key: string): string { return join(this.directory, `${key}.json`); }
  async load(key: string): Promise<RecordState | undefined> {
    let text: string;
    try { text = await readFile(this.path(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let value: RecordState;
    try { value = JSON.parse(text) as RecordState; } catch { throw new WorkflowError("Ticket state is corrupt. Inspect its file before recovery."); }
    if (value.version !== 1 || typeof value.repo !== "string" || !value.ticket || typeof value.ticket.key !== "string" || typeof value.ticket.site !== "string" || typeof value.socket !== "string" || typeof value.baseSha !== "string" || typeof value.agentName !== "string" || !["reserving","reserved","creating","created","starting","ready","submitting","dispatched"].includes(value.phase)) throw new WorkflowError("Ticket state is invalid or from an unsupported version. Inspect before recovery.");
    return value;
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
      throw new WorkflowError(`Another launch or interrupted process holds the ticket lock. Inspect ${path}; remove it only after confirming the recorded process has exited.`);
    }
    await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }) + "\n");
    await file.close();
    return async () => { await unlink(path); };
  }
}
