import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { WorkflowError, detailsOf } from "./errors.js";
import { run, type Run } from "./process.js";

export interface Repository { checkout: string; commonDir: string }
export interface Base { remote: string; branch: string; sha: string }
export class Git {
  constructor(private readonly execute: Run = run) {}
  private async call(cwd: string, args: string[], timeout = 30_000): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const key of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|CONFIG.*)$/.test(key)) delete env[key];
    }
    return (await this.execute("git", ["-C", cwd, ...args], { timeout, env })).trim();
  }
  async resolve(cwd: string): Promise<Repository> {
    let checkout: string;
    let common: string;
    try {
      checkout = await this.call(cwd, ["rev-parse", "--show-toplevel"]);
      common = await this.call(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    } catch (error) { throw new WorkflowError("The originating pane is not in an accessible Git working tree.", false, detailsOf(error)); }
    return { checkout: await realpath(checkout), commonDir: await realpath(resolve(cwd, common)) };
  }
  async validateBranch(repo: Repository, branch: string): Promise<void> {
    const checked = await this.call(repo.checkout, ["check-ref-format", "--branch", branch]);
    if (checked !== branch) throw new WorkflowError("Use a literal branch name, not a contextual Git expression.");
  }
  async fetchBase(repo: Repository, config: Config, onResolved?: (ref: string) => void): Promise<Base> {
    const override = config.repos[repo.commonDir] ?? {};
    const remote = override.remote ?? "origin";
    const remotes = (await this.call(repo.checkout, ["remote"])).split("\n");
    if (!remotes.includes(remote)) throw new WorkflowError(`Remote '${remote}' is missing. Set this repo's remote in config.json.`);
    let branch = override.baseBranch;
    if (!branch) {
      const advertised = await this.call(repo.checkout, ["ls-remote", "--symref", remote, "HEAD"], config.fetchTimeoutMs);
      branch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(advertised)?.[1];
      if (!branch) throw new WorkflowError("The remote did not advertise a default branch. Set baseBranch in config.json.");
    }
    await this.call(repo.checkout, ["check-ref-format", `refs/heads/${branch}`]);
    onResolved?.(`${remote}/${branch}`);
    // FETCH_HEAD is shared across worktrees; use a private ref for this fetch and pin its SHA.
    const { randomUUID } = await import("node:crypto");
    const ref = `refs/herdr-jira/fetch/${randomUUID()}`;
    try {
      await this.call(repo.checkout, ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", remote, `refs/heads/${branch}:${ref}`], config.fetchTimeoutMs);
      const sha = await this.call(repo.checkout, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new WorkflowError("Git returned an invalid base commit.");
      return { remote, branch, sha };
    } finally {
      await this.call(repo.checkout, ["update-ref", "-d", ref]).catch(() => {});
    }
  }
  async branchExists(repo: Repository, branch: string): Promise<boolean> {
    // for-each-ref succeeds for an absent ref; command errors must not look like absence.
    return !!await this.call(repo.checkout, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
  }
  async reserveBranch(repo: Repository, branch: string, sha: string): Promise<void> {
    // Atomic create-only ref update prevents Herdr's existing-branch behavior from adopting unrelated work.
    await this.call(repo.checkout, ["update-ref", `refs/heads/${branch}`, sha, "0".repeat(sha.length)]);
  }
  async head(checkout: string): Promise<{ sha: string; branch: string }> {
    const sha = await this.call(checkout, ["rev-parse", "--verify", "HEAD"]);
    const ref = await this.call(checkout, ["symbolic-ref", "HEAD"]);
    const prefix = "refs/heads/";
    if (!ref.startsWith(prefix)) throw new WorkflowError("The checkout is not on a local branch.");
    // --short disambiguates against tags and can return heads/KEY instead of the actual name.
    return { sha, branch: ref.slice(prefix.length) };
  }
  async worktreeFor(repo: Repository, branch: string): Promise<string | undefined> {
    const output = await this.call(repo.checkout, ["worktree", "list", "--porcelain", "-z"]);
    let path: string | undefined;
    for (const field of output.split("\0")) {
      if (field.startsWith("worktree ")) path = field.slice(9);
      if (field === `branch refs/heads/${branch}`) return path;
    }
    return undefined;
  }
}
