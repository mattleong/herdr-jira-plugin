import { harnesses } from "./harnesses.js";
import { basename } from "node:path";
import { cells, clip, inputViewport, pad, plain, wrap } from "./display.js";
import { validateForm, type FormModel, type Key } from "./form-model.js";
import { errorView } from "./error-view.js";
export { initialModel, update, validateForm, type FormModel, type Key, type FormEffect } from "./form-model.js";

export interface RenderOptions {
  height?: number; color?: boolean; status?: string; base?: string; busy?: boolean; canOpen?: boolean;
}
export interface FormFrame {
  text: string; cursor?: { row: number; column: number }; tooSmall: boolean; detailsOffset?: number;
}
export function renderFrame(model: FormModel, repository: string, width: number, options: RenderOptions = {}): FormFrame {
  const height = Math.max(0, Math.floor(options.height ?? 11));
  const columns = Math.max(0, Math.floor(width));
  // Leave the last terminal column untouched to avoid autowrap at the bottom edge.
  const available = Math.max(0, columns - 1);
  if (columns < 44 || height < 11) {
    const lines = ["Enlarge to 44 × 11 to use this form.", options.busy ? "Launching; please wait." : "Esc to cancel"].slice(0, height);
    return { text: lines.map(line => clip(line, available)).join("\r\n"), tooSmall: true };
  }
  if (model.detailsOpen && !options.busy) return errorView(model, columns, height, !!options.color);
  const content = Math.min(64, available - 4);
  const left = 2;
  const margin = " ".repeat(left);
  const paint = (text: string, code: string) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const muted = (text: string) => paint(text, "38;5;245");
  const accent = (text: string) => paint(text, "38;5;111");
  const bold = (text: string) => paint(text, "1");
  const active = (focus: number) => !options.busy && model.focus === focus;
  const border = (text: string) => active(0) ? accent(text) : muted(text);
  const lines: string[] = [];
  const row = (text = "") => lines.push(margin + text);
  row(muted("Repository  ") + bold(clip(basename(plain(repository)) || repository, content - 12)));
  row(options.base ? muted(clip("Base  " + options.base, content)) : "");
  const fieldTitle = "┌ Jira ticket ";
  row(border(fieldTitle + "─".repeat(content - cells(fieldTitle) - 1) + "┐"));
  const viewport = inputViewport(model.ticket, model.cursor, content - 4);
  const value = model.ticket ? pad(viewport.text, content - 4) : muted(pad("Paste a ticket ID or URL", content - 4));
  const inputRow = lines.length + 1;
  row(border("│") + " " + value + " " + border("│"));
  row(border("└" + "─".repeat(content - 2) + "┘"));

  const branchLabel = model.branchEdited ? "Branch* " : "Branch  ";
  const branchView = inputViewport(model.branch, model.branchCursor, content - 12);
  const branchValue = model.branch ? pad(branchView.text, content - 12) : muted(pad("Defaults to ticket ID", content - 12));
  const branchPaint = (text: string) => active(1) ? accent(text) : muted(text);
  const branchRow = lines.length + 1;
  row(branchPaint(branchLabel + "[ ") + branchValue + branchPaint(" ]"));
  row(model.setupRecovery && !options.busy ? accent(clip("Ctrl+S Start Pi anyway", content)) : "");

  const validation = validateForm(model);
  const enabled = validation.valid && !options.busy;
  const selected = harnesses.find(harness => harness.id === model.harness)?.label ?? "Unknown";
  const label = options.busy ? "Working…" : model.setupRecovery ? "Retry setup →" : model.recover ? "Resume launch →" : "Start work →";
  const button = `[ ${label} ]`;
  const harnessLabel = "Harness ";
  const selectorWidth = Math.min(14, content - cells(harnessLabel) - cells(button) - 2);
  const selector = "[ " + pad(selected, selectorWidth - 6) + ` ${model.expanded ? "▴" : "▾"} ]`;
  const gap = " ".repeat(content - cells(harnessLabel) - selectorWidth - cells(button));
  row((active(2) ? accent(harnessLabel + selector) : muted(harnessLabel) + selector)
    + gap + (!enabled ? muted(button) : active(3) ? paint(button, "1;48;5;111;38;5;16") : accent(button)));
  if (model.expanded) row(" ".repeat(cells(harnessLabel)) + paint(pad(`  ✓ ${selected}`, selectorWidth), "48;5;237;38;5;111"));
  const showRecovery = !!(options.canOpen && !options.busy);
  const validationMessage = model.ticket && validation.ticketError ? "Ticket: " + validation.ticketError
    : validation.ticket && validation.branchError ? "Branch: " + validation.branchError : "";
  const feedback = options.status ?? (model.error || (model.checkingSavedBranch ? "Checking saved ticket branch…" : validationMessage || (validation.ticket ? `Ready · ${validation.ticket.key}` : "Paste a ticket to begin.")));
  const feedbackLines = wrap(feedback, content, Math.min(2, height - lines.length - 1));
  const feedbackError = !options.status && !!(model.error || validationMessage);
  for (const line of feedbackLines) row(feedbackError ? paint(line, "38;5;203") : muted(line));
  const hint = options.busy ? "Please wait — preparing your workspace."
    : model.expanded ? "↑↓ select · Enter confirm · Esc close"
      : showRecovery ? "Ctrl+O open · Ctrl+D more · Esc cancel"
        : model.error ? "Ctrl+D details · Esc cancel"
          : active(1) ? "Ctrl+R default · Tab next · Esc cancel"
            : active(2) ? "Tab next · Enter choose · Esc cancel"
              : enabled ? `Tab next · Enter ${model.setupRecovery ? "retry" : model.recover ? "resume" : "start"} · Esc cancel` : "Tab next · Esc cancel";
  row(muted(clip(hint, content)));
  return {
    text: lines.join("\r\n"), tooSmall: false,
    cursor: active(0) ? { row: inputRow, column: left + 3 + viewport.caret }
      : active(1) ? { row: branchRow, column: left + cells(branchLabel) + 3 + branchView.caret } : undefined,
  };
}
export function render(model: FormModel, repository: string, width: number, status?: string): string {
  return renderFrame(model, repository, width, { status }).text;
}

