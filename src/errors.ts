import { stripVTControlCharacters } from "node:util";

export class WorkflowError extends Error {
  readonly details: string;
  constructor(message: string, public readonly recoverable = false, details = message) {
    super(message);
    this.name = "WorkflowError";
    this.details = diagnosticText(details);
  }
}
// Only this error authorizes setup-specific Retry/Skip UI; generic launch recovery does not.
export class SetupError extends WorkflowError {
  constructor(message: string, details = message) {
    super(message, true, details);
    this.name = "SetupError";
  }
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function detailsOf(error: unknown): string {
  return diagnosticText(error instanceof WorkflowError ? error.details : messageOf(error));
}
// Preserve multiline diagnostics for inspection/copying, but not terminal controls or URL credentials.
export function diagnosticText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/https?:\/\/[^\s/@]+@/gi, match => match.replace(/\/\/.*@/, "//[redacted]@"))
    .replace(/([?&](?:access_token|token|api_key|key|password|secret)=)[^\s&#]*/gi, "$1[redacted]")
    .replace(/((?:authorization|password|_authToken|api[_-]?key|access[_-]?token)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s]+/gi, "$1[redacted]");
}
/** Short cause for the form and saved setup journal; full diagnostics stay separate. */
export function setupFailureMessage(error: unknown): string {
  const cause = diagnosticText(messageOf(error)).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
  const characters = Array.from(safeText(cause));
  return characters.length ? characters.slice(0, 239).join("") + (characters.length > 239 ? "…" : "") : "Dependency setup failed; see details.";
}
export function safeText(value: string): string {
  return diagnosticText(value).replace(/[\r\n\t]/g, " ").slice(0, 1500);
}
