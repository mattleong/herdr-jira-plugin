export const setupManagers = ["npm", "pnpm", "yarn", "bun", "uv", "poetry", "requirements", "go"] as const;
export type SetupManager = typeof setupManagers[number];

// User-owned per-repository overrides; never loaded from an executable checkout hook.
export interface SetupConfig {
  manager?: SetupManager | "auto" | "none";
  directory?: string; // checkout-relative project root; must remain inside the worktree
  python?: string; // installed interpreter executable or absolute path; never downloaded
  requirements?: string[]; // explicit checkout-relative requirements files, including dev files
}
export interface SetupResult {
  summary: string;
  venv?: string; // verified canonical project-local virtual environment, if applicable
}
export interface SetupRequest {
  checkout: string;
  timeoutMs: number;
  config?: SetupConfig;
  logPath: string; // unique private per-attempt log owned by this launch
  progress?: (text: string) => void;
  signal?: AbortSignal;
}
export type PrepareDependencies = (request: SetupRequest) => Promise<SetupResult>;

export type SetupState = {
  status: "running" | "failed" | "succeeded" | "skipped";
  stage?: "dependencies" | "activation"; // uncertain Pi binding is never installer retry/skip permission
  summary?: string;
  venv?: string;
  binding?: EnvironmentBinding;
  logPath?: string;
};
export interface EnvironmentTarget {
  checkout: string;
  workspaceId: string;
  paneId: string;
  terminalId: string;
  venv: string;
  stateDirectory: string;
  timeoutMs: number;
}
export interface EnvironmentBinding {
  version: 1;
  extensionPath: string;
  proofPath: string;
  nonce: string;
  shellPid: number;
}
export type ActivateEnvironment = (target: EnvironmentTarget) => Promise<EnvironmentBinding>;
