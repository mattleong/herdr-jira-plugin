import { WorkflowError } from "./errors.js";

// Fast, local validation for the form. Git remains authoritative at the launch boundary.
export function branchError(branch: string): string | undefined {
  if (!branch) return "Enter a branch name.";
  if (Buffer.byteLength(branch, "utf8") > 240) return "Branch name must be at most 240 bytes.";
  if (branch === "HEAD" || branch === "@" || branch.startsWith("-") || branch.startsWith("refs/")) return "Use a branch name, not HEAD, @, an option, or a full ref.";
  if (/[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069~^:?*\[\\]/u.test(branch) || branch.includes("..") || branch.includes("@{")) return "Branch contains spaces or characters Git does not allow.";
  if (branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return "Branch path cannot contain empty, dot-prefixed, .lock, or dot-ending parts.";
  return undefined;
}
export function validateBranch(branch: string): string {
  const error = branchError(branch);
  if (error) throw new WorkflowError(error);
  return branch;
}
