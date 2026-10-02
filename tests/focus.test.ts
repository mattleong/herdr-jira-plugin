import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusWorkspace } from "../src/focus-workspace.js";
import type { Pane, Workspace } from "../src/herdr.js";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "jira-focus-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  const target = { workspaceId: "w2", checkout, paneId: "w2:p1" };
  const pane: Pane = { workspace_id: "w2", pane_id: "w2:p1", terminal_id: "term2", cwd: checkout };
  let workspaces: Workspace[] = [{ workspace_id: "w2", worktree: { checkout_path: checkout, repo_root: directory } }];
  let panes: Pane[] = [pane];
  let listError = false;
  const calls: Array<[string, string | undefined]> = [];
  const herdr = {
    workspaces: async () => workspaces,
    panes: async (workspace: string) => {
      assert.equal(workspace, target.workspaceId);
      if (listError) throw new Error("Herdr connection failed");
      return panes;
    },
    focus: async (workspace: string, id?: string) => { calls.push([workspace, id]); },
  };
  return { directory, target, herdr, calls, pane,
    setPanes: (value: Pane[]) => { panes = value; },
    setWorkspaces: (value: Workspace[]) => { workspaces = value; },
    failListing: () => { listError = true; },
  };
}
test("recovery focuses a verified workspace and its surviving saved pane", async t => {
  const f = await fixture(t);
  await focusWorkspace(f.target, f.herdr);
  assert.deepEqual(f.calls, [["w2", "w2:p1"]]);
});
test("recovery falls back to workspace-only focus for a missing or moved pane", async t => {
  for (const moved of [false, true]) {
    const f = await fixture(t);
    f.setPanes(moved ? [{ ...f.pane, workspace_id: "w9" }] : []);
    await focusWorkspace(f.target, f.herdr);
    assert.deepEqual(f.calls, [["w2", undefined]]);
  }
});
test("workspace-only recovery does not need a pane listing", async t => {
  const f = await fixture(t); f.failListing();
  await focusWorkspace({ ...f.target, paneId: undefined }, f.herdr);
  assert.deepEqual(f.calls, [["w2", undefined]]);
});
test("recovery validates canonical checkout paths before considering the pane", async t => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias");
  await symlink(f.target.checkout, alias);
  await focusWorkspace({ ...f.target, checkout: alias }, f.herdr);
  assert.deepEqual(f.calls, [["w2", "w2:p1"]]);
});
test("missing/recycled workspaces and inaccessible checkout paths never receive focus", async t => {
  for (const scenario of ["missing", "recycled", "no-provenance", "missing-checkout"]) {
    const f = await fixture(t);
    if (scenario === "missing") f.setWorkspaces([]);
    if (scenario === "no-provenance") f.setWorkspaces([{ workspace_id: "w2" }]);
    if (scenario === "recycled") f.setWorkspaces([{ workspace_id: "w2", worktree: { checkout_path: f.directory, repo_root: f.directory } }]);
    if (scenario === "missing-checkout") f.target.checkout = join(f.directory, "does-not-exist");
    await assert.rejects(focusWorkspace(f.target, f.herdr));
    assert.deepEqual(f.calls, []);
  }
});
test("pane-list failures are not misreported as a missing pane", async t => {
  const f = await fixture(t); f.failListing();
  await assert.rejects(focusWorkspace(f.target, f.herdr), /connection failed/);
  assert.deepEqual(f.calls, []);
});
