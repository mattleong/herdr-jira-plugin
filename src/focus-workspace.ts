import { realpath } from "node:fs/promises";
import type { Herdr } from "./herdr.js";

export interface FocusTarget { workspaceId: string; checkout: string; paneId?: string }
export async function focusWorkspace(target: FocusTarget, herdr: Pick<Herdr, "workspaces" | "panes" | "focus">): Promise<void> {
  const workspace = (await herdr.workspaces()).find(item => item.workspace_id === target.workspaceId);
  if (!workspace?.worktree || await realpath(workspace.worktree.checkout_path) !== await realpath(target.checkout)) {
    throw new Error("Ticket workspace changed; it was not focused.");
  }
  // Missing/moved panes are stale hints, not a reason to discard a verified workspace.
  // A list failure still propagates; it must not be mistaken for proof that a pane disappeared.
  const panes = target.paneId ? await herdr.panes(target.workspaceId) : [];
  const pane = panes.find(item => item.pane_id === target.paneId && item.workspace_id === target.workspaceId);
  await herdr.focus(target.workspaceId, pane?.pane_id);
}
