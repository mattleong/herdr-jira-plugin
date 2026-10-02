// A bounded helper waits for the popup process to exit, then focuses the verified checkout.
// Keeping focus outside the popup avoids its teardown restoring the prior workspace.
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Herdr } from "./herdr.js";
import { messageOf } from "./errors.js";
const [pidText, workspaceId, checkout, paneId, message] = process.argv.slice(2);
const parent = Number(pidText);
try {
  if (!Number.isSafeInteger(parent) || parent <= 1 || !workspaceId || !checkout) throw new Error("Invalid focus request.");
  let exited = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(parent, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { exited = true; break; }
      throw error;
    }
    await delay(50);
  }
  if (!exited) throw new Error("Popup has not exited; open the ticket workspace manually.");
  const herdr = new Herdr();
  const workspace = (await herdr.workspaces()).find(w => w.workspace_id === workspaceId);
  if (!workspace?.worktree || await realpath(workspace.worktree.checkout_path) !== await realpath(checkout)) throw new Error("Ticket workspace changed; it was not focused.");
  if (paneId && (await herdr.pane(paneId)).workspace_id !== workspaceId) throw new Error("Ticket pane moved; open its workspace manually.");
  await herdr.focus(workspaceId, paneId || undefined);
  if (message) await herdr.notify(message);
} catch (error) {
  try { await new Herdr().notify(messageOf(error)); } catch { /* Detached helper cannot safely retry. */ }
  process.exitCode = 1;
}
