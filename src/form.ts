import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { loadConfig, defaults } from "./config.js";
import { WorkflowError, SetupError, messageOf, detailsOf } from "./errors.js";
import { copyErrorDetails } from "./clipboard.js";
import { lookupSavedBranch, cancelSavedBranchLookup } from "./saved-branch.js";
import { Herdr } from "./herdr.js";
import { launch, type LaunchResult } from "./launch.js";
import { parseOrigin } from "./origin.js";
import { Git } from "./repository.js";
import { State } from "./state.js";
import { terminalScreen } from "./display.js";
import { startElapsed } from "./elapsed.js";
import { initialModel, InputDecoder, renderFrame, update, validateForm, type Key } from "./ui.js";

async function main(): Promise<void> {
const preview = process.argv.includes("--preview");
const smoke = process.env.HERDR_JIRA_SMOKE === "1";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("The Jira form needs a terminal. Invoke its Herdr action or run npm run preview.");
  process.exit(1);
}
const model = initialModel();
let busy = false;
let elapsed: ReturnType<typeof startElapsed> | undefined;
let status: string | undefined;
let base: string | undefined;
let copying = false;
let clipboardController: AbortController | undefined;
let launchController: AbortController | undefined;
let cleaned = false;
let escapeTimer: NodeJS.Timeout | undefined;
let existing: LaunchResult | undefined;
let tooSmall = false;
const terminalDecoder = new StringDecoder("utf8");
const herdr = preview ? undefined : new Herdr();
const origin = preview ? undefined : parseOrigin(process.env.HERDR_JIRA_ORIGIN, herdr!.socket);
const configDirectory = process.env.HERDR_PLUGIN_CONFIG_DIR;
const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR;
if (!preview && (!configDirectory || !stateDirectory)) throw new WorkflowError("Missing Herdr plugin config/state directories.");
const config = preview ? defaults : await loadConfig(configDirectory!);
model.defaultSite = config.defaultJiraSite;
const state = preview ? undefined : new State(stateDirectory!);

