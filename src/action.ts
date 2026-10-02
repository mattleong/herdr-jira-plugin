import { Herdr } from "./herdr.js";
import { Git } from "./repository.js";
import { captureOrigin } from "./origin.js";
import { messageOf } from "./errors.js";

try {
  const herdr = new Herdr();
  const origin = await captureOrigin(herdr, new Git(), process.env);
  await herdr.openForm(JSON.stringify(origin));
  console.log("Opened Start Jira ticket.");
} catch (error) {
  const message = messageOf(error);
  console.error(message);
  try { await new Herdr().notify(message); } catch { /* Keep the original error in the action log. */ }
  process.exitCode = 1;
}
