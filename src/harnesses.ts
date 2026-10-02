import { WorkflowError } from "./errors.js";

export const harnesses = [{ id: "pi", label: "Pi", kind: "pi", executable: "pi" }] as const;
export type HarnessId = typeof harnesses[number]["id"];
export function getHarness(id: string) {
  const harness = harnesses.find(item => item.id === id);
  if (!harness) throw new WorkflowError("Unsupported harness. Pi is the only available harness.");
  return harness;
}
