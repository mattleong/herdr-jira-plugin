import { createHash } from "node:crypto";
import { WorkflowError } from "./errors.js";

export interface Ticket { key: string; site: string; reference: string }
export function normalizeSite(value: string): string {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.hostname.toLowerCase();
  } catch { throw new WorkflowError("Jira site must be an HTTPS hostname, without credentials, a port, or a path."); }
}
export function parseTicket(input: string, defaultSite?: string): Ticket {
  const text = input.trim();
  if (!text || text.length > 2048 || /[\x00-\x20\x7f-\x9f]/.test(text)) throw new WorkflowError("Paste one Jira ticket key or HTTPS browse URL.");
  let key = text;
  let site = defaultSite ? normalizeSite(defaultSite) : "mcp-default";
  if (/^https?:/i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { throw new WorkflowError("Invalid Jira URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new WorkflowError("Use an HTTPS Jira URL without credentials or a port.");
    const match = /^\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!match) throw new WorkflowError("Use a Jira /browse/PROJECT-123 URL.");
    key = match[1]!;
    site = url.hostname.toLowerCase();
  }
  key = key.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key) || key.length > 100) throw new WorkflowError("Invalid Jira ticket ID; expected PROJECT-123.");
  return { key, site, reference: site === "mcp-default" ? key : `https://${site}/browse/${key}` };
}
export function hash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
export function agentName(repo: string, ticket: Ticket): string {
  return `jira-${ticket.key.toLowerCase().slice(0, 17)}-${hash(repo + "\0" + ticket.site + "\0" + ticket.key, 8)}`;
}
