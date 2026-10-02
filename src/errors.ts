export class WorkflowError extends Error {
  constructor(message: string, public readonly recoverable = false) {
    super(message);
    this.name = "WorkflowError";
  }
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@").slice(0, 1500);
}