// Stateful decoder handles escape sequences and bracketed paste split across arbitrary chunks.
export class InputDecoder {
  private buffer = "";
  private pasting = false;
  private paste = "";
  constructor(private readonly emit: (key: Key) => void) {}
  feed(text: string): void { this.buffer += text; this.consume(); }
  flushEscape(): void {
    if (!this.pasting && this.buffer === "\x1b") { this.buffer = ""; this.emit({ kind: "escape" }); }
  }
  private consume(): void {
    const sequences: Record<string, Key["kind"]> = {
      "\x1b[A":"up","\x1b[B":"down","\x1b[C":"right","\x1b[D":"left",
      "\x1b[H":"home","\x1b[F":"end","\x1b[1~":"home","\x1b[4~":"end",
      "\x1b[3~":"delete","\x1b[5~":"pageup","\x1b[6~":"pagedown","\x1b[Z":"backtab","\x1bOA":"up","\x1bOB":"down",
      "\x1bOC":"right","\x1bOD":"left","\x1bOH":"home","\x1bOF":"end",
    };
    while (this.buffer) {
      if (this.pasting) {
        const end = this.buffer.indexOf("\x1b[201~");
        if (end < 0) {
          // Keep a possible partial terminator for the next chunk.
          const keep = Math.min(5, this.buffer.length);
          this.paste = (this.paste + this.buffer.slice(0, -keep)).slice(0, 4096);
          this.buffer = this.buffer.slice(-keep); return;
        }
        this.paste = (this.paste + this.buffer.slice(0, end)).slice(0, 4096);
        this.buffer = this.buffer.slice(end + 6); this.pasting = false;
        this.emit({ kind: "paste", text: this.paste }); this.paste = ""; continue;
      }
      if (this.buffer.startsWith("\x1b[200~")) { this.buffer = this.buffer.slice(6); this.pasting = true; continue; }
      const sequence = Object.keys(sequences).find(seq => this.buffer.startsWith(seq));
      if (sequence) {
        this.buffer = this.buffer.slice(sequence.length);
        this.emit({ kind: sequences[sequence] } as Key); continue;
      }
      if (this.buffer[0] === "\x1b") {
        if (["\x1b[200~", ...Object.keys(sequences)].some(seq => seq.startsWith(this.buffer))) return;
        // Ignore unsupported CSI and SS3 (e.g. F1–F4) sequences, including fragmented input.
        if (/^\x1b(?:\[|O)[0-?]*[ -/]*$/.test(this.buffer)) {
          if (this.buffer.length > 128) this.buffer = ""; // Bound malformed sequences.
          return;
        }
        const unknown = /^\x1b(?:\[|O)[0-?]*[ -/]*[@-~]/.exec(this.buffer);
        if (unknown) { this.buffer = this.buffer.slice(unknown[0].length); continue; }
        this.buffer = this.buffer.slice(1); this.emit({ kind: "escape" }); continue;
      }
      // Insert a printable run atomically. Per-code-point edits can merge with existing suffix
      // graphemes and move the caret past them before the remainder of an IME/emoji arrives.
      let text = "";
      while (this.buffer) {
        const point = this.buffer.codePointAt(0)!;
        if (this.buffer.length === 1 && point >= 0xd800 && point <= 0xdbff) break;
        if (point <= 0x20 || point === 0x7f) break;
        text += point >= 0xd800 && point <= 0xdfff ? "\ufffd" : String.fromCodePoint(point);
        this.buffer = this.buffer.slice(point > 0xffff ? 2 : 1);
      }
      if (text) { this.emit({ kind: "text", text }); continue; }
      const point = this.buffer.codePointAt(0)!;
      if (this.buffer.length === 1 && point >= 0xd800 && point <= 0xdbff) return; // Incomplete surrogate pair.
      const char = this.buffer[0]!; this.buffer = this.buffer.slice(1);
      const controls: Record<string, Key["kind"]> = { "\r":"enter","\n":"enter","\t":"tab","\x03":"cancel","\x0f":"open","\x04":"details","\x19":"copy","\x12":"reset_branch","\x13":"skip_setup","\x7f":"backspace","\b":"backspace","\x01":"home","\x05":"end","\x15":"clear"," ":"space" };
      if (controls[char]) this.emit({ kind: controls[char] } as Key);
    }
  }
}
