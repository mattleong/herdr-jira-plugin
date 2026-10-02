import { isAbsolute } from "node:path";
import { WorkflowError } from "./errors.js";
import type { Herdr } from "./herdr.js";
import type { Repository } from "./repository.js";
import { Git } from "./repository.js";

export interface Origin { repo: Repository; paneId: string; workspaceId: string; socket: string }
export async function captureOrigin(herdr: Herdr, git: Git, env: NodeJS.ProcessEnv): Promise<Origin> {
  let context: Record<string, unknown>;
  try { context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as Record<string, unknown>; }
  catch { throw new WorkflowError("Invalid Herdr invocation context."); }
  const id = context.focused_pane_id ?? env.HERDR_PANE_ID;
  if (typeof id !== "string" || !id) throw new WorkflowError("No originating pane. Invoke Start Jira ticket from a repository pane.");
  const pane = await herdr.pane(id);
  const cwd = pane.foreground_cwd ?? (typeof context.focused_pane_cwd === "string" ? context.focused_pane_cwd : pane.cwd);
  if (!cwd || !isAbsolute(cwd)) throw new WorkflowError("Cannot resolve the originating pane's directory.");
  const repo = await git.resolve(cwd);
  return { repo, paneId: pane.pane_id, workspaceId: pane.workspace_id, socket: herdr.socket };
}
export function parseOrigin(text: string | undefined, socket: string): Origin {
  let value: Origin;
  try { value = JSON.parse(text ?? "") as Origin; } catch { throw new WorkflowError("Missing launch context. Invoke the Start Jira ticket action."); }
  if (!value || value.socket !== socket || !value.repo || !isAbsolute(value.repo.checkout ?? "") || !isAbsolute(value.repo.commonDir ?? "") || typeof value.paneId !== "string" || typeof value.workspaceId !== "string") throw new WorkflowError("Invalid or mismatched originating context.");
  return value;
}
