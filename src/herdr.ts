import { WorkflowError, safeText } from "./errors.js";
import { run, type Run } from "./process.js";

export interface Pane { pane_id: string; workspace_id: string; terminal_id: string; cwd?: string; foreground_cwd?: string; agent?: string; agent_status?: string }
export interface Agent extends Pane { name?: string; interactive_ready?: boolean; launch_pending?: boolean }
export interface Workspace { workspace_id: string; worktree?: { checkout_path: string; repo_root: string } }
export interface Created { workspace: Workspace; root_pane: Pane; worktree: { path: string; branch?: string } }
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("Herdr returned an invalid response.");
  return value as Record<string, unknown>;
}
function required(value: unknown, field: string): string {
  const result = obj(value)[field];
  if (typeof result !== "string" || !result) throw new WorkflowError(`Herdr response is missing ${field}.`);
  return result;
}
export class Herdr {
  readonly socket: string;
  readonly binary: string;
  constructor(private readonly execute: Run = run, private readonly env: NodeJS.ProcessEnv = process.env) {
    if (!env.HERDR_SOCKET_PATH) throw new WorkflowError("Invoke this plugin from a running Herdr session.");
    this.socket = env.HERDR_SOCKET_PATH;
    this.binary = env.HERDR_BIN_PATH ?? "herdr";
  }
  async call(args: string[], timeout = 30_000): Promise<Record<string, unknown>> {
    const output = await this.execute(this.binary, args, { timeout, env: this.env });
    let envelope: Record<string, unknown>;
    try { envelope = obj(JSON.parse(output)); }
    catch { throw new WorkflowError("Herdr returned invalid JSON; inspect the operation before retrying."); }
    if (envelope.error) throw new WorkflowError(`Herdr rejected the operation: ${safeText(String(obj(envelope.error).message ?? "unknown error"))}`);
    return obj(envelope.result);
  }
  async pane(id: string): Promise<Pane> {
    const pane = obj((await this.call(["pane", "get", id])).pane);
    required(pane, "pane_id"); required(pane, "workspace_id"); required(pane, "terminal_id");
    return pane as unknown as Pane;
  }
  async panes(workspace: string): Promise<Pane[]> {
    const panes = (await this.call(["pane", "list", "--workspace", workspace])).panes;
    if (!Array.isArray(panes)) throw new WorkflowError("Herdr returned invalid pane data.");
    for (const pane of panes) { required(pane, "pane_id"); required(pane, "workspace_id"); required(pane, "terminal_id"); }
    return panes as Pane[];
  }
  async agent(id: string): Promise<Agent> {
    const agent = obj((await this.call(["agent", "get", id])).agent);
    required(agent, "pane_id"); required(agent, "terminal_id");
    return agent as unknown as Agent;
  }
  async workspaces(): Promise<Workspace[]> {
    const value = (await this.call(["workspace", "list"])).workspaces;
    if (!Array.isArray(value)) throw new WorkflowError("Herdr returned invalid workspace data.");
    for (const workspace of value) required(workspace, "workspace_id");
    return value as Workspace[];
  }
  async create(cwd: string, branch: string, sha: string): Promise<Created> {
    const result = await this.call(["worktree", "create", "--cwd", cwd, "--branch", branch, "--base", sha, "--label", branch, "--no-focus"], 60_000);
    return this.created(result);
  }
  async open(cwd: string, path: string, label: string): Promise<Created> {
    return this.created(await this.call(["worktree", "open", "--cwd", cwd, "--path", path, "--label", label, "--no-focus"]));
  }
  private created(result: Record<string, unknown>): Created {
    required(result.workspace, "workspace_id"); required(result.root_pane, "pane_id");
    required(result.root_pane, "terminal_id"); required(result.worktree, "path");
    return result as unknown as Created;
  }
  async start(name: string, kind: string, pane: string, args: string[], timeout: number): Promise<Agent> {
    const result = await this.call(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", String(timeout), ...(args.length ? ["--", ...args] : [])], timeout + 5000);
    const agent = obj(result.agent);
    required(agent, "pane_id"); required(agent, "terminal_id");
    return agent as unknown as Agent;
  }
  async prompt(name: string, text: string): Promise<void> { await this.call(["agent", "prompt", name, text]); }
  async focus(workspace: string, pane?: string): Promise<void> {
    await this.call(["workspace", "focus", workspace]);
    if (pane) await this.call(["pane", "focus", pane]);
  }
  async openForm(origin: string): Promise<void> {
    await this.call(["plugin", "pane", "open", "--plugin", "local.jira", "--entrypoint", "form", "--env", `HERDR_JIRA_ORIGIN=${origin}`]);
  }
  async notify(text: string): Promise<void> {
    await this.call(["notification", "show", "Jira", "--body", safeText(text)], 5000);
  }
}
