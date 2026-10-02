import { access, realpath } from "node:fs/promises";
import type { Config } from "./config.js";
import { WorkflowError } from "./errors.js";
import { getHarness } from "./harnesses.js";
import type { Herdr, Agent } from "./herdr.js";
import type { Origin } from "./origin.js";
import { taskPrompt } from "./prompt.js";
import type { Git } from "./repository.js";
import { State, type RecordState } from "./state.js";
import { agentName, type Ticket } from "./ticket.js";
import { run } from "./process.js";

export interface LaunchRequest { origin: Origin; ticket: Ticket; harness: string; recover?: boolean }
export interface LaunchResult { workspaceId: string; paneId?: string; checkout: string; message: string }
export interface Dependencies { git: Git; herdr: Herdr; state: State; config: Config; progress?: (text: string) => void; preflight?: () => Promise<void> }
export async function launch(request: LaunchRequest, deps: Dependencies): Promise<LaunchResult> {
  const { git, herdr, state, config } = deps;
  const { origin, ticket } = request;
  const harness = getHarness(request.harness);
  if (origin.socket !== herdr.socket) throw new WorkflowError("Origin belongs to a different Herdr server.");
  const currentRepo = await git.resolve(origin.repo.checkout);
  if (currentRepo.commonDir !== origin.repo.commonDir) throw new WorkflowError("The originating repository changed. Open the action again.");
  const key = state.key(currentRepo.commonDir, ticket);
  const release = await state.lock(key);
  const progress = deps.progress ?? (() => {});
  let record: RecordState | undefined;
  try {
    record = await state.load(key);
    if (record && (record.repo !== currentRepo.commonDir || record.ticket.site !== ticket.site || record.ticket.key !== ticket.key || record.branch !== ticket.key)) throw new WorkflowError("This ticket-ID branch is tracked for a different repository or Jira site. Inspect the existing workspace.");
    if (record) {
      if (record.socket !== herdr.socket) throw new WorkflowError("This ticket belongs to another Herdr session. Open that session instead of duplicating its workspace.");
      if (!record.checkout || !record.workspaceId) throw new WorkflowError("An earlier launch stopped before its workspace was recorded. Inspect the Git branch/worktrees and state file; automatic recreation is unsafe.");
      await access(record.checkout);
      const actualRepo = await git.resolve(record.checkout);
      const existingHead = await git.head(record.checkout);
      if (actualRepo.commonDir !== currentRepo.commonDir || existingHead.branch !== ticket.key) throw new WorkflowError("Saved worktree no longer matches this repository/ticket. Inspect before recovery.");
      if (!["dispatched", "submitting"].includes(record.phase) && existingHead.sha !== record.baseSha) throw new WorkflowError("The partial launch's branch moved from its recorded base. Inspect it; no instructions were submitted.");
      const workspaces = await herdr.workspaces();
      const paths = await Promise.all(workspaces.map(async workspace => ({ workspace, path: workspace.worktree ? await realpath(workspace.worktree.checkout_path).catch(() => undefined) : undefined })));
      const matches = paths.filter(entry => entry.path === record!.checkout);
      if (matches.length > 1) throw new WorkflowError("Multiple Herdr workspaces point at this checkout. Inspect them before continuing.");
      const workspace = matches[0]?.workspace;
      if (workspace) {
        record.workspaceId = workspace.workspace_id;
      } else {
        // Reopen only the recorded and Git-verified checkout, never trust a recycled workspace ID.
        progress("Reopening the existing ticket worktree…");
        const opened = await herdr.open(currentRepo.checkout, record.checkout, ticket.key);
        record.workspaceId = opened.workspace.workspace_id;
        record.paneId = opened.root_pane.pane_id;
        record.terminalId = opened.root_pane.terminal_id;
        await state.save(key, record);
      }
      if (record.phase === "dispatched" || record.phase === "submitting") {
        const panes = await herdr.panes(record.workspaceId!);
        const livePane = panes.find(pane => pane.pane_id === record!.paneId && pane.workspace_id === record!.workspaceId && pane.terminal_id === record!.terminalId);
        const validPane = livePane && livePane.cwd && (await git.resolve(livePane.foreground_cwd ?? livePane.cwd)).checkout === record.checkout ? livePane : undefined;
        await state.save(key, record);
        return {
          workspaceId: record.workspaceId!, paneId: validPane?.pane_id, checkout: record.checkout,
          message: record.phase === "submitting"
            ? "Previous prompt delivery is uncertain. Inspect the workspace; the prompt will not be resent."
            : validPane?.agent === harness.kind
              ? "Opened the existing ticket workspace. No duplicate prompt was sent."
              : "Opened the existing ticket workspace. Pi is no longer in its recorded pane; start it manually if needed. Instructions were not resent.",
        };
      }
      if (record.harness !== harness.id) throw new WorkflowError("The existing workspace uses another harness. Inspect it before restarting.");
      if (!request.recover) throw new WorkflowError("The previous launch stopped before dispatch. Press Resume launch to inspect and continue it without creating another worktree.", true);
    } else {
      progress("Checking Pi and branch availability…");
      await (deps.preflight ?? (() => run(harness.executable, ["--version"]).then(() => {})))();
      if (await git.branchExists(currentRepo, ticket.key)) throw new WorkflowError(`Branch ${ticket.key} already exists but is not owned by this plugin. No branch or workspace was changed.`);
      progress("Fetching the latest default branch…");
      const base = await git.fetchBase(currentRepo, config);
      record = { version: 1, repo: currentRepo.commonDir, ticket, harness: harness.id, socket: herdr.socket, branch: ticket.key, baseSha: base.sha, phase: "reserving", agentName: agentName(currentRepo.commonDir, ticket), updatedAt: new Date().toISOString() };
      await state.save(key, record);
      await git.reserveBranch(currentRepo, ticket.key, base.sha);
      record.phase = "reserved";
      await state.save(key, record);
      progress(`Creating worktree on ${ticket.key}…`);
      record.phase = "creating";
      await state.save(key, record);
      const created = await herdr.create(currentRepo.checkout, ticket.key, base.sha);
      record.checkout = await realpath(created.worktree.path);
      record.workspaceId = created.workspace.workspace_id;
      record.paneId = created.root_pane.pane_id;
      record.terminalId = created.root_pane.terminal_id;
      record.phase = "created";
      await state.save(key, record);
      const checkoutRepo = await git.resolve(record.checkout);
      const head = await git.head(record.checkout);
      if (checkoutRepo.commonDir !== currentRepo.commonDir || head.branch !== ticket.key || head.sha !== base.sha) throw new WorkflowError("Created checkout does not match the requested repository/branch/base. Preserved it for inspection; no agent was launched.");
    }
    if (!record.paneId || !record.terminalId) throw new WorkflowError("Saved root pane is missing. Inspect the workspace.");
    // Verify the actual pane occupant each time; IDs alone may be reused after restart.
    const pane = await herdr.pane(record.paneId);
    if (pane.workspace_id !== record.workspaceId || pane.terminal_id !== record.terminalId || !pane.cwd || (await git.resolve(pane.foreground_cwd ?? pane.cwd)).checkout !== record.checkout) throw new WorkflowError("The saved pane no longer matches the ticket checkout. Open the workspace and inspect it.");
    let agent: Agent;
    if (pane.agent) {
      agent = await herdr.agent(record.paneId);
      if (agent.agent !== harness.kind || agent.name !== record.agentName || agent.terminal_id !== record.terminalId) throw new WorkflowError("The ticket pane is occupied by another agent. No input was sent.");
      if (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status ?? "")) throw new WorkflowError("Pi is not ready for input. Open the workspace and resolve its startup/approval screen, then resume.", true);
    } else {
      if (record.phase === "ready" || record.phase === "starting") throw new WorkflowError("The previous Pi startup outcome is uncertain or Pi exited. Open the workspace and inspect it; the start command will not be repeated automatically.");
      progress("Starting Pi…");
      record.phase = "starting";
      await state.save(key, record);
      agent = await herdr.start(record.agentName, harness.kind, record.paneId, config.piArgs, config.startupTimeoutMs);
      if (agent.pane_id !== record.paneId || agent.terminal_id !== record.terminalId || agent.agent !== harness.kind || agent.name !== record.agentName || !agent.interactive_ready) throw new WorkflowError("Pi startup did not return the expected ready agent. Inspect before recovery.");
    }
    record.phase = "ready";
    await state.save(key, record);
    progress("Submitting ticket instructions…");
    record.phase = "submitting";
    await state.save(key, record); // write-ahead intent: failure is never an automatic resend
    await herdr.prompt(record.agentName, taskPrompt(ticket));
    record.phase = "dispatched";
    await state.save(key, record);
    return { workspaceId: record.workspaceId!, paneId: record.paneId, checkout: record.checkout!, message: "Ticket instructions submitted to Pi." };
  } catch (error) {
    if (record?.checkout && error instanceof Error && !(error instanceof WorkflowError && error.recoverable)) {
      throw new WorkflowError(`${error.message} Worktree preserved at ${record.checkout}. Open it in Herdr to inspect before retrying.`, record.phase === "created" || record.phase === "starting");
    }
    throw error;
  } finally { await release(); }
}
