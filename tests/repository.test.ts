import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.js";
import { Git } from "../src/repository.js";
import { defaults } from "../src/config.js";

export async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jira git ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), source = join(root, "source repo");
  const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args])).trim();
  await run("git", ["init", "--bare", "--initial-branch=trunk", remote]);
  await run("git", ["init", "--initial-branch=trunk", source]);
  await git(source, "config", "user.name", "Test"); await git(source, "config", "user.email", "test@example.test");
  await writeFile(join(source, "file.txt"), "first\n");
  await git(source, "add", "."); await git(source, "commit", "-m", "first");
  await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "trunk");
  return { root, remote, source, git };
}
test("fetches latest remote default commit without changing a dirty active branch", async t => {
  const f = await fixture(t);
  const publisher = join(f.root, "publisher");
  await run("git", ["clone", f.remote, publisher]);
  await f.git(publisher, "config", "user.name", "Test"); await f.git(publisher, "config", "user.email", "test@example.test");
  await writeFile(join(publisher, "file.txt"), "latest\n");
  await f.git(publisher, "commit", "-am", "latest"); await f.git(publisher, "push");
  const latest = await f.git(publisher, "rev-parse", "HEAD");
  await f.git(f.source, "switch", "-c", "feature");
  const original = await f.git(f.source, "rev-parse", "HEAD");
  await writeFile(join(f.source, "file.txt"), "dirty\n");
  await mkdir(join(f.source, "subfolder"));
  const git = new Git(), repo = await git.resolve(join(f.source, "subfolder"));
  const resolved: string[] = [];
  const base = await git.fetchBase(repo, defaults, ref => resolved.push(ref));
  assert.deepEqual(resolved, ["origin/trunk"]);
  assert.equal(base.branch, "trunk"); assert.equal(base.sha, latest);
  assert.equal((await git.head(f.source)).branch, "feature");
  assert.equal((await git.head(f.source)).sha, original);
  assert.equal(await readFile(join(f.source, "file.txt"), "utf8"), "dirty\n");
  await git.reserveBranch(repo, "MAIL-1", base.sha);
  assert.equal(await git.branchExists(repo, "MAIL-1"), true);
  await assert.rejects(git.reserveBranch(repo, "MAIL-1", original)); // compare-and-swap never resets
  assert.equal(await f.git(f.source, "rev-parse", "MAIL-1"), latest);
  const linked = join(f.root, "linked checkout");
  await f.git(f.source, "worktree", "add", linked, "MAIL-1");
  assert.equal((await git.resolve(linked)).commonDir, repo.commonDir);
  assert.equal(await git.worktreeFor(repo, "MAIL-1"), linked);
  assert.equal(await f.git(f.source, "for-each-ref", "refs/herdr-jira"), "");
});
test("missing remote/default and fetch failure do not create a ticket branch", async t => {
  const f = await fixture(t), git = new Git(), repo = await git.resolve(f.source);
  await assert.rejects(git.fetchBase(repo, { ...defaults, repos: { [repo.commonDir]: { remote: "missing" } } }), /missing/);
  await assert.rejects(git.fetchBase(repo, { ...defaults, repos: { [repo.commonDir]: { baseBranch: "deleted" } } }));
  assert.equal(await git.branchExists(repo, "MAIL-99"), false);
});
test("head returns the exact branch name even when a tag has the same name", async t => {
  const f = await fixture(t), git = new Git();
  for (const branch of ["MAIL-1", "heads/MAIL-2"]) {
    await f.git(f.source, "switch", "-c", branch);
    await f.git(f.source, "tag", branch);
    assert.equal((await git.head(f.source)).branch, branch);
    const linked = join(f.root, branch.replace("/", "-"));
    await f.git(f.source, "switch", "trunk");
    await f.git(f.source, "worktree", "add", linked, branch);
    assert.equal((await git.head(linked)).branch, branch);
  }
  await f.git(f.source, "switch", "--detach");
  await assert.rejects(git.head(f.source)); // Detached HEAD is still not a ticket branch.
});
test("Git validation accepts custom branch and rejects contextual expansion", async t => {
  const f = await fixture(t), git = new Git(), repo = await git.resolve(f.source);
  await git.validateBranch(repo, "feature/Mail-1");
  await f.git(f.source, "switch", "-c", "other"); await f.git(f.source, "switch", "trunk");
  await assert.rejects(git.validateBranch(repo, "@{-1}"), /literal branch name/);
  for (const branch of ["HEAD", "-bad", "bad name", "foo..bar"]) await assert.rejects(git.validateBranch(repo, branch));
  const sha = (await git.head(f.source)).sha;
  await git.reserveBranch(repo, "feature/Mail-1", sha);
  await assert.rejects(git.reserveBranch(repo, "feature/Mail-1", sha));
});

test("Git calls strip inherited repository selectors", async () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/wrong/repo";
  try {
    const git = new Git(async (_binary, args, options) => {
      assert.equal(options?.env?.GIT_DIR, undefined);
      assert.equal(options?.env?.GIT_TERMINAL_PROMPT, "0");
      return args.includes("for-each-ref") ? "" : "";
    });
    assert.equal(await git.branchExists({ checkout: "/repo", commonDir: "/repo/.git" }, "MAIL-1"), false);
  } finally { previous === undefined ? delete process.env.GIT_DIR : process.env.GIT_DIR = previous; }
});
