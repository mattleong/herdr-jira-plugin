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
    .replace(/([?&](?:access_token|token|api_key|key|password|secret)=)[^\s&#]*/gi, "$1[redacted]");
}
export function safeText(value: string): string {
  return diagnosticText(value).replace(/[\r\n\t]/g, " ").slice(0, 1500);
}
