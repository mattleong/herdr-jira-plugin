import { type FormModel, validateForm } from "./form-model.js";
import { detailsOf, messageOf } from "./errors.js";
import type { Ticket } from "./ticket.js";
import type { RecordState } from "./state.js";

const generations = new WeakMap<FormModel, number>();
export function cancelSavedBranchLookup(model: FormModel): void {
  generations.set(model, (generations.get(model) ?? 0) + 1);
  model.checkingSavedBranch = false;
}
// Populate a tracked ticket's immutable branch without racing later input or overwriting an edit.
export async function lookupSavedBranch(model: FormModel, repo: string, load: (ticket: Ticket) => Promise<RecordState | undefined>): Promise<void> {
  const generation = (generations.get(model) ?? 0) + 1;
  generations.set(model, generation);
  model.checkingSavedBranch = false;
  const { ticket } = validateForm(model);
  if (!ticket || model.branchEdited) return;
  const input = model.ticket;
  const current = () => generations.get(model) === generation && model.ticket === input && !model.branchEdited;
  model.checkingSavedBranch = true;
  try {
    const record = await load(ticket);
    if (current() && record?.repo === repo && record.ticket.key === ticket.key && record.ticket.site === ticket.site) {
      model.branch = record.branch; model.branchCursor = model.branch.length;
    }
  } catch (error) {
    if (current()) { model.error = messageOf(error); model.errorDetails = detailsOf(error); }
  } finally {
    if (generations.get(model) === generation) model.checkingSavedBranch = false;
  }
}
