import { harnesses } from "./harnesses.js";
import { nextGraphemeBoundary, previousGraphemeBoundary, snapGraphemeBoundary } from "./graphemes.js";
import { branchError } from "./branch.js";
import { messageOf } from "./errors.js";
import { parseTicket, type Ticket } from "./ticket.js";

export interface FormModel {
  ticket: string; cursor: number; branch: string; branchCursor: number; branchEdited: boolean;
  focus: 0 | 1 | 2 | 3; expanded: boolean; harness: string; defaultSite?: string;
  error: string; errorDetails: string; recover: boolean; setupRecovery: boolean; checkingSavedBranch: boolean;
  detailsOpen: boolean; detailsOffset: number; notice: string;
}
export type Key = { kind: "text" | "paste"; text: string } | { kind: "enter" | "space" | "escape" | "cancel" | "tab" | "backtab" | "up" | "down" | "left" | "right" | "home" | "end" | "backspace" | "delete" | "clear" | "open" | "details" | "copy" | "reset_branch" | "pageup" | "pagedown" | "skip_setup" };
export type FormEffect = "submit" | "skip_setup" | "cancel" | "open" | "copy" | undefined;
export const initialModel = (defaultSite?: string): FormModel => ({
  ticket: "", cursor: 0, branch: "", branchCursor: 0, branchEdited: false, defaultSite,
  focus: 0, expanded: false, harness: "pi", error: "", errorDetails: "", recover: false, setupRecovery: false,
  checkingSavedBranch: false, detailsOpen: false, detailsOffset: 0, notice: "",
});
export function validateForm(model: FormModel): { valid: boolean; ticket?: Ticket; ticketError?: string; branchError?: string } {
  let ticket: Ticket | undefined, ticketError: string | undefined;
  try { ticket = parseTicket(model.ticket, model.defaultSite); } catch (error) { ticketError = messageOf(error); }
  const invalidBranch = branchError(model.branch);
  return { ticket, ticketError, branchError: invalidBranch, valid: !!ticket && !invalidBranch && !model.checkingSavedBranch };
}
function syncBranch(model: FormModel): void {
  if (model.branchEdited) return;
  try { model.branch = parseTicket(model.ticket, model.defaultSite).key; } catch { model.branch = ""; }
  model.branchCursor = model.branch.length;
}
export function update(model: FormModel, key: Key, busy = false): FormEffect {
  if (busy) return;
  if (key.kind === "cancel") return "cancel";
  if (model.detailsOpen) {
    if (key.kind === "escape" || key.kind === "details") { model.detailsOpen = false; model.notice = ""; }
    if (key.kind === "copy") return "copy";
    if (key.kind === "up") model.detailsOffset = Math.max(0, model.detailsOffset - 1);
    if (key.kind === "down") model.detailsOffset++;
    if (key.kind === "pageup") model.detailsOffset = Math.max(0, model.detailsOffset - 8);
    if (key.kind === "pagedown") model.detailsOffset += 8;
    if (key.kind === "home") model.detailsOffset = 0;
    if (key.kind === "end") model.detailsOffset = Number.MAX_SAFE_INTEGER;
    return;
  }
  if (key.kind === "details" && (model.errorDetails || model.error)) {
    model.detailsOpen = true; model.detailsOffset = 0; model.notice = ""; model.expanded = false; return;
  }
  if (key.kind === "open") return "open";
  if (key.kind === "skip_setup") return model.setupRecovery && validateForm(model).valid ? "skip_setup" : undefined;
  if (key.kind === "escape") {
    if (model.expanded) { model.expanded = false; return; }
    return "cancel";
  }
  if (key.kind === "tab" || key.kind === "backtab") {
    model.expanded = false;
    model.focus = ((model.focus + (key.kind === "tab" ? 1 : 3)) % 4) as FormModel["focus"];
    return;
  }
  if (key.kind === "reset_branch" && model.focus === 1) {
    model.branchEdited = false; syncBranch(model); model.error = ""; model.errorDetails = ""; model.recover = false; model.setupRecovery = false; return;
  }
  if (key.kind === "enter" || key.kind === "space") {
    if (model.focus === 2) { model.expanded = !model.expanded; return; }
    if (key.kind === "enter") {
      const validation = validateForm(model);
      if (validation.valid) return "submit";
      if (!model.checkingSavedBranch) model.focus = validation.ticketError ? 0 : 1;
      return;
    }
    return update(model, { kind: "text", text: " " });
  }
  if (model.focus === 2 && model.expanded && (key.kind === "up" || key.kind === "down")) {
    const selected = harnesses.findIndex(harness => harness.id === model.harness);
    model.harness = harnesses[(selected + (key.kind === "down" ? 1 : harnesses.length - 1)) % harnesses.length]!.id;
    model.error = ""; model.errorDetails = ""; model.recover = false; model.setupRecovery = false;
    return;
  }
  if (model.focus !== 0 && model.focus !== 1) return;
  const isBranch = model.focus === 1;
  const original = isBranch ? model.branch : model.ticket;
  let text = original;
  let cursor = snapGraphemeBoundary(text, isBranch ? model.branchCursor : model.cursor);
  if (key.kind === "paste" || key.kind === "text") {
    const inserted = key.text.replace(/[\r\n]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (text.length + inserted.length > 2048) { model.error = "Input is too long."; model.errorDetails = model.error; model.recover = false; model.setupRecovery = false; return; }
    text = text.slice(0, cursor) + inserted + text.slice(cursor);
    cursor = snapGraphemeBoundary(text, cursor + inserted.length, "forward");
  }
  if (key.kind === "left") cursor = previousGraphemeBoundary(text, cursor);
  if (key.kind === "right") cursor = nextGraphemeBoundary(text, cursor);
  if (key.kind === "home") cursor = 0;
  if (key.kind === "end") cursor = text.length;
  if (key.kind === "clear") { text = ""; cursor = 0; }
  if (key.kind === "backspace" && cursor > 0) {
    const previous = previousGraphemeBoundary(text, cursor);
    text = text.slice(0, previous) + text.slice(cursor); cursor = snapGraphemeBoundary(text, previous);
  }
  if (key.kind === "delete") {
    text = text.slice(0, cursor) + text.slice(nextGraphemeBoundary(text, cursor)); cursor = snapGraphemeBoundary(text, cursor);
  }
  if (isBranch) { model.branch = text; model.branchCursor = cursor; }
  else { model.ticket = text; model.cursor = cursor; }
  if (text !== original) {
    model.error = ""; model.errorDetails = ""; model.recover = false; model.setupRecovery = false; model.notice = "";
    if (isBranch) model.branchEdited = true;
    else syncBranch(model);
  }
}
