import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, type Dependencies } from "../src/launch.js";
import { State } from "../src/state.js";
import { defaults } from "../src/config.js";
import { parseTicket } from "../src/ticket.js";
import type { Git } from "../src/repository.js";
import type { Herdr, Agent, Pane, Created } from "../src/herdr.js";
import type { Origin } from "../src/origin.js";

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jira-launch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "MAIL-1234"), commonDir = join(root, ".git");
  const calls: string[] = [];
  let exists = false, sha = "a".repeat(40), currentBranch = "MAIL-1234";
  let failFetch = false, failPrompt = false, blockStart = false;
  let pane: Pane = { pane_id: "w2:p1", workspace_id: "w2", terminal_id: "term2", cwd: checkout };
  let agent: Agent | undefined;
  const git = {
    resolve: async (cwd: string) => ({ checkout: cwd, commonDir }),
    branchExists: async () => exists,
    fetchBase: async () => { calls.push("fetch"); if (failFetch) throw new Error("fetch failed"); return { remote: "origin", branch: "trunk", sha }; },
    reserveBranch: async (_repo: unknown, branch: string) => { calls.push("reserve:" + branch); assert.equal(exists, false); exists = true; },
    head: async () => ({ branch: currentBranch, sha }),
  } as unknown as Git;
  let created: Created | undefined;
  const herdr = {
    socket: "/test/socket",
    create: async (_cwd: string, branch: string, base: string) => {
      calls.push("create:" + branch); assert.equal(base, sha); await mkdir(checkout);
      created = { workspace: { workspace_id: "w2", worktree: { checkout_path: checkout, repo_root: root } }, root_pane: pane, worktree: { path: checkout, branch } };
      return created;
    },
    workspaces: async () => created ? [created.workspace] : [],
    open: async () => { calls.push("open"); return created; },
    panes: async () => pane ? [pane] : [],
    pane: async () => pane,
    agent: async () => agent,
    start: async (name: string) => {
      calls.push("start"); pane = { ...pane, agent: "pi" };
      agent = { ...pane, name, interactive_ready: !blockStart, agent_status: blockStart ? "blocked" : "idle" };
      if (blockStart) throw new Error("agent_not_ready");
      return agent;
    },
    prompt: async (_name: string, text: string) => {
      calls.push("prompt"); assert.match(text, /MAIL-1234/);
      if (failPrompt) throw new Error("timeout after writes");
    },
  } as unknown as Herdr;
  const state = new State(join(root, "state"));
  const origin: Origin = { repo: { checkout: root, commonDir }, paneId: "w1:p1", workspaceId: "w1", socket: herdr.socket };
  const ticket = parseTicket("MAIL-1234");
  const request = { origin, ticket, harness: "pi" };
  const deps: Dependencies = { git, herdr, state, config: defaults, preflight: async () => { calls.push("preflight"); } };
  return { calls, state, request, deps,
    setExists: () => { exists = true; },
    failFetch: () => { failFetch = true; },
    failPrompt: () => { failPrompt = true; },
    blockStart: () => { blockStart = true; },
    ready: () => { agent = { ...agent!, interactive_ready: true, agent_status: "idle" }; },
    closePane: () => { pane = undefined as unknown as Pane; },
    changeBranch: () => { currentBranch = "OTHER-1"; },
    changeHead: () => { sha = "b".repeat(40); },
  };
}
test("new dispatch uses exact ticket branch, records harness, and duplicate invocation never prompts again", async t => {
  const f = await setup(t);
  const result = await launch(f.request, f.deps);
  assert.equal(result.workspaceId, "w2");
  assert.deepEqual(f.calls, ["preflight", "fetch", "reserve:MAIL-1234", "create:MAIL-1234", "start", "prompt"]);
  const saved = await f.state.load(f.state.key(f.request.origin.repo.commonDir, f.request.ticket));
  assert.equal(saved?.harness, "pi"); assert.equal(saved?.phase, "dispatched");
  const duplicate = await launch(f.request, f.deps);
  assert.match(duplicate.message, /existing/);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("duplicate dispatch with a closed pane still opens the verified workspace", async t => {
  const f = await setup(t);
  await launch(f.request, f.deps); f.closePane();
  const result = await launch(f.request, f.deps);
  assert.equal(result.workspaceId, "w2"); assert.equal(result.paneId, undefined);
  assert.match(result.message, /start it manually/);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("fetch failure creates no branch or workspace and unknown harness changes nothing", async t => {
  const f = await setup(t);
  await assert.rejects(launch({ ...f.request, harness: "claude" }, f.deps), /Unsupported/);
  assert.deepEqual(f.calls, []);
  f.failFetch(); await assert.rejects(launch(f.request, f.deps), /fetch failed/);
  assert.deepEqual(f.calls, ["preflight", "fetch"]);
});
test("existing unowned branch is a collision, not an automatic checkout", async t => {
  const f = await setup(t); f.setExists();
  await assert.rejects(launch(f.request, f.deps), /not owned/);
  assert.deepEqual(f.calls, ["preflight"]);
});
test("uncertain prompt is journaled and never automatically resent", async t => {
  const f = await setup(t); f.failPrompt();
  await assert.rejects(launch(f.request, f.deps), /timeout/);
  const record = await f.state.load(f.state.key(f.request.origin.repo.commonDir, f.request.ticket));
  assert.equal(record?.phase, "submitting");
  const result = await launch({ ...f.request, recover: true }, f.deps);
  assert.match(result.message, /uncertain/);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("blocked startup is preserved and explicitly resumed only once ready", async t => {
  const f = await setup(t); f.blockStart();
  await assert.rejects(launch(f.request, f.deps), /agent_not_ready/);
  await assert.rejects(launch(f.request, f.deps), /Resume launch/);
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), /not ready/);
  f.ready();
  await launch({ ...f.request, recover: true }, f.deps);
  assert.equal(f.calls.filter(c => c === "start").length, 1);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("same branch across different sites is rejected before mutation", async t => {
  const f = await setup(t); await launch(f.request, f.deps);
  await assert.rejects(launch({ ...f.request, ticket: parseTicket("https://other.test/browse/MAIL-1234") }, f.deps), /different repository or Jira site/);
  assert.equal(f.calls.filter(c => c.startsWith("create")).length, 1);
});
test("changed checkout branch is not trusted even when saved Herdr IDs match", async t => {
  const f = await setup(t); await launch(f.request, f.deps);
  f.changeBranch();
  await assert.rejects(launch(f.request, f.deps), /no longer matches/);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("partial launch with a moved base cannot dispatch", async t => {
  const f = await setup(t); f.blockStart();
  await assert.rejects(launch(f.request, f.deps));
  f.changeHead(); f.ready();
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), /branch moved/);
  assert.equal(f.calls.filter(c => c === "prompt").length, 0);
});
test("simultaneous identical launch is serialized by the ticket-ID lock", async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([launch(f.request, f.deps), launch(f.request, f.deps)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("create")).length, 1);
});
