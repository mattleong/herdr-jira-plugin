import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WorkflowError } from "./errors.js";
import { normalizeSite } from "./ticket.js";

import { setupManagers, type SetupConfig } from "./setup-types.js";
export type { SetupConfig } from "./setup-types.js";

export interface RepoConfig { remote?: string; baseBranch?: string; setup?: SetupConfig }
export interface Config {
  defaultJiraSite?: string; piArgs: string[]; startupTimeoutMs: number;
  fetchTimeoutMs: number; setupTimeoutMs: number; repos: Record<string, RepoConfig>;
}
export const defaults: Config = { piArgs: [], startupTimeoutMs: 30_000, fetchTimeoutMs: 60_000, setupTimeoutMs: 300_000, repos: {} };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const relativePath = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 4096
  && !isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !/[\\\x00-\x1f\x7f]/.test(value)
  && !value.startsWith("-") && !value.split("/").includes("..");
function parseSetup(value: unknown): SetupConfig {
  if (!object(value) || Object.keys(value).some(key => !["manager", "directory", "python", "requirements"].includes(key))) throw new WorkflowError("Invalid setup config; arbitrary setup commands are not supported.");
  const setup: SetupConfig = {};
  if (value.manager !== undefined) {
    if (typeof value.manager !== "string" || ![...setupManagers, "auto", "none"].includes(value.manager)) throw new WorkflowError("Invalid setup manager.");
    setup.manager = value.manager as SetupConfig["manager"];
  }
  if (value.directory !== undefined) {
    if (!relativePath(value.directory)) throw new WorkflowError("setup.directory must be a contained relative path.");
    setup.directory = value.directory;
  }
  if (value.python !== undefined) {
    if (typeof value.python !== "string" || !value.python || value.python.length > 4096 || value.python.startsWith("-") || /[\x00-\x1f\x7f]/.test(value.python)
      || (!isAbsolute(value.python) && !/^[A-Za-z0-9_+.-]+$/.test(value.python))) throw new WorkflowError("setup.python must be one installed executable name or absolute path, not a shell command.");
    setup.python = value.python;
  }
  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length === 0 || value.requirements.length > 64 || !value.requirements.every(relativePath)) throw new WorkflowError("setup.requirements must list contained checkout-relative paths.");
    setup.requirements = [...new Set(value.requirements as string[])];
  }
  return setup;
}
export function parseConfig(value: unknown): Config {
  if (!object(value)) throw new WorkflowError("config.json must be an object.");
  const allowed = ["defaultJiraSite", "piArgs", "startupTimeoutMs", "fetchTimeoutMs", "setupTimeoutMs", "repos"];
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
  for (const key of ["startupTimeoutMs", "fetchTimeoutMs", "setupTimeoutMs"] as const) {
    if (value[key] !== undefined) {
      const n = value[key];
      const maximum = key === "setupTimeoutMs" ? 1_800_000 : 300_000;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 3001 || n > maximum) throw new WorkflowError(`${key} must be 3001–${maximum} milliseconds.`);
      result[key] = n;
    }
  }
  if (value.repos !== undefined) {
    if (!object(value.repos)) throw new WorkflowError("repos must map canonical Git common-directory paths to configuration.");
    for (const [path, entry] of Object.entries(value.repos)) {
      if (!object(entry) || Object.keys(entry).some(key => !["remote", "baseBranch", "setup"].includes(key))) throw new WorkflowError(`Invalid repository config: ${path}.`);
      const repo: RepoConfig = {};
      for (const field of ["remote", "baseBranch"] as const) {
        if (entry[field] !== undefined) {
          if (typeof entry[field] !== "string" || !entry[field] || entry[field].startsWith("-") || /[\x00-\x20\x7f]/.test(entry[field])) throw new WorkflowError(`Invalid ${field} in repo config.`);
          repo[field] = entry[field];
        }
      }
      if (entry.setup !== undefined) repo.setup = parseSetup(entry.setup);
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
