import { access, realpath, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { WorkflowError, SetupError, detailsOf, safeText } from "./errors.js";
import { validateBranch } from "./branch.js";
import { getHarness } from "./harnesses.js";
import type { Herdr, Agent } from "./herdr.js";
import type { Origin } from "./origin.js";
import { taskPrompt } from "./prompt.js";
import type { Git } from "./repository.js";
import { State, type RecordState } from "./state.js";
import { agentName, type Ticket } from "./ticket.js";
import { run } from "./process.js";
import { prepareDependencies } from "./dependencies.js";
import { activateEnvironment, verifyPiEnvironment } from "./environment.js";
import type { ActivateEnvironment, EnvironmentBinding, EnvironmentTarget, PrepareDependencies, SetupResult } from "./setup-types.js";

export interface LaunchRequest { origin: Origin; ticket: Ticket; branch?: string; harness: string; recover?: boolean; setupAction?: "retry" | "skip" }
export interface LaunchResult { workspaceId: string; paneId?: string; checkout: string; message: string }
export interface Dependencies {
  git: Git; herdr: Herdr; state: State; config: Config; progress?: (text: string, base?: string) => void; preflight?: () => Promise<void>;
  prepare?: PrepareDependencies; activate?: ActivateEnvironment; signal?: AbortSignal;
  verifyPiEnvironment?: typeof verifyPiEnvironment;
}
export async function launch(request: LaunchRequest, deps: Dependencies): Promise<LaunchResult> {
  const { git, herdr, state, config } = deps;
  const { origin, ticket } = request;
  const harness = getHarness(request.harness);
  const branch = validateBranch(request.branch ?? ticket.key);
  if (origin.socket !== herdr.socket) throw new WorkflowError("Origin belongs to a different Herdr server.");
  const currentRepo = await git.resolve(origin.repo.checkout);
  if (currentRepo.commonDir !== origin.repo.commonDir) throw new WorkflowError("The originating repository changed. Open the action again.");
  const key = state.key(currentRepo.commonDir, ticket);
  const release = await state.lock(key);
  let releaseBranch: (() => Promise<void>) | undefined;
  const progress = deps.progress ?? (() => {});
  let record: RecordState | undefined;
  try {
    record = await state.load(key);
    const resuming = !!record;
    if (!record && request.setupAction) throw new WorkflowError("Setup recovery requires a recorded setup failure; nothing was created.");
    if (record && (record.repo !== currentRepo.commonDir || record.ticket.site !== ticket.site || record.ticket.key !== ticket.key)) throw new WorkflowError("This ticket is tracked for a different repository or Jira site. Inspect the existing workspace.");
    if (record && record.branch !== branch) throw new WorkflowError(`This ticket already uses branch ${record.branch}. Select that branch to reopen it; the plugin will not rename it or create a second workspace.`);
    releaseBranch = await state.lock(state.branchKey(currentRepo.commonDir, branch));
    await git.validateBranch(currentRepo, branch);
    await state.assertBranchAvailable(currentRepo.commonDir, branch, key);
    if (record) {
      progress("Checking the saved worktree…", record.baseRef ? `${record.baseRef} (${record.baseSha.slice(0, 8)})` : undefined);
      if (record.socket !== herdr.socket) throw new WorkflowError("This ticket belongs to another Herdr session. Open that session instead of duplicating its workspace.");
      if (!record.checkout || !record.workspaceId) throw new WorkflowError("An earlier launch stopped before its workspace was recorded. Inspect the Git branch/worktrees and state file; automatic recreation is unsafe.");
      await access(record.checkout);
      const actualRepo = await git.resolve(record.checkout);
      const existingHead = await git.head(record.checkout);
      if (actualRepo.commonDir !== currentRepo.commonDir || existingHead.branch !== record.branch) throw new WorkflowError("Saved worktree no longer matches this repository/ticket. Inspect before recovery.");
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
        const opened = await herdr.open(currentRepo.checkout, record.checkout, record.branch);
        record.workspaceId = opened.workspace.workspace_id;
        record.paneId = opened.root_pane.pane_id;
        record.terminalId = opened.root_pane.terminal_id;
        await state.save(key, record);
      }
      if (record.phase === "dispatched" || record.phase === "submitting") {
        const panes = await herdr.panes(record.workspaceId!);
        const livePane = panes.find(pane => pane.pane_id === record!.paneId && pane.workspace_id === record!.workspaceId && pane.terminal_id === record!.terminalId);
        // The checkout/workspace is already verified. A stale pane cwd must not block opening it.
        const paneCwd = livePane?.foreground_cwd ?? livePane?.cwd;
        const paneRepo = paneCwd ? await git.resolve(paneCwd).catch(() => undefined) : undefined;
        const validPane = paneRepo?.checkout === record.checkout && paneRepo.commonDir === currentRepo.commonDir ? livePane : undefined;
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
    } else {
      progress("Checking Pi and branch availability…");
      await (deps.preflight ?? (() => run(harness.executable, ["--version"]).then(() => {})))();
      if (await git.branchExists(currentRepo, branch)) throw new WorkflowError(`Branch ${branch} already exists but is not owned by this plugin. No branch or workspace was changed.`);
      progress("1/5 Resolving the remote default branch…");
      const base = await git.fetchBase(currentRepo, config, ref => progress(`1/5 Fetching latest ${ref}…`, ref));
      record = { version: 1, repo: currentRepo.commonDir, ticket, harness: harness.id, socket: herdr.socket, branch, baseSha: base.sha, baseRef: `${base.remote}/${base.branch}`, phase: "reserving", agentName: agentName(currentRepo.commonDir, ticket), updatedAt: new Date().toISOString() };
      await state.save(key, record);
      await git.reserveBranch(currentRepo, branch, base.sha);
      record.phase = "reserved";
      await state.save(key, record);
      progress(`2/5 Creating worktree on ${branch}…`, `${record.baseRef} (${base.sha.slice(0, 8)})`);
      record.phase = "creating";
      await state.save(key, record);
      const created = await herdr.create(currentRepo.checkout, branch, base.sha);
      record.checkout = await realpath(created.worktree.path);
      record.workspaceId = created.workspace.workspace_id;
      record.paneId = created.root_pane.pane_id;
      record.terminalId = created.root_pane.terminal_id;
      record.phase = "created";
      await state.save(key, record);
      const checkoutRepo = await git.resolve(record.checkout);
      const head = await git.head(record.checkout);
      if (checkoutRepo.commonDir !== currentRepo.commonDir || head.branch !== branch || head.sha !== base.sha) throw new WorkflowError("Created checkout does not match the requested repository/branch/base. Preserved it for inspection; no agent was launched.");
    }
    if (!record.paneId || !record.terminalId || !record.checkout || !record.workspaceId) throw new WorkflowError("Saved root pane is missing. Inspect the workspace.");
    const saved = record;
    const environmentTarget = (venv: string): EnvironmentTarget => ({
      checkout: saved.checkout!, workspaceId: saved.workspaceId!, paneId: saved.paneId!, terminalId: saved.terminalId!,
      venv, stateDirectory: state.directory, timeoutMs: config.startupTimeoutMs,
    });
    // Check both Git identity and the actual occupant before and after running repository code.
    const validateIdentity = async () => {
      const actualRepo = await git.resolve(saved.checkout!);
      const head = await git.head(saved.checkout!);
      if (actualRepo.checkout !== saved.checkout || actualRepo.commonDir !== currentRepo.commonDir || head.branch !== saved.branch || head.sha !== saved.baseSha) throw new WorkflowError("The ticket checkout no longer matches its repository, branch or recorded base. Inspect it; no agent input was sent.");
      const pane = await herdr.pane(saved.paneId!);
      if (!pane || pane.pane_id !== saved.paneId || pane.workspace_id !== saved.workspaceId || pane.terminal_id !== saved.terminalId || !pane.cwd) throw new WorkflowError("The saved pane no longer matches the ticket checkout. Open the workspace and inspect it.");
      const paneRepo = await git.resolve(pane.foreground_cwd ?? pane.cwd);
      if (paneRepo.checkout !== saved.checkout || paneRepo.commonDir !== currentRepo.commonDir) throw new WorkflowError("The saved pane no longer matches the ticket checkout. Open the workspace and inspect it.");
      if (saved.phase === "created" && (pane.agent || (pane.agent_status && pane.agent_status !== "unknown"))) throw new WorkflowError("An agent already occupies the pane before setup/start. Inspect it; no dependencies or input were sent.");
      return pane;
    };
    let pane = await validateIdentity();
    if (!["created", "starting", "ready"].includes(record.phase)) throw new WorkflowError("The saved launch phase cannot safely continue. Inspect the workspace.");
    if (record.phase !== "created" && request.setupAction) throw new WorkflowError("Setup recovery is stale: Pi startup already began. Open the workspace; no setup, start or prompt was repeated.");
    if (record.setup?.stage === "activation" && record.setup.status !== "succeeded") throw new WorkflowError("The previous Python binding is incomplete or uncertain. Open the workspace for manual inspection; activation cannot be retried or skipped automatically.");
    const needsSetupChoice = record.phase === "created" && record.setup && ["running", "failed", "skipped"].includes(record.setup.status);
    const setupFailure = async (message: string, details = message): Promise<never> => {
      // Revalidate before authorizing Skip after detection/installation failure.
      await validateIdentity();
      const logPath = record!.setup?.logPath;
      const log = logPath ? await readFile(logPath, "utf8").catch(() => "") : "";
      throw new SetupError(message, `${details}${log ? `\n\n${log}` : ""}${logPath ? `\n\nSetup log: ${logPath}` : ""}\n\nWorktree preserved at ${record!.checkout}. Retry setup, open it to inspect, or explicitly Start Pi anyway.`);
    };
    if (needsSetupChoice && !request.setupAction) {
      if (record.setup!.status === "running") {
        record.setup = { status: "failed", summary: "Setup was interrupted; inspect any remaining installer processes before retrying.", logPath: record.setup!.logPath };
        await state.save(key, record);
      }
      await setupFailure("Dependency setup is incomplete. Retry setup, open the workspace, or explicitly Start Pi anyway.", record.setup!.summary);
    }
    if (resuming && !request.recover && !request.setupAction) throw new WorkflowError("The previous launch stopped before dispatch. Press Resume launch to inspect and continue it without creating another worktree.", true);
    if (record.phase === "created") {
      if (request.setupAction === "skip") {
        if (!record.setup || !["failed", "skipped"].includes(record.setup.status)) throw new WorkflowError("Start Pi anyway is available only after a recorded setup failure. Inspect or retry setup first.");
        record.setup = { status: "skipped", summary: "Dependency setup is incomplete; explicitly skipped for this launch. Verify the environment and dependencies before working.", logPath: record.setup.logPath };
        await state.save(key, record);
        progress("3/5 Setup skipped by explicit request; verify dependencies in Pi.");
      } else {
        if (request.setupAction === "retry" && !needsSetupChoice) throw new WorkflowError("Setup recovery no longer matches a recorded failure. Resume launch explicitly instead.");
        const logPath = resolve(state.directory, `setup-${key}-${randomUUID()}.log`);
        record.setup = { status: "running", stage: "dependencies", logPath };
        await state.save(key, record); // Write ahead, including for legacy created records.
        progress("3/5 Preparing repository dependencies…");
        let result!: SetupResult;
        try {
          deps.signal?.throwIfAborted();
          result = await (deps.prepare ?? prepareDependencies)({
            checkout: record.checkout, timeoutMs: config.setupTimeoutMs, config: config.repos[currentRepo.commonDir]?.setup,
            logPath, signal: deps.signal, progress: text => progress(`3/5 ${safeText(text)}`),
          });
        } catch (error) {
          record.setup = { status: "failed", stage: "dependencies", summary: "Dependency setup failed; inspect the private setup log for diagnostics.", logPath };
          await state.save(key, record);
          await setupFailure("Dependency setup failed. Retry setup or explicitly Start Pi anyway.", detailsOf(error));
        }
        pane = await validateIdentity();
        let binding: EnvironmentBinding | undefined;
        if (result.venv) {
          record.setup = { status: "running", stage: "activation", logPath };
          await state.save(key, record); // Binding failures never authorize installer Retry/Skip.
          progress("3/5 Preparing Pi's private Python environment binding…");
          try {
            deps.signal?.throwIfAborted();
            binding = await (deps.activate ?? (target => activateEnvironment(target, herdr)))(environmentTarget(result.venv));
            pane = await validateIdentity();
          } catch (error) {
            record.setup = { status: "failed", stage: "activation", summary: "Python binding is unverified; open the workspace for manual inspection.", logPath };
            await state.save(key, record);
            await validateIdentity();
            throw new WorkflowError("Python binding is unverified. Open the workspace; uncertain activation cannot be retried or bypassed automatically.", false, `${detailsOf(error)}\n\nSetup log: ${logPath}`);
          }
        }
        record.setup = { status: "succeeded", stage: result.venv ? "activation" : "dependencies", summary: safeText(result.summary), venv: result.venv, binding, logPath };
        await state.save(key, record);
      }
      pane = await validateIdentity();
      deps.signal?.throwIfAborted();
    }
    if (record.setup?.venv && !record.setup.binding) throw new WorkflowError("The recorded Python environment has no private Pi binding proof. Legacy disk-only activation cannot be upgraded under Pi; open the workspace for manual inspection.");
    let agent: Agent;
    if (pane.agent) {
      agent = await herdr.agent(record.paneId);
      if (agent.pane_id !== record.paneId || agent.workspace_id !== record.workspaceId || agent.agent !== harness.kind || agent.name !== record.agentName || agent.terminal_id !== record.terminalId) throw new WorkflowError("The ticket pane is occupied by another agent. No input was sent.");
      if (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status ?? "")) throw new WorkflowError("Pi is not ready for input. Open the workspace and resolve its startup/approval screen, then resume.", true);
    } else {
      if (record.phase === "ready" || record.phase === "starting") throw new WorkflowError("The previous Pi startup outcome is uncertain or Pi exited. Open the workspace and inspect it; the start command will not be repeated automatically.");
      progress(`4/5 Starting Pi on ${record.branch}…`);
      record.phase = "starting";
      await state.save(key, record);
      const args = [...config.piArgs, ...(record.setup?.binding ? ["--extension", record.setup.binding.extensionPath] : [])];
      agent = await herdr.start(record.agentName, harness.kind, record.paneId, args, config.startupTimeoutMs);
      if (agent.pane_id !== record.paneId || agent.workspace_id !== record.workspaceId || agent.terminal_id !== record.terminalId || agent.agent !== harness.kind || agent.name !== record.agentName || !agent.interactive_ready || !["idle", "done"].includes(agent.agent_status ?? "")) throw new WorkflowError("Pi startup did not return the expected ready agent. Inspect before recovery.");
    }
    if (record.setup?.venv) {
      try { await (deps.verifyPiEnvironment ?? verifyPiEnvironment)(environmentTarget(record.setup.venv), record.setup.binding!, herdr); }
      catch (error) { throw new WorkflowError("Pi's Python binding could not be verified. Open the workspace; no setup, second start or prompt was sent.", false, detailsOf(error)); }
    }
    await validateIdentity();
    record.phase = "ready";
    await state.save(key, record);
    progress(`5/5 Submitting ${ticket.key} instructions to Pi…`);
    record.phase = "submitting";
    await state.save(key, record); // write-ahead intent: failure is never an automatic resend
    await herdr.prompt(record.agentName, taskPrompt(ticket, record.setup));
    record.phase = "dispatched";
    await state.save(key, record);
    return { workspaceId: record.workspaceId!, paneId: record.paneId, checkout: record.checkout!, message: "Ticket instructions submitted to Pi." };
  } catch (error) {
    if (record?.checkout && error instanceof Error && !(error instanceof WorkflowError && error.recoverable)) {
      const recovery = `Worktree preserved at ${record.checkout}. Open it in Herdr to inspect before retrying.`;
      const canResume = (record.phase === "created" || record.phase === "starting") && !(record.setup?.stage === "activation" && record.setup.status !== "succeeded");
      throw new WorkflowError(`${error.message} ${recovery}`, canResume, `${detailsOf(error)}\n\n${recovery}`);
    }
    throw error;
  } finally {
    try { await releaseBranch?.(); } finally { await release(); }
  }
}
