import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { loadConfig, defaults } from "./config.js";
import { WorkflowError, messageOf } from "./errors.js";
import { Herdr } from "./herdr.js";
import { launch, type LaunchResult } from "./launch.js";
import { parseOrigin } from "./origin.js";
import { Git } from "./repository.js";
import { State } from "./state.js";
import { parseTicket } from "./ticket.js";
import { initialModel, InputDecoder, renderFrame, update, type Key } from "./ui.js";

async function main(): Promise<void> {
const preview = process.argv.includes("--preview");
const smoke = process.env.HERDR_JIRA_SMOKE === "1";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("The Jira form needs a terminal. Invoke its Herdr action or run npm run preview.");
  process.exit(1);
}
const model = initialModel();
let busy = false;
let status: string | undefined;
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
const state = preview ? undefined : new State(stateDirectory!);

function draw(): void {
  const frame = renderFrame(model, origin?.repo.checkout ?? "/example/repository (preview only)", process.stdout.columns ?? 80, {
    height: process.stdout.rows ?? 24,
    color: process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
    status, busy, canOpen: !!existing,
  });
  tooSmall = frame.tooSmall;
  process.stdout.write("\x1b[?25l\x1b[H\x1b[2J" + frame.text);
  if (frame.cursor) process.stdout.write(`\x1b[${frame.cursor.row};${frame.cursor.column}H\x1b[?25h`);
}
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  clearTimeout(escapeTimer);
  process.stdin.off("data", onData);
  process.stdout.off("resize", draw);
  process.stdin.setRawMode(false); process.stdin.pause();
  process.stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
}
function finish(result?: LaunchResult): void {
  cleanup();
  if (result && !preview) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./focus.js", import.meta.url)), String(process.pid), result.workspaceId, result.checkout, result.paneId ?? "", result.message], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {}); child.unref();
  }
  process.exit(0);
}
async function submit(): Promise<void> {
  let ticket;
  try { ticket = parseTicket(model.ticket, config.defaultJiraSite); }
  catch (error) { model.error = messageOf(error); draw(); return; }
  if (preview) { status = `Preview only: ${ticket.key}, Harness: Pi. No worktree or agent created.`; draw(); return; }
  busy = true; existing = undefined;
  const capturedInput = model.ticket;
  try {
    const result = await launch({ origin: origin!, ticket, harness: model.harness, recover: model.recover }, {
      git: new Git(), herdr: herdr!, state: state!, config,
      progress: text => { status = text; draw(); },
    });
    finish(result);
  } catch (error) {
    status = undefined; model.error = messageOf(error);
    model.recover = error instanceof WorkflowError && error.recoverable;
    // A startup error must allow leaving the modal to answer Pi's login/trust/approval UI.
    const record = await state!.load(state!.key(origin!.repo.commonDir, ticket)).catch(() => undefined);
    if (record?.workspaceId && record.checkout) existing = { workspaceId: record.workspaceId, paneId: record.paneId, checkout: record.checkout, message: model.error };
    if (model.ticket !== capturedInput) model.recover = false;
    busy = false; draw();
  }
}
function onKey(key: Key): void {
  if (smoke || busy) return; // Smoke is display-only; mutations cannot be interrupted safely.
  if (tooSmall) {
    if (key.kind === "escape" || key.kind === "cancel") finish();
    return; // Never submit a form whose fields/controls are hidden by the terminal size.
  }
  const previousTicket = model.ticket;
  const effect = update(model, key);
  if (model.ticket !== previousTicket) { existing = undefined; model.error = ""; status = undefined; }
  if (effect === "cancel") return finish();
  if (effect === "open") { if (existing) finish(existing); return; }
  if (effect === "submit") { void submit(); return; }
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
