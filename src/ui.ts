import { harnesses } from "./harnesses.js";
import { basename } from "node:path";
import { cells, clip, inputViewport, pad, plain, wrap } from "./display.js";

export interface FormModel { ticket: string; cursor: number; focus: 0 | 1 | 2; expanded: boolean; harness: string; error: string; recover: boolean }
export type Key = { kind: "text" | "paste"; text: string } | { kind: "enter" | "space" | "escape" | "cancel" | "tab" | "backtab" | "up" | "down" | "left" | "right" | "home" | "end" | "backspace" | "delete" | "clear" | "open" };
export type FormEffect = "submit" | "cancel" | "open" | undefined;
export const initialModel = (): FormModel => ({ ticket: "", cursor: 0, focus: 0, expanded: false, harness: "pi", error: "", recover: false });
export function update(model: FormModel, key: Key): FormEffect {
  if (key.kind === "cancel") return "cancel";
  if (key.kind === "open") return "open";
  if (key.kind === "escape") {
    if (model.expanded) { model.expanded = false; return; }
    return "cancel";
  }
  if (key.kind === "tab" || key.kind === "backtab") {
    model.expanded = false;
    model.focus = ((model.focus + (key.kind === "tab" ? 1 : 2)) % 3) as 0 | 1 | 2;
    return;
  }
  if (key.kind === "paste" || key.kind === "text") {
    if (model.focus !== 0) return;
    const text = key.text.replace(/[\r\n]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (model.ticket.length + text.length > 2048) { model.error = "Ticket input is too long."; return; }
    model.ticket = model.ticket.slice(0, model.cursor) + text + model.ticket.slice(model.cursor);
    model.cursor += text.length; model.error = ""; model.recover = false;
    return;
  }
  if (key.kind === "enter" || key.kind === "space") {
    if (model.focus === 1) { model.expanded = !model.expanded; return; }
    if (key.kind === "enter") return "submit";
    return update(model, { kind: "text", text: " " });
  }
  if (model.focus === 1 && model.expanded && (key.kind === "up" || key.kind === "down")) {
    const selected = harnesses.findIndex(harness => harness.id === model.harness);
    const index = (selected + (key.kind === "down" ? 1 : harnesses.length - 1)) % harnesses.length;
    model.harness = harnesses[index]!.id;
    return;
  }
  if (model.focus !== 0) return;
  if (key.kind === "left") model.cursor = Math.max(0, model.cursor - 1);
  if (key.kind === "right") model.cursor = Math.min(model.ticket.length, model.cursor + 1);
  if (key.kind === "home") model.cursor = 0;
  if (key.kind === "end") model.cursor = model.ticket.length;
  if (key.kind === "clear") { model.ticket = ""; model.cursor = 0; model.recover = false; }
  if (key.kind === "backspace" && model.cursor > 0) {
    model.ticket = model.ticket.slice(0, model.cursor - 1) + model.ticket.slice(model.cursor); model.cursor--; model.recover = false;
  }
  if (key.kind === "delete") { model.ticket = model.ticket.slice(0, model.cursor) + model.ticket.slice(model.cursor + 1); model.recover = false; }
}
export interface RenderOptions {
  height?: number; color?: boolean; status?: string; busy?: boolean; canOpen?: boolean;
}
export interface FormFrame {
  text: string; cursor?: { row: number; column: number }; tooSmall: boolean;
}
export function renderFrame(model: FormModel, repository: string, width: number, options: RenderOptions = {}): FormFrame {
  const height = Math.max(0, Math.floor(options.height ?? 16));
  const columns = Math.max(0, Math.floor(width));
  // Leave the last terminal column untouched to avoid autowrap at the bottom edge.
  const available = Math.max(0, columns - 1);
  if (columns < 44 || height < 16) {
    const lines = ["Enlarge to 44 × 16 to use this form.", options.busy ? "Launching; please wait." : "Esc to cancel"].slice(0, height);
    return { text: lines.map(line => clip(line, available)).join("\r\n"), tooSmall: true };
  }
  const content = Math.min(64, available - 4);
  const left = 2;
  const margin = " ".repeat(left);
  const paint = (text: string, code: string) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const muted = (text: string) => paint(text, "38;5;245");
  const accent = (text: string) => paint(text, "38;5;111");
  const bold = (text: string) => paint(text, "1");
  const active = (focus: number) => !options.busy && model.focus === focus;
  const border = (text: string) => active(0) ? accent(text) : muted(text);
  const lines: string[] = [""];
  const row = (text = "") => lines.push(margin + text);
  row(muted("Repository  ") + bold(clip(basename(plain(repository)) || repository, content - 12)));
  row();
  row(active(0) ? accent("Jira ticket") : muted("Jira ticket"));
  row(border("┌" + "─".repeat(content - 2) + "┐"));
  const viewport = inputViewport(model.ticket, model.cursor, content - 4);
  const value = model.ticket ? pad(viewport.text, content - 4) : muted(pad("Paste a ticket ID or URL", content - 4));
  const inputRow = lines.length + 1; // ANSI coordinates are one-based.
  row(border("│") + " " + value + " " + border("│"));
  row(border("└" + "─".repeat(content - 2) + "┘"));
  row();
  const selected = harnesses.find(harness => harness.id === model.harness)?.label ?? "Unknown";
  const selectorWidth = content - 12;
  const selector = "[ " + pad(selected, selectorWidth - 6) + ` ${model.expanded ? "▴" : "▾"} ]`;
  row((active(1) ? accent("Harness     ") : muted("Harness     ")) + (active(1) ? accent(selector) : selector));
  row(model.expanded ? " ".repeat(12) + paint(pad(`  ✓ ${selected}`, selectorWidth), "48;5;237;38;5;111") : "");
  const label = options.busy ? "Working…" : model.recover ? "Resume launch →" : "Start work →";
  const button = `[ ${label} ]`;
  row(" ".repeat(Math.max(0, content - cells(button))) + (options.busy ? muted(button) : active(2) ? paint(button, "1;48;5;111;38;5;16") : accent(button)));
  row();
  const showRecovery = !!(model.error && options.canOpen && !options.busy);
  const feedback = options.status ?? model.error;
  const feedbackLines = wrap(feedback, content, Math.min(3, height - lines.length - (showRecovery ? 2 : 1)));
  for (const line of feedbackLines) row(options.status ? muted(line) : paint(line, "38;5;203"));
  if (showRecovery) row(muted("Ctrl+O open preserved workspace"));
  const hint = options.busy ? "Please wait — preparing your workspace."
    : model.expanded ? "↑↓ select · Enter confirm · Esc close"
      : active(1) ? "Tab next · Enter choose · Esc cancel"
        : `Tab next · Enter ${model.recover ? "resume" : "start"} · Esc cancel`;
  row(muted(clip(hint, content)));
  return {
    text: lines.join("\r\n"), tooSmall: false,
    cursor: active(0) ? { row: inputRow, column: left + 3 + viewport.caret } : undefined,
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
      "\x1b[3~":"delete","\x1b[Z":"backtab","\x1bOA":"up","\x1bOB":"down",
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
        // Ignore an unknown CSI/control sequence rather than injecting its contents into a ticket.
        if (/^\x1b\[[0-?]*[ -/]*$/.test(this.buffer)) {
          if (this.buffer.length > 128) this.buffer = ""; // Bound malformed sequences.
          return;
        }
        const unknown = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer);
        if (unknown) { this.buffer = this.buffer.slice(unknown[0].length); continue; }
        this.buffer = this.buffer.slice(1); this.emit({ kind: "escape" }); continue;
      }
      const char = this.buffer[0]!; this.buffer = this.buffer.slice(1);
      const controls: Record<string, Key["kind"]> = { "\r":"enter","\n":"enter","\t":"tab","\x03":"cancel","\x0f":"open","\x7f":"backspace","\b":"backspace","\x01":"home","\x05":"end","\x15":"clear"," ":"space" };
      if (controls[char]) this.emit({ kind: controls[char] } as Key);
      else if (char >= " " && char !== "\x7f") this.emit({ kind: "text", text: char });
    }
  }
}