function draw(): void {
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const frame = renderFrame(model, origin?.repo.checkout ?? "/example/repository (preview only)", process.stdout.columns ?? 80, {
    height: process.stdout.rows ?? 24,
    color,
    status, base, busy, elapsedSeconds: elapsed?.seconds(), canOpen: !!existing,
  });
  tooSmall = frame.tooSmall;
  if (frame.detailsOffset !== undefined) model.detailsOffset = frame.detailsOffset;
  process.stdout.write(terminalScreen(frame.text, color));
  if (frame.cursor) process.stdout.write(`\x1b[${frame.cursor.row};${frame.cursor.column}H\x1b[?25h`);
}
function stopElapsed(): void { elapsed?.stop(); elapsed = undefined; }
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  stopElapsed();
  clipboardController?.abort(); // Synchronously kill an unacknowledged copy before process.exit drops timers.
  launchController?.abort(); // Kill the currently owned installer on terminal exit/signals.
  clearTimeout(escapeTimer);
  process.stdin.off("data", onData);
  process.stdout.off("resize", draw);
  process.stdin.setRawMode(false); process.stdin.pause();
  process.stdout.write("\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l");
}
function finish(result?: LaunchResult): void {
  cleanup();
  if (result && !preview) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./focus.js", import.meta.url)), String(process.pid), result.workspaceId, result.checkout, result.paneId ?? "", result.message], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {}); child.unref();
  }
  process.exit(0);
}
async function submit(skipSetup = false): Promise<void> {
  if (busy || cleaned || model.detailsOpen || (skipSetup && !model.setupRecovery)) return;
  const validation = validateForm(model);
  if (!validation.valid || !validation.ticket) { draw(); return; }
  const ticket = validation.ticket;
  if (preview) { status = `Preview only: ${ticket.key} · Branch: ${model.branch} · Pi. Nothing launched.`; draw(); return; }
  busy = true; // Synchronous admission: repeated Enter/Ctrl+S cannot start concurrent launches.
  elapsed = startElapsed(() => { if (!cleaned && busy) draw(); });
  const setupAction = skipSetup ? "skip" : model.setupRecovery ? "retry" : undefined;
  const recover = model.recover;
  launchController = new AbortController();
  existing = undefined; model.error = ""; model.errorDetails = ""; model.recover = false; model.setupRecovery = false;
  status = "Checking repository and branch…"; draw();
  const capturedInput = model.ticket, capturedBranch = model.branch, capturedHarness = model.harness;
  try {
    const result = await launch({ origin: origin!, ticket, branch: model.branch, harness: model.harness, recover, setupAction }, {
      git: new Git(), herdr: herdr!, state: state!, config, signal: launchController.signal,
      progress: (text, resolvedBase) => { status = text; if (resolvedBase) base = resolvedBase; if (!cleaned) draw(); },
    });
    finish(result);
  } catch (error) {
    stopElapsed();
    status = undefined; model.error = messageOf(error); model.errorDetails = detailsOf(error);
    model.recover = error instanceof WorkflowError && error.recoverable;
    model.setupRecovery = error instanceof SetupError;
    // A startup error must allow leaving the modal to answer Pi's login/trust/approval UI.
    const record = await state!.load(state!.key(origin!.repo.commonDir, ticket)).catch(() => undefined);
    if (record?.repo === origin!.repo.commonDir && record.ticket.key === ticket.key && record.ticket.site === ticket.site && record.workspaceId && record.checkout) existing = { workspaceId: record.workspaceId, paneId: record.paneId, checkout: record.checkout, message: model.error };
    if (model.ticket !== capturedInput || model.branch !== capturedBranch || model.harness !== capturedHarness) { model.recover = false; model.setupRecovery = false; }
    launchController = undefined;
    busy = false; if (!cleaned) draw();
  }
}
async function copyDetails(): Promise<void> {
  if (copying) return;
  copying = true;
  clipboardController = new AbortController();
  const details = model.errorDetails || model.error;
  model.notice = "Copying error details…"; draw();
  try {
    await copyErrorDetails(details, { signal: clipboardController.signal });
    if ((model.errorDetails || model.error) === details) model.notice = "Error details copied.";
  } catch {
    if ((model.errorDetails || model.error) === details) model.notice = "Copy failed: clipboard unavailable.";
  } finally { copying = false; clipboardController = undefined; if (!cleaned) draw(); }
}
function onKey(key: Key): void {
  if (smoke || busy) return; // Smoke is display-only; mutations cannot be interrupted safely.
  if (tooSmall) {
    if (key.kind === "escape" || key.kind === "cancel") finish();
    return; // Never submit a form whose fields/controls are hidden by the terminal size.
  }
  const previousTicket = model.ticket, previousBranch = model.branch, previousHarness = model.harness;
  const effect = update(model, key, busy);
  if (model.ticket !== previousTicket || model.branch !== previousBranch || model.harness !== previousHarness || key.kind === "reset_branch") { existing = undefined; status = undefined; base = undefined; }
  if (model.ticket === previousTicket && (model.branch !== previousBranch || key.kind === "reset_branch")) cancelSavedBranchLookup(model);
  if (model.ticket !== previousTicket && !preview) {
    void lookupSavedBranch(model, origin!.repo.commonDir, ticket => state!.load(state!.key(origin!.repo.commonDir, ticket))).then(() => { if (!cleaned) draw(); });
  }
  if (effect === "copy") { void copyDetails(); return; }
  if (effect === "cancel") return finish();
  if (effect === "open") { if (existing) finish(existing); return; }
  if (effect === "submit") { void submit(); return; }
  if (effect === "skip_setup") { void submit(true); return; }
  draw();
}
const input = new InputDecoder(onKey);
function onData(data: Buffer): void {
  clearTimeout(escapeTimer);
  input.feed(terminalDecoder.write(data));
  escapeTimer = setTimeout(() => input.flushEscape(), 60);
}
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
process.stdin.on("data", onData); process.stdout.on("resize", draw);
process.once("exit", cleanup);
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.once(signal, () => { cleanup(); process.exit(1); });
draw();
if (smoke) setTimeout(() => finish(), 800).unref();
}

try { await main(); }
catch (error) {
  const message = messageOf(error);
  console.error(message);
  try { await new Herdr().notify(message); } catch { /* Preserve stderr when no server is available. */ }
  process.exitCode = 1;
}
