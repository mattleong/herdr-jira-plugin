import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowError } from "./errors.js";
import { normalizeSite } from "./ticket.js";

export interface RepoConfig { remote?: string; baseBranch?: string }
export interface Config {
  defaultJiraSite?: string; piArgs: string[]; startupTimeoutMs: number;
  fetchTimeoutMs: number; repos: Record<string, RepoConfig>;
}
export const defaults: Config = { piArgs: [], startupTimeoutMs: 30_000, fetchTimeoutMs: 60_000, repos: {} };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parseConfig(value: unknown): Config {
  if (!object(value)) throw new WorkflowError("config.json must be an object.");
  const allowed = ["defaultJiraSite", "piArgs", "startupTimeoutMs", "fetchTimeoutMs", "repos"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new WorkflowError(`Unknown config option: ${key}.`);
  const result: Config = { ...defaults, repos: {} };
  if (value.defaultJiraSite !== undefined) {
    if (typeof value.defaultJiraSite !== "string") throw new WorkflowError("defaultJiraSite must be a hostname.");
    result.defaultJiraSite = normalizeSite(value.defaultJiraSite);
  }
  if (value.piArgs !== undefined) {
    if (!Array.isArray(value.piArgs) || !value.piArgs.every(arg => typeof arg === "string" && !/[\x00-\x1f\x7f]/.test(arg))) throw new WorkflowError("piArgs must be an array of strings without control characters.");
    // A narrow allowlist prevents positional prompts, headless modes, resume, or disabled extensions.
    const args = value.piArgs as string[];
    for (let i = 0; i < args.length; i++) {
      const option = args[i]!;
      if (!/^(--model|--provider|--thinking)$/.test(option) || !args[i + 1] || args[i + 1]!.startsWith("-")) throw new WorkflowError("piArgs supports only --model, --provider, and --thinking, each followed by a value.");
      i++;
    }
    if (args.includes("--provider") && !args.includes("--model")) throw new WorkflowError("--provider requires --model.");
    const thinking = args.indexOf("--thinking");
    if (thinking >= 0 && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args[thinking + 1]!)) throw new WorkflowError("Invalid --thinking level.");
    result.piArgs = args;
  }
  for (const key of ["startupTimeoutMs", "fetchTimeoutMs"] as const) {
    if (value[key] !== undefined) {
      const n = value[key];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 3001 || n > 300_000) throw new WorkflowError(`${key} must be 3001–300000 milliseconds.`);
      result[key] = n;
    }
  }
  if (value.repos !== undefined) {
    if (!object(value.repos)) throw new WorkflowError("repos must map canonical Git common-directory paths to configuration.");
    for (const [path, entry] of Object.entries(value.repos)) {
      if (!object(entry) || Object.keys(entry).some(key => !["remote", "baseBranch"].includes(key))) throw new WorkflowError(`Invalid repository config: ${path}.`);
      const repo: RepoConfig = {};
      for (const field of ["remote", "baseBranch"] as const) {
        if (entry[field] !== undefined) {
          if (typeof entry[field] !== "string" || !entry[field] || entry[field].startsWith("-") || /[\x00-\x20\x7f]/.test(entry[field])) throw new WorkflowError(`Invalid ${field} in repo config.`);
          repo[field] = entry[field];
        }
      }
      result.repos[path] = repo;
    }
  }
  return result;
}
export async function loadConfig(directory: string): Promise<Config> {
  try { return parseConfig(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults, repos: {} };
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("Cannot read config.json; check its JSON syntax and permissions.");
  }
}
