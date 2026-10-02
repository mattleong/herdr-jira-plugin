import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, realpath, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, type Dependencies } from "../src/launch.js";
import { State } from "../src/state.js";
import { defaults } from "../src/config.js";
import { validateBranch } from "../src/branch.js";
import { WorkflowError, SetupError, detailsOf } from "../src/errors.js";
import { parseTicket } from "../src/ticket.js";
import type { Git } from "../src/repository.js";
import type { Herdr, Agent, Pane, Created } from "../src/herdr.js";
import type { Origin } from "../src/origin.js";
import type { EnvironmentBinding } from "../src/setup-types.js";

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jira-launch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "MAIL-1234"), commonDir = join(root, ".git"), outside = join(root, "outside");
  const calls: string[] = [], prompts: string[] = [], startArgs: string[][] = [];
  const binding: EnvironmentBinding = { version: 1, extensionPath: join(root, "state/pi-environment-test/extension.mjs"), proofPath: join(root, "state/pi-environment-test/proof.json"), nonce: "a".repeat(64), shellPid: 4242 };
  let exists = false, sha = "a".repeat(40), currentBranch = "MAIL-1234";
  let failFetch = false, failPrompt = false, blockStart = false;
  let pane: Pane = { pane_id: "w2:p1", workspace_id: "w2", terminal_id: "term2", cwd: checkout, agent_status: "unknown" };
  let agent: Agent | undefined;
  const git = {
    resolve: async (cwd: string) => {
      if (cwd === outside) throw new Error("Not a Git working tree");
      return { checkout: cwd, commonDir };
    },
    validateBranch: async (_repo: unknown, branch: string) => { validateBranch(branch); },
    branchExists: async () => exists,
    fetchBase: async (_repo: unknown, _config: unknown, onResolved?: (ref: string) => void) => { calls.push("fetch"); onResolved?.("origin/trunk"); if (failFetch) throw new Error("fetch failed"); return { remote: "origin", branch: "trunk", sha }; },
    reserveBranch: async (_repo: unknown, branch: string) => { calls.push("reserve:" + branch); assert.equal(exists, false); exists = true; currentBranch = branch; },
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
    start: async (name: string, _kind: string, _pane: string, args: string[]) => {
      calls.push("start"); startArgs.push(args); pane = { ...pane, agent: "pi" };
      const journal = await state.load(state.key(commonDir, ticket));
      if (args.includes("--extension")) assert.deepEqual(journal!.setup!.binding, binding);
      agent = { ...pane, name, interactive_ready: !blockStart, agent_status: blockStart ? "blocked" : "idle" };
      if (blockStart) throw new Error("agent_not_ready");
      return agent;
    },
    prompt: async (_name: string, text: string) => {
      calls.push("prompt"); prompts.push(text); assert.match(text, /MAIL-\d+/);
      if (failPrompt) throw new Error("timeout after writes");
    },
  } as unknown as Herdr;
  const state = new State(join(root, "state"));
  const origin: Origin = { repo: { checkout: root, commonDir }, paneId: "w1:p1", workspaceId: "w1", socket: herdr.socket };
  const ticket = parseTicket("MAIL-1234");
  const request = { origin, ticket, harness: "pi" };
  const deps: Dependencies = {
    git, herdr, state, config: defaults, preflight: async () => { calls.push("preflight"); },
    prepare: async () => { calls.push("prepare"); return { summary: "Fixture dependencies prepared." }; },
    activate: async () => { calls.push("activate"); return binding; }, verifyPiEnvironment: async () => { calls.push("verify-environment"); },
  };
  return { calls, prompts, startArgs, binding, checkout, commonDir, state, request, deps,
    setExists: () => { exists = true; },
    deleteBranch: () => { exists = false; },
    failFetch: () => { failFetch = true; },
    failPrompt: () => { failPrompt = true; },
    blockStart: () => { blockStart = true; },
    ready: () => { agent = { ...agent!, interactive_ready: true, agent_status: "idle" }; },
    closePane: () => { pane = undefined as unknown as Pane; },
    paneOutsideGit: () => { pane = { ...pane, foreground_cwd: outside }; },
    paneOtherCheckout: () => { pane = { ...pane, foreground_cwd: root }; },
    replaceTerminal: () => { pane = { ...pane, terminal_id: "unrelated-terminal" }; },
    changeBranch: () => { currentBranch = "OTHER-1"; },
    changeHead: () => { sha = "b".repeat(40); },
    occupyPane: () => { pane = { ...pane, agent: "pi" }; },
    clearAgent: () => { pane = { ...pane, agent: undefined }; agent = undefined; },
  };
}
test("new dispatch uses exact ticket branch, records harness, and duplicate invocation never prompts again", async t => {
  const f = await setup(t);
  const result = await launch(f.request, f.deps);
  assert.equal(result.workspaceId, "w2");
  assert.deepEqual(f.calls, ["preflight", "fetch", "reserve:MAIL-1234", "create:MAIL-1234", "prepare", "start", "prompt"]);
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
test("duplicate reopening ignores an outside-Git foreground cwd without using stale pane cwd", async t => {
  for (const uncertain of [false, true]) {
    const f = await setup(t);
    if (uncertain) { f.failPrompt(); await assert.rejects(launch(f.request, f.deps), /timeout/); }
    else await launch(f.request, f.deps);
    f.paneOutsideGit();
    const calls = [...f.calls];
    const result = await launch(f.request, f.deps);
    assert.equal(result.workspaceId, "w2"); assert.equal(result.paneId, undefined);
    if (uncertain) assert.match(result.message, /uncertain/);
    assert.deepEqual(f.calls, calls); // No create/open/start/prompt while reopening.
  }
});
test("duplicate reopening does not follow another checkout or a replaced terminal", async t => {
  for (const scenario of ["paneOtherCheckout", "replaceTerminal"] as const) {
    const f = await setup(t);
    await launch(f.request, f.deps); f[scenario]();
    const calls = [...f.calls];
    const result = await launch(f.request, f.deps);
    assert.equal(result.workspaceId, "w2"); assert.equal(result.paneId, undefined);
    assert.deepEqual(f.calls, calls);
  }
});
test("partial startup keeps strict pane cwd validation and never sends a prompt outside Git", async t => {
  const f = await setup(t); f.blockStart();
  await assert.rejects(launch(f.request, f.deps));
  f.ready(); f.paneOutsideGit();
  const calls = [...f.calls];
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), /Not a Git working tree/);
  assert.deepEqual(f.calls, calls);
  assert.equal(f.calls.filter(call => call === "prompt").length, 0);
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
test("custom branch is preserved through creation, state, reuse and ticket-based instructions", async t => {
  const f = await setup(t), request = { ...f.request, branch: "feature/Mail-1234" };
  await launch(request, f.deps);
  assert.ok(f.calls.includes("reserve:feature/Mail-1234"));
  assert.ok(f.calls.includes("create:feature/Mail-1234"));
  const record = await f.state.load(f.state.key(f.request.origin.repo.commonDir, f.request.ticket));
  assert.equal(record?.branch, request.branch); assert.equal(record?.ticket.key, "MAIL-1234");
  assert.equal(record?.baseRef, "origin/trunk");
  await launch(request, f.deps);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("a tracked ticket cannot silently change branch, including recovery and legacy records", async t => {
  for (const original of ["MAIL-1234", "feature/MAIL-1234"]) {
    const f = await setup(t); await launch({ ...f.request, branch: original }, f.deps);
    const calls = [...f.calls];
    for (const recover of [false, true]) await assert.rejects(launch({ ...f.request, branch: "other/branch", recover }, f.deps), /already uses branch/);
    assert.deepEqual(f.calls, calls);
    assert.equal((await f.state.load(f.state.key(f.request.origin.repo.commonDir, f.request.ticket)))?.branch, original);
  }
});
test("different tickets choosing one custom branch cannot create twice", async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([
    launch({ ...f.request, branch: "shared" }, f.deps),
    launch({ ...f.request, ticket: parseTicket("MAIL-9"), branch: "shared" }, f.deps),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("reserve:")).length, 1);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("same ticket choosing different custom branches cannot create twice", async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([
    launch({ ...f.request, branch: "first" }, f.deps),
    launch({ ...f.request, branch: "second" }, f.deps),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("create:")).length, 1);
});
test("durable ownership blocks another ticket after the Git ref is deleted", async t => {
  const f = await setup(t); await launch({ ...f.request, branch: "shared" }, f.deps);
  f.deleteBranch(); const calls = [...f.calls];
  await assert.rejects(launch({ ...f.request, ticket: parseTicket("MAIL-9"), branch: "shared" }, f.deps), /already tracked for MAIL-1234/);
  assert.deepEqual(f.calls, calls);
});
test("branch-lock admission failure releases the ticket lock", async t => {
  const f = await setup(t), repo = f.request.origin.repo.commonDir;
  const release = await f.state.lock(f.state.branchKey(repo, "shared"));
  await assert.rejects(launch({ ...f.request, branch: "shared" }, f.deps), /lock/);
  await (await f.state.lock(f.state.key(repo, f.request.ticket)))();
  await release();
  await launch({ ...f.request, branch: "shared" }, f.deps);
});
test("invalid branch is rejected before repository access, preflight, fetch or state reservation", async t => {
  const f = await setup(t);
  f.deps.git.resolve = async () => { assert.fail("must not access Git"); };
  for (const branch of ["", "-bad", "bad name", "foo..bar", "foo.lock", "HEAD", "@{-1}", "x\n"]) {
    await assert.rejects(launch({ ...f.request, branch }, f.deps), WorkflowError);
  }
  assert.deepEqual(f.calls, []);
});
test("launch reports all five phases and the resolved base before creation", async t => {
  const f = await setup(t), progress: { text: string; base?: string }[] = [];
  f.deps.progress = (text, base) => progress.push({ text, base });
  await launch(f.request, f.deps);
  assert.deepEqual(progress.filter(p => /^[1-5]\/5/.test(p.text)).map(p => p.text.slice(0, 3)), ["1/5", "1/5", "2/5", "3/5", "4/5", "5/5"]);
  assert.ok(progress.some(p => p.text.startsWith("1/5 Fetching latest origin/trunk") && p.base === "origin/trunk"));
  assert.ok(progress.some(p => p.text.startsWith("2/5") && p.base === "origin/trunk (aaaaaaaa)"));
});
test("preserved-worktree errors retain full subprocess diagnostics", async t => {
  const f = await setup(t), detail = "diagnostic\n".repeat(500) + "LAST DETAIL";
  f.deps.herdr.start = async () => { throw new WorkflowError("Short error", false, detail); };
  await assert.rejects(launch(f.request, f.deps), error => {
    assert.match(detailsOf(error), /LAST DETAIL/); assert.match(detailsOf(error), /Worktree preserved/); return true;
  });
});
async function failSetup(f: Awaited<ReturnType<typeof setup>>) {
  f.deps.prepare = async () => { f.calls.push("prepare"); throw new Error("installer failed"); };
  await assert.rejects(launch(f.request, f.deps), SetupError);
  const key = f.state.key(f.commonDir, f.request.ticket);
  return { key, record: (await f.state.load(key))! };
}
test("setup is write-ahead journaled, receives overrides/signal, and fails before start with complete private diagnostics", async t => {
  const f = await setup(t), controller = new AbortController();
  const setupConfig = { manager: "requirements" as const, requirements: ["requirements.txt", "requirements-dev.txt"] };
  f.deps.config = { ...defaults, setupTimeoutMs: 12345, repos: { [f.commonDir]: { setup: setupConfig } } };
  f.deps.signal = controller.signal;
  f.deps.prepare = async request => {
    f.calls.push("prepare");
    const record = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!;
    assert.equal(record.phase, "created"); assert.equal(record.setup?.status, "running");
    assert.equal(record.setup?.logPath, request.logPath); assert.equal(request.checkout, f.checkout);
    assert.equal(request.timeoutMs, 12345); assert.equal(request.config, setupConfig); assert.equal(request.signal, controller.signal);
    assert.equal(request.logPath.startsWith(f.state.directory + "/"), true);
    await writeFile(request.logPath, "LOG BEGIN\n" + "diagnostic\n".repeat(500) + "LOG END", { flag: "wx", mode: 0o600 });
    throw new WorkflowError("Install failed", false, "FULL SUBPROCESS DIAGNOSTIC");
  };
  await assert.rejects(launch(f.request, f.deps), error => {
    assert.ok(error instanceof SetupError); assert.equal(error.recoverable, true);
    assert.match(detailsOf(error), /FULL SUBPROCESS DIAGNOSTIC/); assert.match(detailsOf(error), /LOG END/); assert.match(detailsOf(error), /Setup log:/); return true;
  });
  const record = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!;
  assert.equal(record.phase, "created"); assert.equal(record.setup?.status, "failed");
  assert.equal((await stat(record.setup!.logPath!)).mode & 0o777, 0o600);
  assert.equal(f.calls.includes("start"), false); assert.equal(f.calls.includes("prompt"), false);
});
test("fresh and reopened setup failures show the sanitized cause while preserving full diagnostics", async t => {
  const f = await setup(t);
  const cause = "Python >=3.12 required; found 3.11.";
  f.deps.prepare = async () => { f.calls.push("prepare"); throw new WorkflowError(`\x1b[31m${cause}\x1b[0m\nAuthorization: Bearer PRIVATE_TEST_TOKEN`, false, "Detailed diagnosis\nFINAL DETAIL"); };
  await assert.rejects(launch(f.request, f.deps), error => {
    assert.ok(error instanceof SetupError); assert.equal(error.message, cause);
    assert.match(detailsOf(error), /FINAL DETAIL/); assert.doesNotMatch(detailsOf(error), /PRIVATE_TEST_TOKEN/); return true;
  });
  const saved = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!;
  assert.equal(saved.setup?.summary, cause);
  await assert.rejects(launch(f.request, f.deps), error => {
    assert.ok(error instanceof SetupError); assert.equal(error.message, cause); return true;
  });
  assert.equal(f.calls.filter(call => call === "prepare").length, 1);
  assert.equal(f.calls.includes("start"), false); assert.equal(f.calls.includes("prompt"), false);
});
test("generic resume cannot retry failed setup; explicit retry reruns only setup with a fresh log", async t => {
  const f = await setup(t), { record } = await failSetup(f);
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), SetupError);
  assert.equal(f.calls.filter(c => c === "prepare").length, 1);
  f.deps.prepare = async request => { f.calls.push("prepare"); assert.notEqual(request.logPath, record.setup!.logPath); return { summary: "Ready" }; };
  await launch({ ...f.request, setupAction: "retry" }, f.deps);
  assert.deepEqual(f.calls, ["preflight", "fetch", "reserve:MAIL-1234", "create:MAIL-1234", "prepare", "prepare", "start", "prompt"]);
});
test("explicit skip starts once without reinstall/activation and sends only a safe warning", async t => {
  const f = await setup(t); await failSetup(f);
  await launch({ ...f.request, setupAction: "skip" }, f.deps);
  assert.equal(f.calls.filter(c => c === "prepare").length, 1);
  assert.equal(f.calls.filter(c => c === "start").length, 1); assert.equal(f.calls.includes("activate"), false);
  assert.match(f.prompts[0]!, /dependency setup is incomplete/); assert.match(f.prompts[0]!, /Verify the environment/);
  assert.doesNotMatch(f.prompts[0]!, /installer failed|setup-.*\.log/);
  await launch({ ...f.request, setupAction: "skip" }, f.deps);
  assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("retry and skip racing share the ticket lock and cannot start twice", async t => {
  const f = await setup(t); await failSetup(f);
  f.deps.prepare = async () => { f.calls.push("prepare"); return { summary: "Ready" }; };
  const results = await Promise.allSettled([launch({ ...f.request, setupAction: "retry" }, f.deps), launch({ ...f.request, setupAction: "skip" }, f.deps)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(c => c === "start").length, 1); assert.equal(f.calls.filter(c => c === "prompt").length, 1);
});
test("stale setup actions never mutate starting, ready, submitting or dispatched launches", async t => {
  for (const phase of ["starting", "ready", "submitting", "dispatched"] as const) {
    const f = await setup(t); f.blockStart(); await assert.rejects(launch(f.request, f.deps)); f.ready();
    const key = f.state.key(f.commonDir, f.request.ticket), record = (await f.state.load(key))!;
    record.phase = phase; await f.state.save(key, record);
    const calls = [...f.calls];
    for (const setupAction of ["retry", "skip"] as const) {
      if (phase === "submitting" || phase === "dispatched") await launch({ ...f.request, recover: true, setupAction }, f.deps);
      else await assert.rejects(launch({ ...f.request, recover: true, setupAction }, f.deps), /stale/);
      assert.deepEqual(f.calls, calls);
    }
  }
});
test("identity mismatch before setup or skip never authorizes SetupError or installation", async t => {
  for (const mutate of ["replaceTerminal", "paneOutsideGit", "changeBranch", "changeHead", "occupyPane"] as const) {
    const f = await setup(t); await failSetup(f); f[mutate](); const calls = [...f.calls];
    for (const setupAction of [undefined, "retry", "skip"] as const) {
      await assert.rejects(launch({ ...f.request, recover: true, setupAction }, f.deps), error => {
        assert.ok(error instanceof WorkflowError); assert.ok(!(error instanceof SetupError)); return true;
      });
    }
    assert.deepEqual(f.calls, calls);
  }
});
test("installer identity changes fail closed after both success and failure", async t => {
  for (const fail of [false, true]) for (const mutate of ["replaceTerminal", "paneOtherCheckout", "changeBranch", "changeHead", "occupyPane"] as const) {
    const f = await setup(t);
    f.deps.prepare = async () => { f.calls.push("prepare"); f[mutate](); if (fail) throw new Error("setup failed too"); return { summary: "Ready" }; };
    await assert.rejects(launch(f.request, f.deps), error => { assert.ok(error instanceof WorkflowError); assert.ok(!(error instanceof SetupError)); return true; });
    assert.equal(f.calls.includes("start"), false); assert.equal(f.calls.includes("prompt"), false);
  }
});
test("saved successful and legacy created records require Resume and rerun setup rather than cache it", async t => {
  for (const legacy of [false, true]) {
    const f = await setup(t), { key, record } = await failSetup(f);
    record.setup = legacy ? undefined : { status: "succeeded", summary: "Old success" }; await f.state.save(key, record);
    await assert.rejects(launch(f.request, f.deps), /Resume launch/);
    assert.equal(f.calls.filter(c => c === "prepare").length, 1);
    f.deps.prepare = async () => { f.calls.push("prepare"); return { summary: "Fresh success" }; };
    await launch({ ...f.request, recover: true }, f.deps);
    assert.equal(f.calls.filter(c => c === "prepare").length, 2); assert.equal(f.calls.filter(c => c === "fetch").length, 1);
  }
});
test("legacy later phases never install and a matching ready agent can resume", async t => {
  for (const phase of ["starting", "ready", "submitting", "dispatched"] as const) {
    const f = await setup(t); f.blockStart(); await assert.rejects(launch(f.request, f.deps)); f.ready();
    const key = f.state.key(f.commonDir, f.request.ticket), record = (await f.state.load(key))!;
    record.setup = undefined; record.phase = phase; await f.state.save(key, record);
    f.deps.prepare = async () => { assert.fail("legacy startup must not run setup"); };
    await launch({ ...f.request, recover: true }, f.deps);
    assert.equal(f.calls.filter(c => c === "start").length, 1);
    assert.equal(f.calls.filter(c => c === "prompt").length, phase === "starting" || phase === "ready" ? 1 : 0);
  }
});
test("running or previously skipped created setup requires a fresh explicit decision", async t => {
  for (const status of ["running", "skipped"] as const) {
    const f = await setup(t), { key, record } = await failSetup(f);
    record.setup = { ...record.setup!, status }; await f.state.save(key, record);
    await assert.rejects(launch({ ...f.request, recover: true }, f.deps), SetupError);
    assert.equal(f.calls.includes("start"), false);
    f.deps.prepare = async () => { f.calls.push("prepare"); return { summary: "Ready" }; };
    await launch({ ...f.request, setupAction: "retry" }, f.deps);
    assert.equal(f.calls.filter(c => c === "prepare").length, 2);
  }
});
test("crash after explicit skip never grants persistent bypass permission", async t => {
  const f = await setup(t); await failSetup(f);
  const controller = new AbortController(); controller.abort(); f.deps.signal = controller.signal;
  await assert.rejects(launch({ ...f.request, setupAction: "skip" }, f.deps));
  assert.equal((await f.state.load(f.state.key(f.commonDir, f.request.ticket)))?.setup?.status, "skipped");
  f.deps.signal = undefined;
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), SetupError); assert.equal(f.calls.includes("start"), false);
  await launch({ ...f.request, setupAction: "skip" }, f.deps); assert.equal(f.calls.filter(c => c === "start").length, 1);
});
test("setup skip cannot be forged for fresh or successful-created records", async t => {
  const f = await setup(t);
  await assert.rejects(launch({ ...f.request, setupAction: "skip" }, f.deps), /recorded setup failure/); assert.equal(f.calls.length, 0);
  const { key, record } = await failSetup(f);
  record.setup = { status: "succeeded", summary: "Ready" }; await f.state.save(key, record);
  await assert.rejects(launch({ ...f.request, setupAction: "skip" }, f.deps), error => { assert.ok(!(error instanceof SetupError)); return true; });
  assert.equal(f.calls.includes("start"), false);
});
test("venv binding is journaled before Pi; startup recovery only reverifies its receipt", async t => {
  const f = await setup(t), venv = join(f.checkout, ".venv");
  f.deps.prepare = async () => { f.calls.push("prepare"); return { summary: "Python dependencies ready", venv }; };
  f.deps.activate = async target => {
    f.calls.push("activate");
    assert.deepEqual(target, { checkout: f.checkout, workspaceId: "w2", paneId: "w2:p1", terminalId: "term2", venv, stateDirectory: f.state.directory, timeoutMs: defaults.startupTimeoutMs });
    assert.equal(f.calls.includes("start"), false);
    const journal = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!.setup!;
    assert.equal(journal.status, "running"); assert.equal(journal.stage, "activation");
    return f.binding;
  };
  f.blockStart(); await assert.rejects(launch(f.request, f.deps), /agent_not_ready/); f.ready();
  f.deps.verifyPiEnvironment = async (target, binding, herdr) => { f.calls.push("verify-environment"); assert.equal(target.checkout, f.checkout); assert.equal(target.venv, venv); assert.deepEqual(binding, f.binding); assert.equal(herdr, f.deps.herdr); };
  await launch({ ...f.request, recover: true }, f.deps);
  assert.deepEqual(f.calls.slice(-5), ["prepare", "activate", "start", "verify-environment", "prompt"]);
  assert.match(f.prompts[0]!, /verified Python virtual environment/); assert.ok(f.prompts[0]!.includes(venv));
});
test("failed or interrupted binding preparation never offers Skip or retries automatically", async t => {
  for (const status of ["running", "failed"] as const) for (const changed of [false, true]) {
    const f = await setup(t); f.deps.prepare = async () => ({ summary: "Ready", venv: join(f.checkout, ".venv") });
    f.deps.activate = async () => { f.calls.push("activate"); if (changed) f.replaceTerminal(); throw new SetupError("shell not active"); };
    await assert.rejects(launch(f.request, f.deps), error => { assert.ok(!(error instanceof SetupError)); return true; });
    const key = f.state.key(f.commonDir, f.request.ticket), record = (await f.state.load(key))!;
    assert.equal(record.setup!.stage, "activation"); assert.equal(record.setup!.status, "failed");
    record.setup!.status = status; await f.state.save(key, record);
    for (const setupAction of [undefined, "skip", "retry"] as const) {
      await assert.rejects(launch({ ...f.request, recover: true, setupAction }, f.deps), error => { assert.ok(!(error instanceof SetupError)); return true; });
    }
    assert.equal(f.calls.includes("start"), false); assert.equal(f.calls.filter(c => c === "activate").length, 1);
  }
});
test("deleted venv during startup recovery blocks prompt without authorizing setup skip", async t => {
  const f = await setup(t); f.deps.prepare = async () => ({ summary: "Ready", venv: join(f.checkout, ".venv") });
  f.blockStart(); await assert.rejects(launch(f.request, f.deps)); f.ready();
  f.deps.verifyPiEnvironment = async () => { throw new SetupError("Venv disappeared"); };
  await assert.rejects(launch({ ...f.request, recover: true }, f.deps), error => { assert.ok(!(error instanceof SetupError)); assert.match(detailsOf(error), /Venv disappeared/); return true; });
  assert.equal(f.calls.includes("prompt"), false);
});
test("fresh Pi verifies binding before ready/submitting and appends only the internal extension argument", async t => {
  const f = await setup(t), piArgs = ["--model", "chosen-model"];
  f.deps.config = { ...defaults, piArgs };
  f.deps.prepare = async () => ({ summary: "Ready", venv: join(f.checkout, ".venv") });
  f.deps.verifyPiEnvironment = async (target, binding) => {
    f.calls.push("verify-environment");
    const record = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!;
    assert.equal(record.phase, "starting"); assert.deepEqual(record.setup!.binding, binding);
    assert.equal(target.paneId, "w2:p1"); assert.equal(f.prompts.length, 0);
  };
  await launch(f.request, f.deps);
  assert.deepEqual(f.startArgs, [[...piArgs, "--extension", f.binding.extensionPath]]);
  assert.deepEqual(f.deps.config.piArgs, piArgs);
  assert.deepEqual(f.calls.slice(-4), ["activate", "start", "verify-environment", "prompt"]);
});
test("bad or missing Pi receipt never prompts, restarts, installs, or offers dependency Skip", async t => {
  for (const problem of ["missing receipt", "wrong PID", "stale nonce", "unsafe receipt", "wrong pane"]) {
    const f = await setup(t);
    f.deps.prepare = async () => { f.calls.push("prepare"); return { summary: "Ready", venv: join(f.checkout, ".venv") }; };
    f.deps.verifyPiEnvironment = async () => { throw new SetupError(problem); };
    await assert.rejects(launch(f.request, f.deps), error => { assert.ok(!(error instanceof SetupError)); assert.ok(detailsOf(error).includes(problem)); return true; });
    const record = (await f.state.load(f.state.key(f.commonDir, f.request.ticket)))!;
    assert.equal(record.phase, "starting"); assert.deepEqual(record.setup!.binding, f.binding);
    for (const setupAction of [undefined, "skip", "retry"] as const) await assert.rejects(launch({ ...f.request, recover: true, setupAction }, f.deps), error => { assert.ok(!(error instanceof SetupError)); return true; });
    assert.equal(f.calls.filter(call => call === "start").length, 1);
    assert.equal(f.calls.filter(call => call === "prepare").length, 1);
    assert.equal(f.calls.filter(call => call === "activate").length, 1);
    assert.equal(f.prompts.length, 0);
  }
});
test("legacy starting/ready venv records without Pi binding fail closed, while later phases remain reopen-only", async t => {
  for (const phase of ["starting", "ready", "submitting", "dispatched"] as const) {
    const f = await setup(t);
    f.deps.prepare = async () => ({ summary: "Ready", venv: join(f.checkout, ".venv") });
    f.blockStart(); await assert.rejects(launch(f.request, f.deps)); f.ready();
    const key = f.state.key(f.commonDir, f.request.ticket), record = (await f.state.load(key))!;
    delete record.setup!.binding; record.phase = phase; await f.state.save(key, record);
    const calls = [...f.calls];
    if (phase === "starting" || phase === "ready") await assert.rejects(launch({ ...f.request, recover: true }, f.deps), /no private Pi binding proof/);
    else await launch({ ...f.request, recover: true }, f.deps);
    assert.deepEqual(f.calls, calls); assert.equal(f.prompts.length, 0);
  }
});
test("simultaneous identical launch is serialized by the ticket-ID lock", async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([launch(f.request, f.deps), launch(f.request, f.deps)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("create")).length, 1);
});
