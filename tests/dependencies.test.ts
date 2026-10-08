import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, devNull } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DependenciesInstaller } from "../src/dependencies.js";
import { run, type Run, type RunOptions } from "../src/process.js";
import { WorkflowError, detailsOf } from "../src/errors.js";
import type { SetupRequest } from "../src/setup-types.js";

type Call = { binary: string; args: string[]; options: RunOptions };
async function fixture(t: TestContext, files: Record<string, string | undefined> = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "herdr-setup-test-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const checkout = join(temp, "checkout");
  await mkdir(checkout);
  const put = async (name: string, text: string) => { const path = join(checkout, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  for (const [name, text] of Object.entries(files)) if (text !== undefined) await put(name, text);
  let counter = 0;
  const request = (values: Partial<SetupRequest> = {}): SetupRequest => ({ checkout, timeoutMs: 10_000, logPath: join(temp, `attempt-${++counter}.log`), ...values });
  return { temp, checkout, put, request };
}
const packageFiles = (manager = "npm", pkg: Record<string, unknown> = {}) => ({
  "package.json": JSON.stringify(pkg),
  [manager === "npm" ? "package-lock.json" : manager === "pnpm" ? "pnpm-lock.yaml" : manager === "yarn" ? "yarn.lock" : "bun.lock"]: manager === "yarn" ? "__metadata:\n  version: 8\n" : "{}",
});
async function createVenv(root: string) {
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "pyvenv.cfg"), "include-system-site-packages = false\n");
}
function fake(overrides: Record<string, string> = {}, hook?: (call: Call) => Promise<string | void> | string | void) {
  const calls: Call[] = [];
  const versions: Record<string, string> = { node: "v24.2.0", npm: "11.2.0", pnpm: "10.0.0", yarn: "4.6.0", bun: "1.3.0", uv: "uv 0.6.14", poetry: "Poetry (version 2.2.0)", ...overrides };
  const execute: Run = async (binary, args, options = {}) => {
    const call = { binary, args: [...args], options: { ...options, env: { ...options.env } } };
    calls.push(call);
    const result = await hook?.(call);
    if (typeof result === "string") return result;
    const root = options.cwd!;
    if (binary === "corepack" && args[1] === "--version") return overrides.corepackPnpm ?? args[0]!.slice("pnpm@".length).split("+")[0]!;
    if (args[0] === "--version") return versions[binary] ?? "1.0.0";
    if (binary === "go") return args[0] === "version" ? "go version go1.24.1 linux/amd64" : "";
    if (binary === "uv" && args[0] === "python") return "/installed/python3";
    if (args[0] === "-I" && args[1] === "-c") {
      const isVenv = binary.includes("/.venv/");
      const prefix = isVenv ? join(root, ".venv") : "/installed";
      return JSON.stringify({ version: overrides.python ?? "3.12.6", executable: isVenv ? binary : "/installed/python3", prefix, base_prefix: "/installed", paths: { purelib: join(prefix, "lib"), platlib: join(prefix, "lib"), scripts: join(prefix, "bin"), data: prefix } });
    }
    if (args.includes("venv") || binary === "uv" && args[0] === "sync") await createVenv(root);
    if (binary === "poetry" && args[0] === "env") return join(root, ".venv");
    return "installed successfully\n";
  };
  return { calls, execute, installer: new DependenciesInstaller(execute) };
}
function environment(t: TestContext, values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
const installs = (calls: Call[]) => calls.filter(call => ["ci", "install", "sync"].includes(call.args[call.binary === "corepack" ? 1 : 0]!) || call.args.includes("pip") && call.args.includes("install"));

test("empty roots and manager=none do not install; logs are exclusive/private", async t => {
  const f = await fixture(t), runner = fake(), request = f.request();
  assert.match((await runner.installer.prepare(request)).summary, /No recognized/);
  assert.equal(runner.calls.length, 0);
  assert.equal((await lstat(request.logPath)).mode & 0o777, 0o600);
  await assert.rejects(runner.installer.prepare(request), /EEXIST/);
  await f.put("package.json", "invalid json");
  assert.match((await runner.installer.prepare(f.request({ config: { manager: "none" } }))).summary, /disabled/);
});
test("a log symlink is never followed", async t => {
  const f = await fixture(t), victim = join(f.temp, "victim"), logPath = join(f.temp, "log");
  await writeFile(victim, "unchanged"); await symlink(victim, logPath);
  await assert.rejects(fake().installer.prepare(f.request({ logPath })), /EEXIST|ELOOP/);
  assert.equal(await readFile(victim, "utf8"), "unchanged");
});
test("npm pins strip integrity metadata; dev install ignores inherited production/omit and logs stdout/stderr", async t => {
  const f = await fixture(t, packageFiles("npm", { packageManager: "npm@11.2.0+sha512.abc", engines: { node: ">=22" }, devDependencies: { typescript: "*" } }));
  environment(t, { NODE_ENV: "production", NPM_CONFIG_OMIT: "dev", npm_config_only: "prod", npm_config_prefix: "/shared", COREPACK_ENABLE_NETWORK: "1", NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "true" });
  const runner = fake({}, call => {
    call.options.onOutput?.("visible stdout\n", "stdout");
    call.options.onOutput?.("\u001b[31mhttps://user:password@registry.test/path?token=secret\nAuthorization: Bearer token-secret\n", "stderr");
  });
  const progress: string[] = [], request = f.request({ progress: text => progress.push(text) });
  const result = await runner.installer.prepare(request);
  assert.match(result.summary, /including dev/);
  assert.deepEqual(installs(runner.calls)[0]?.args, ["ci", "--include=dev", "--prefix", f.checkout, "--global=false"]);
  for (const call of runner.calls) {
    const env = call.options.env!;
    assert.equal(env.NODE_ENV, "development"); assert.equal(env.npm_config_omit, ""); assert.equal(env.NPM_CONFIG_OMIT, undefined);
    assert.equal(env.COREPACK_ENABLE_NETWORK, "0"); assert.equal(env.COREPACK_ENABLE_AUTO_PIN, "0"); assert.equal(env.COREPACK_DEFAULT_TO_LATEST, "0");
    assert.equal(env.npm_config_manage_package_manager_versions, "false"); assert.equal(env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, undefined);
    assert.equal(env.npm_config_prefix, f.checkout); assert.equal(env.npm_config_only, "");
    assert.ok(call.options.timeout! <= request.timeoutMs);
  }
  assert.ok(progress.every(text => !/^\d+[\/.)]/.test(text)));
  const log = await readFile(request.logPath, "utf8");
  assert.match(log, /stdout:\nvisible stdout/); assert.match(log, /stderr:/); assert.match(log, /redacted/);
  assert.doesNotMatch(log, /user:password|token-secret|token=secret|\u001b/);
  assert.equal(await readFile(join(f.checkout, "package-lock.json"), "utf8"), "{}");
});
test("pnpm uses frozen/dev-inclusive install and parser-compatible config guards for both probe and install", async t => {
  const f = await fixture(t, packageFiles("pnpm", { packageManager: "pnpm@10.34.4" })), runner = fake({ pnpm: "10.34.4" });
  await runner.installer.prepare(f.request());
  const guards = ["--config.manage-package-manager-versions=false", "--config.pm-on-fail=ignore", "--config.use-node-version=", "--modules-dir=node_modules", "--virtual-store-dir=node_modules/.pnpm", `--lockfile-dir=${f.checkout}`];
  assert.deepEqual(runner.calls.filter(call => call.binary === "pnpm").map(call => call.args), [
    ["--version", ...guards],
    ["install", "--frozen-lockfile", "--prod=false", ...guards],
  ]);
  assert.ok(!runner.calls.some(call => call.binary === "corepack"));
});
test("pnpm mismatch selects the exact Corepack pin privately with guards and without changing project files", async t => {
  const pin = `pnpm@12.8.1+sha512.${"a".repeat(128)}`;
  const files = packageFiles("pnpm", { packageManager: pin.replace("a".repeat(128), "A".repeat(128)), engines: { pnpm: ">=12" } });
  const f = await fixture(t, { ...files, ".corepack.env": "COREPACK_ENABLE_AUTO_PIN=1\nCOREPACK_ENABLE_NETWORK=0\nCOREPACK_INTEGRITY_KEYS=0\n" });
  environment(t, { COREPACK_HOME: "/shared", COREPACK_ENABLE_DOWNLOAD_PROMPT: "1", COREPACK_ENABLE_AUTO_PIN: "1", COREPACK_DEFAULT_TO_LATEST: "1", COREPACK_ENV_FILE: "/outside", COREPACK_INTEGRITY_KEYS: "0" });
  const runner = fake({ pnpm: "10.34.4" }, async call => {
    if (call.binary === "corepack") assert.equal((await lstat(call.options.env!.COREPACK_HOME!)).mode & 0o777, 0o700);
  });
  const request = f.request(), result = await runner.installer.prepare(request);
  assert.match(result.summary, /including dev/);
  const wrapped = runner.calls.filter(call => call.binary === "corepack");
  const guards = ["--config.manage-package-manager-versions=false", "--config.pm-on-fail=ignore", "--config.use-node-version=", "--modules-dir=node_modules", "--virtual-store-dir=node_modules/.pnpm", `--lockfile-dir=${f.checkout}`];
  assert.deepEqual(wrapped.map(call => call.args), [[pin, "--version", ...guards], [pin, "install", "--frozen-lockfile", "--prod=false", ...guards]]);
  assert.deepEqual(wrapped.map(call => call.options.env?.COREPACK_ENABLE_NETWORK), ["1", "0"]);
  const cache = wrapped[0]!.options.env!.COREPACK_HOME!;
  assert.notEqual(cache, "/shared");
  for (const call of wrapped) {
    const env = call.options.env!;
    assert.equal(call.options.cwd, f.checkout); assert.ok(call.options.timeout! <= request.timeoutMs);
    assert.equal(env.COREPACK_HOME, cache);
    assert.equal(env.COREPACK_ENABLE_AUTO_PIN, "0"); assert.equal(env.COREPACK_DEFAULT_TO_LATEST, "0");
    assert.equal(env.COREPACK_ENABLE_PROJECT_SPEC, "0"); assert.equal(env.COREPACK_ENV_FILE, "0");
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0"); assert.equal(env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS, "0");
    assert.equal(env.COREPACK_INTEGRITY_KEYS, undefined);
  }
  assert.ok(wrapped[1]!.options.timeout! <= wrapped[0]!.options.timeout!);
  assert.equal(installs(runner.calls).length, 1);
  assert.equal(runner.calls.filter(call => call.binary === "pnpm").length, 1);
  await assert.rejects(lstat(cache), /ENOENT/);
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(join(f.checkout, name), "utf8"), content);
  assert.match(await readFile(request.logPath, "utf8"), /Selecting pnpm@12.8.1.*global pnpm is unchanged/);
});
test("missing pnpm or an unhydrated shim can use Corepack, but unpinned pnpm never downloads", async t => {
  for (const reason of ["spawn pnpm ENOENT", "Corepack network access disabled and no cached default"]) {
    const f = await fixture(t, packageFiles("pnpm", { packageManager: "pnpm@12.8.1" }));
    const runner = fake({}, call => { if (call.binary === "pnpm") throw new Error(reason); });
    await runner.installer.prepare(f.request());
    assert.equal(installs(runner.calls)[0]!.binary, "corepack");
    await f.put("package.json", "{}");
    const unpinned = fake({}, call => { if (call.binary === "pnpm") throw new Error(reason); });
    await assert.rejects(unpinned.installer.prepare(f.request()));
    assert.ok(!unpinned.calls.some(call => call.binary === "corepack"));
  }
});
test("Corepack selection failures preserve diagnostics, clean the cache, and never install with the wrong pnpm", async t => {
  for (const reason of ["spawn corepack ENOENT", "404 pinned release unavailable", "Signature does not match", "registry access denied"]) {
    const f = await fixture(t, packageFiles("pnpm", { packageManager: "pnpm@12.8.1" })), request = f.request();
    const runner = fake({}, call => {
      if (call.binary === "corepack") throw new WorkflowError(reason, false, `${reason}\nhttps://user:SECRET@registry.test/?token=SECRET`);
    });
    await assert.rejects(runner.installer.prepare(request), error => {
      assert.match(String(error), /Corepack is installed and up to date/);
      assert.ok(detailsOf(error).includes(reason)); assert.doesNotMatch(detailsOf(error), /SECRET/); return true;
    });
    assert.equal(installs(runner.calls).length, 0);
    const cache = runner.calls.find(call => call.binary === "corepack")!.options.env!.COREPACK_HOME!;
    await assert.rejects(lstat(cache), /ENOENT/);
    assert.ok((await readFile(request.logPath, "utf8")).includes(reason));
  }
  const f = await fixture(t, packageFiles("pnpm", { packageManager: "pnpm@12.8.1" })), runner = fake({ corepackPnpm: "12.8.0" });
  await assert.rejects(runner.installer.prepare(f.request()), /requires pnpm@12.8.1.*selected pnpm is 12.8.0/);
  assert.equal(installs(runner.calls).length, 0);
  await assert.rejects(lstat(runner.calls.find(call => call.binary === "corepack")!.options.env!.COREPACK_HOME!), /ENOENT/);
});
test("pnpm tags, ranges, URLs, invalid integrity and incompatible runtime/manager declarations fail before Corepack", async t => {
  for (const pkg of [
    ...["pnpm@latest", "pnpm@^12.8.1", "pnpm@https://example.test/pnpm.tgz", "pnpm@12.8.1+sha512.invalid", `pnpm@12.8.1+extra+sha512.${"a".repeat(128)}`].map(packageManager => ({ packageManager })),
    { packageManager: "pnpm@12.8.1", engines: { node: ">=30" } },
    { packageManager: "pnpm@12.8.1", engines: { pnpm: "<12" } },
    { packageManager: "pnpm@12.8.1", pnpm: { executionEnv: { nodeVersion: "18.0.0" } } },
  ]) {
    const f = await fixture(t, packageFiles("pnpm", pkg)), runner = fake();
    await assert.rejects(runner.installer.prepare(f.request()));
    assert.ok(!runner.calls.some(call => call.binary === "corepack")); assert.equal(installs(runner.calls).length, 0);
  }
});
test("pinned pnpm selection and install share the abort signal/deadline and clean caches on failures", async t => {
  for (const stage of ["direct-abort", "download-abort", "download-deadline", "install-failure"]) {
    const f = await fixture(t, packageFiles("pnpm", { packageManager: "pnpm@12.8.1" })), controller = new AbortController();
    const runner = fake({}, async call => {
      assert.equal(call.options.signal, controller.signal);
      if (stage === "direct-abort" && call.binary === "pnpm" || stage === "download-abort" && call.binary === "corepack") controller.abort();
      if (stage === "download-deadline" && call.binary === "corepack") await delay(call.options.timeout! + 10);
      if (stage === "install-failure" && call.args[1] === "install") throw new Error("dependency install failed");
    });
    await assert.rejects(runner.installer.prepare(f.request({ timeoutMs: stage === "download-deadline" ? 500 : 10_000, signal: controller.signal })), /aborted|timed out|dependency install failed/);
    const wrapped = runner.calls.filter(call => call.binary === "corepack");
    if (stage === "direct-abort") assert.equal(wrapped.length, 0);
    else {
      assert.equal(wrapped.length, stage === "install-failure" ? 2 : 1);
      await assert.rejects(lstat(wrapped[0]!.options.env!.COREPACK_HOME!), /ENOENT/);
    }
    assert.equal(installs(runner.calls).length, stage === "install-failure" ? 1 : 0);
  }
});
for (const [lock, version, args] of [["# yarn lockfile v1\n", "1.22.22", ["install", "--frozen-lockfile", "--production=false"]], ["__metadata:\n  version: 8\n", "4.6.0", ["install", "--immutable"]]] as const) {
  test(`Yarn ${version} gets generation-specific immutable/dev settings including probes`, async t => {
    const f = await fixture(t, { ...packageFiles("yarn"), "yarn.lock": lock }), runner = fake({ yarn: version });
    environment(t, { YARN_PRODUCTION: "true" });
    await runner.installer.prepare(f.request());
    assert.deepEqual(installs(runner.calls)[0]?.args, version.startsWith("1.") ? [...args, "--modules-folder", join(f.checkout, "node_modules"), "--cwd", f.checkout] : args);
    for (const call of runner.calls.filter(call => call.binary === "yarn")) assert.equal(call.options.env?.YARN_PRODUCTION, version.startsWith("1.") ? "false" : undefined);
  });
}
test("Yarn generation, engines, aliases and binary overrides fail before installation", async t => {
  for (const [files, pattern] of [
    [{ "yarn.lock": "# yarn lockfile v1\n" }, /generation/],
    [{ "package.json": JSON.stringify({ engines: { yarn: ">=5" } }) }, /engines.yarn/],
    [{ ".nvmrc": "lts/*" }, /numeric/],
    [{ ".node-version": "18" }, /.node-version requires/],
    [{ ".yarnrc.yml": "yarnPath: ../outside.cjs\n" }, /binary override/],
  ] as const) {
    const f = await fixture(t, { ...packageFiles("yarn"), ...files }), runner = fake();
    await assert.rejects(runner.installer.prepare(f.request()), pattern); assert.equal(installs(runner.calls).length, 0);
  }
});
test("manager pin/range mismatches and missing node fail without installation/download commands", async t => {
  for (const pkg of [{ packageManager: "npm@10.0.0" }, { packageManager: "npm@latest" }, { engines: { node: ">=30" } }]) {
    const f = await fixture(t, packageFiles("npm", pkg)), runner = fake();
    await assert.rejects(runner.installer.prepare(f.request()), /requires|exact/); assert.equal(installs(runner.calls).length, 0);
  }
  const f = await fixture(t, packageFiles()), runner = fake({}, call => { if (call.binary === "node") throw new Error("ENOENT"); });
  await assert.rejects(runner.installer.prepare(f.request()), /must already be installed/);
  assert.equal(runner.calls.length, 1);
});
test("lockfile selection rejects conflicts, mixed ecosystems, and unpinned manifests; overrides select only one", async t => {
  for (const files of [
    { ...packageFiles(), "pnpm-lock.yaml": "" },
    { ...packageFiles(), "requirements.txt": "" },
    { ...packageFiles(), "pyproject.toml": "[project]\nname='example'\n" },
    { "package.json": "{}" },
    { "pyproject.toml": "[project]\nname='example'\n" },
    { "go.work": "go 1.24\nuse ./module\n" },
    { ...packageFiles(), "package.json": '{"packageManager":"pnpm@10.0.0"}' },
  ]) {
    const f = await fixture(t, files), runner = fake();
    await assert.rejects(runner.installer.prepare(f.request()), /Ambiguous|Mixed|unambiguous|go.work|packageManager/);
    assert.equal(installs(runner.calls).length, 0);
  }
  const f = await fixture(t, { ...packageFiles(), "pnpm-lock.yaml": "", "requirements.txt": "" }), runner = fake();
  await runner.installer.prepare(f.request({ config: { manager: "pnpm" } }));
  assert.equal(installs(runner.calls)[0]?.binary, "pnpm");
});
test("configured project root is honored without recursive guessing; directory and manifest symlink escapes fail", async t => {
  const f = await fixture(t, Object.fromEntries(Object.entries(packageFiles()).map(([name, value]) => [`app/${name}`, value]))), runner = fake();
  assert.match((await runner.installer.prepare(f.request())).summary, /No recognized/);
  await runner.installer.prepare(f.request({ config: { directory: "app" } }));
  assert.equal(installs(runner.calls)[0]?.options.cwd, join(f.checkout, "app"));
  await assert.rejects(runner.installer.prepare(f.request({ config: { directory: ".." } })), /escapes/);
  await symlink(f.temp, join(f.checkout, "outside"));
  await assert.rejects(runner.installer.prepare(f.request({ config: { directory: "outside" } })), /symlink escape/);
  await writeFile(join(f.temp, "manifest"), "{}"); await symlink(join(f.temp, "manifest"), join(f.checkout, "package.json"));
  await assert.rejects(runner.installer.prepare(f.request()), /escapes checkout/);
});
test("shared/symlinked node_modules are rejected", async t => {
  const f = await fixture(t, packageFiles()); await symlink(f.temp, join(f.checkout, "node_modules"));
  const runner = fake(); await assert.rejects(runner.installer.prepare(f.request()), /shared\/symlinked/); assert.equal(installs(runner.calls).length, 0);
});
test("Bun frozen install rejects project and applicable global dev suppression without exposing secrets", async t => {
  const f = await fixture(t, packageFiles("bun")), home = join(f.temp, "home"), xdg = join(f.temp, "xdg");
  await mkdir(home); await mkdir(xdg); environment(t, { HOME: home, XDG_CONFIG_HOME: xdg });
  const runner = fake(); await runner.installer.prepare(f.request());
  assert.deepEqual(installs(runner.calls)[0]?.args, ["install", "--frozen-lockfile"]);
  for (const path of [join(f.checkout, "bunfig.toml"), join(home, ".bunfig.toml"), join(xdg, ".bunfig.toml")]) {
    for (const setting of ["production=true", "dev=false"]) {
      await writeFile(path, `[install]\n${setting}\nregistry = 'https://user:VERYSECRET@registry.test'\n`);
      const request = f.request(), failed = fake(); await assert.rejects(failed.installer.prepare(request), /disables dev dependencies/);
      assert.equal(installs(failed.calls).length, 0); assert.doesNotMatch(await readFile(request.logPath, "utf8"), /VERYSECRET/);
    }
    await rm(path);
  }
});
test("uv honors installed interpreter constraints, local venv, locked sync and declared dev without all extras", async t => {
  const f = await fixture(t, { "pyproject.toml": '[project]\nname="example"\nrequires-python=">=3.10,!=3.11.*,<4"\n[dependency-groups]\ndev=["pytest"]\n[project.optional-dependencies]\ndev=["ruff"]\ndocs=["sphinx"]\n', "uv.lock": "version = 1\n", ".python-version": "3.12" }), runner = fake();
  environment(t, { UV_PROJECT_ENVIRONMENT: "/shared", UV_PROJECT: "/outside", UV_NO_DEV: "true", UV_PYTHON_DOWNLOADS: "automatic", UV_MANAGED_PYTHON: "true", VIRTUAL_ENV: "/inherited", PYTHONPATH: "/outside" });
  const result = await runner.installer.prepare(f.request({ config: { python: "/installed/python3" } }));
  assert.equal(result.venv, join(f.checkout, ".venv"));
  const install = installs(runner.calls)[0]!;
  assert.deepEqual(install.args, ["sync", "--locked", "--no-python-downloads", "--project", f.checkout, "--python", "/installed/python3", "--dev", "--extra", "dev"]);
  assert.equal(install.options.env?.UV_PROJECT_ENVIRONMENT, result.venv); assert.equal(install.options.env?.UV_PYTHON_DOWNLOADS, "never");
  assert.equal(install.options.env?.UV_MANAGED_PYTHON, undefined); assert.equal(install.options.env?.UV_PROJECT, undefined); assert.equal(install.options.env?.UV_NO_DEV, undefined); assert.equal(install.options.env?.VIRTUAL_ENV, undefined);
  assert.ok(!install.args.includes("--all-extras"));
});
test("uv includes legacy dev dependencies", async t => {
  const f = await fixture(t, { "pyproject.toml": '[project]\nname="example"\n[tool.uv]\ndev-dependencies=["pytest"]\n', "uv.lock": "" }), runner = fake();
  await runner.installer.prepare(f.request()); assert.ok(installs(runner.calls)[0]!.args.includes("--dev"));
});
for (const [constraint, ok] of [[">=3.10,<4", true], ["~=3.12", true], ["~=3.12.0", true], ["==3.12.*", true], ["!=3.11.*", true], ["==3.12", false], ["~=3.11.0", false], [">=3.13", false], [">=3.10; sys_platform == 'linux'", false], [">=3.10 || <3", false]] as const) {
  test(`Python constraint ${constraint} is ${ok ? "honored" : "rejected"}`, async t => {
    const f = await fixture(t, { "pyproject.toml": `[project]\nname="example"\nrequires-python=${JSON.stringify(constraint)}\n`, "uv.lock": "" }), runner = fake();
    if (ok) await runner.installer.prepare(f.request());
    else { await assert.rejects(runner.installer.prepare(f.request()), /requires|Unsupported/); assert.equal(installs(runner.calls).length, 0); }
  });
}
test("Python version-file aliases and inherited virtual interpreters fail safely", async t => {
  const f = await fixture(t, { "requirements.txt": "", ".python-version": "system" }), runner = fake();
  await assert.rejects(runner.installer.prepare(f.request()), /numeric/);
  await rm(join(f.checkout, ".python-version"));
  const inherited = fake({}, call => call.args[1] === "-c" ? JSON.stringify({ version: "3.12.6", executable: "/shared/bin/python", prefix: "/shared", base_prefix: "/system" }) : undefined);
  await assert.rejects(inherited.installer.prepare(f.request()), /itself in a virtual environment/);
});
test("Poetry precreates and verifies project-local venv despite inherited/cached env; optional dev group included", async t => {
  const f = await fixture(t, { "pyproject.toml": '[tool.poetry]\nname="example"\n[tool.poetry.dependencies]\npython="^3.10"\n[tool.poetry.group.dev]\noptional=true\n[tool.poetry.group.dev.dependencies]\npytest="*"\n', "poetry.lock": "" }), runner = fake();
  environment(t, { VIRTUAL_ENV: "/shared", CONDA_PREFIX: "/conda", POETRY_VIRTUALENVS_CREATE: "false", POETRY_VIRTUALENVS_PATH: "/cached", POETRY_VIRTUALENVS_IN_PROJECT: "false", PATH: `/shared/bin:/conda/bin:${process.env.PATH}` });
  const result = await runner.installer.prepare(f.request()), install = installs(runner.calls)[0]!;
  assert.deepEqual(install.args, ["install", "--no-interaction", "--no-plugins", "--with", "dev"]);
  assert.equal(install.options.env?.VIRTUAL_ENV, result.venv); assert.equal(install.options.env?.POETRY_VIRTUALENVS_CREATE, "true");
  assert.equal(install.options.env?.POETRY_VIRTUALENVS_IN_PROJECT, "true"); assert.equal(install.options.env?.POETRY_VIRTUALENVS_PATH, undefined);
  assert.doesNotMatch(install.options.env!.PATH!, /\/shared\/bin|\/conda\/bin/);
  const creation = runner.calls.findIndex(call => call.args.includes("venv")), verification = runner.calls.findIndex(call => call.binary === "poetry" && call.args[0] === "env");
  assert.ok(creation >= 0 && verification > creation && runner.calls.indexOf(install) > verification);
});
test("Poetry legacy dev installs normally; standard dev groups require supported installed Poetry", async t => {
  const f = await fixture(t, { "pyproject.toml": '[tool.poetry]\nname="example"\n[tool.poetry.dev-dependencies]\npytest="*"\n', "poetry.lock": "" }), runner = fake();
  await runner.installer.prepare(f.request()); assert.deepEqual(installs(runner.calls)[0]?.args, ["install", "--no-interaction", "--no-plugins"]);
  await f.put("pyproject.toml", '[project]\nname="example"\n[dependency-groups]\ndev=["pytest"]\n');
  const old = fake({ poetry: "Poetry (version 2.1.0)" }); await assert.rejects(old.installer.prepare(f.request()), />=2.2/); assert.equal(installs(old.calls).length, 0);
});
test("Poetry refuses a selected cached/outside env before installation", async t => {
  const f = await fixture(t, { "pyproject.toml": '[tool.poetry]\nname="example"\n', "poetry.lock": "" });
  const runner = fake({}, call => call.binary === "poetry" && call.args[0] === "env" ? f.temp : undefined);
  await assert.rejects(runner.installer.prepare(f.request()), /outside\/shared/); assert.equal(installs(runner.calls).length, 0);
});
test("requirements install includes one conventional dev file; pip destination/config overrides are removed, auth retained", async t => {
  const f = await fixture(t, { "requirements.txt": "", "requirements/dev.txt": "" }), runner = fake();
  environment(t, { PIP_TARGET: "/system", PIP_PREFIX: "/prefix", PIP_ROOT: "/root", PIP_USER: "true", PIP_CONFIG_FILE: "/unsafe.conf", PIP_REQUIREMENT: "/elsewhere", PIP_CONSTRAINT: "/elsewhere", PIP_LOG: "/elsewhere.log", PIP_INDEX_URL: "https://user:secret@registry.test", PYTHONHOME: "/outside", PYTHONUSERBASE: "/outside" });
  await runner.installer.prepare(f.request());
  const install = installs(runner.calls)[0]!, env = install.options.env!;
  assert.deepEqual(install.args, ["-I", "-m", "pip", "install", "-r", join(f.checkout, "requirements.txt"), "-r", join(f.checkout, "requirements/dev.txt")]);
  assert.ok(install.binary.endsWith("/.venv/bin/python")); assert.equal(env.PIP_CONFIG_FILE, devNull); assert.equal(env.PIP_REQUIRE_VIRTUALENV, "true"); assert.equal(env.PIP_USER, "false");
  for (const key of ["PIP_TARGET", "PIP_PREFIX", "PIP_ROOT", "PIP_REQUIREMENT", "PIP_CONSTRAINT", "PIP_LOG", "PYTHONHOME", "PYTHONUSERBASE"]) assert.equal(env[key], undefined, key);
  assert.equal(env.PIP_INDEX_URL, "https://user:secret@registry.test");
});
test("requirements ambiguity needs explicit files, which are checkout-relative and exclusive to this manager", async t => {
  const f = await fixture(t, { "requirements.txt": "", "requirements-dev.txt": "", "dev-requirements.txt": "", "nested/custom.txt": "" }), runner = fake();
  await assert.rejects(runner.installer.prepare(f.request()), /Ambiguous conventional dev/);
  await runner.installer.prepare(f.request({ config: { manager: "requirements", directory: "nested", requirements: ["requirements.txt", "nested/custom.txt"] } }));
  const install = installs(runner.calls)[0]!; assert.ok(install.args.includes(join(f.checkout, "nested/custom.txt")));
  await assert.rejects(runner.installer.prepare(f.request({ config: { manager: "uv", requirements: ["requirements.txt"] } })), /only valid/);
  await assert.rejects(runner.installer.prepare(f.request({ config: { manager: "requirements", requirements: ["../outside.txt"] } })), /escapes checkout/);
});
test("nested requirements/constraints accept bounded local includes and reject escape, remote and cyclic inputs", async t => {
  const f = await fixture(t, { "requirements.txt": '-r req/base.txt\n-c "req/constraints.txt"\n', "req/base.txt": "--index-url https://registry.test/simple\n", "req/constraints.txt": "# empty\n" }), runner = fake();
  await runner.installer.prepare(f.request());
  for (const [text, pattern] of [["-r ../outside.txt", /escapes checkout/], ["--requirement=https://example.test/deps.txt", /Remote/], ["-rrequirements.txt", /Cyclic/], ["--target=/outside", /unsafe/], ["-r ${UNSET_SETUP_TEST_FILE}", /expansion/]] as const) {
    await f.put("requirements.txt", text); const failed = fake();
    await assert.rejects(failed.installer.prepare(f.request()), pattern); assert.equal(installs(failed.calls).length, 0);
  }
  await writeFile(join(f.temp, "outside.txt"), ""); await symlink(join(f.temp, "outside.txt"), join(f.checkout, "escaped.txt"));
  await f.put("requirements.txt", "-r escaped.txt"); await assert.rejects(fake().installer.prepare(f.request()), /symlink/);
});
test("symlinked .venv and outside executable directories are never reused", async t => {
  const f = await fixture(t, { "requirements.txt": "" }); await symlink(f.temp, join(f.checkout, ".venv"));
  const runner = fake(); await assert.rejects(runner.installer.prepare(f.request()), /symlinked/); assert.equal(installs(runner.calls).length, 0);
  await rm(join(f.checkout, ".venv")); await mkdir(join(f.checkout, ".venv")); await symlink(f.temp, join(f.checkout, ".venv/bin"));
  await assert.rejects(fake().installer.prepare(f.request()), /executable directory escapes/);
});
test("actual venv prefix and system-site-packages must be safe before installation", async t => {
  const f = await fixture(t, { "requirements.txt": "" }); await createVenv(f.checkout);
  const wrong = fake({}, call => call.binary.includes("/.venv/") && call.args[1] === "-c" ? JSON.stringify({ version: "3.12.6", executable: call.binary, prefix: "/shared", base_prefix: "/system" }) : undefined);
  await assert.rejects(wrong.installer.prepare(f.request()), /does not actually belong/); assert.equal(installs(wrong.calls).length, 0);
  await f.put(".venv/pyvenv.cfg", "include-system-site-packages = true\n");
  await assert.rejects(fake().installer.prepare(f.request()), /system-site-packages/);
});
test("Go uses local toolchain/read-only module policy and checks go/toolchain declarations", async t => {
  const f = await fixture(t, { "go.mod": "module example.test/project\ngo 1.23\ntoolchain go1.24.0\n" }), runner = fake();
  await runner.installer.prepare(f.request());
  assert.deepEqual(runner.calls.map(call => call.args.slice(0, 2)), [["version"], ["mod", "download"]]);
  assert.match(runner.calls[1]!.args[2]!, /^-modfile=.*setup\.mod$/);
  for (const call of runner.calls) { assert.equal(call.options.env?.GOTOOLCHAIN, "local"); assert.equal(call.options.env?.GOFLAGS, ""); assert.equal(call.options.env?.GOWORK, "off"); }
  await f.put("go.mod", "module example.test/project\ngo 1.23\ntoolchain go1.25.0\n");
  const failed = fake(); await assert.rejects(failed.installer.prepare(f.request()), /requires Go 1.25.0/); assert.equal(failed.calls.length, 1);
});
test("failed installer output and successful probe stderr survive in the sanitized log", async t => {
  const f = await fixture(t, packageFiles()), runner = fake({}, call => {
    call.options.onOutput?.("warning from command\n", "stderr");
    if (call.args[0] === "ci") { call.options.onOutput?.("LAST OUTPUT\n", "stdout"); throw new WorkflowError("install failed", false, "complete error details\nhttps://user:secret@host.test"); }
  }), request = f.request();
  await assert.rejects(runner.installer.prepare(request), error => { assert.match(detailsOf(error), /complete error details/); return true; });
  const log = await readFile(request.logPath, "utf8"); assert.match(log, /warning from command/); assert.match(log, /LAST OUTPUT/); assert.match(log, /complete error details/); assert.doesNotMatch(log, /user:secret/);
});
test("per-attempt logs are bounded even for an injected executor", async t => {
  const f = await fixture(t, packageFiles()), runner = fake({}, call => { if (call.args[0] === "ci") call.options.onOutput?.("x".repeat(4 * 1024 * 1024), "stderr"); }), request = f.request();
  await runner.installer.prepare(request); assert.ok((await lstat(request.logPath)).size <= 2 * 1024 * 1024);
  assert.match(await readFile(request.logPath, "utf8"), /Diagnostics truncated/);
});
test("noisy output cannot consume the final failure reason or stderr", async t => {
  const f = await fixture(t, packageFiles()), request = f.request();
  const runner = fake({}, call => {
    if (call.args[0] !== "ci") return;
    call.options.onOutput?.("build noise\n".repeat(300_000), "stdout");
    call.options.onOutput?.("LAST FAILURE TAIL\n", "stderr");
    throw new Error("FINAL FAILURE REASON");
  });
  await assert.rejects(runner.installer.prepare(request), /FINAL FAILURE REASON/);
  const log = await readFile(request.logPath, "utf8");
  assert.ok(Buffer.byteLength(log) <= 2 * 1024 * 1024);
  assert.match(log, /Diagnostics truncated/); assert.match(log, /Setup failed:.*FINAL FAILURE REASON/); assert.match(log, /LAST FAILURE TAIL/);
  assert.equal((await lstat(request.logPath)).mode & 0o777, 0o600);
});
test("a reserved footer survives earlier noisy commands and keeps bounded UTF-8 failure details", async t => {
  const f = await fixture(t, packageFiles()), request = f.request();
  const runner = fake({}, call => {
    if (call.args[0] === "--version") call.options.onOutput?.("漢😀 probe noise\n".repeat(100_000), "stderr");
    if (call.args[0] === "ci") {
      call.options.onOutput?.("LATE STDERR\n", "stderr");
      throw new WorkflowError("DISTINCT FAILURE", false, "FIRST DETAIL\n" + "漢😀 detail\n".repeat(15_000) + "LAST DETAIL");
    }
  });
  await assert.rejects(runner.installer.prepare(request), /DISTINCT FAILURE/);
  const log = await readFile(request.logPath, "utf8");
  assert.ok(Buffer.byteLength(log) <= 2 * 1024 * 1024); assert.doesNotMatch(log, /\ufffd/);
  for (const text of ["Diagnostics truncated", "Setup failed:", "DISTINCT FAILURE", "FIRST DETAIL", "LAST DETAIL", "LATE STDERR"]) assert.ok(log.includes(text), text);
});
test("split credentials and raw records crossing capture limits cannot leak fragments", async t => {
  const f = await fixture(t, packageFiles()), request = f.request();
  const runner = fake({}, call => {
    if (call.args[0] !== "ci") return;
    for (const chunk of ["\x1b[", "31mhttps://user:", "CHUNK_SECRET@host.test/?token=", "QUERY_SECRET\x1b[0m\nAuthoriza", "tion:\n Be", "arer HEADER_SECRET\n"]) call.options.onOutput?.(chunk, "stderr");
    call.options.onOutput?.("safe record\nhttps://user:BOUNDARY_SECRET" + "x".repeat(2 * 1024 * 1024), "stdout");
    call.options.onOutput?.("@host.test\n", "stdout");
    throw new Error("Known failure");
  });
  await assert.rejects(runner.installer.prepare(request));
  const log = await readFile(request.logPath, "utf8");
  assert.match(log, /safe record/); assert.match(log, /Diagnostics truncated/); assert.match(log, /redacted/);
  assert.doesNotMatch(log, /CHUNK_SECRET|QUERY_SECRET|HEADER_SECRET|BOUNDARY_SECRET|\x1b/);
});
test("all commands share one total deadline and late fake success cannot claim success", async t => {
  const f = await fixture(t, packageFiles()), runner = fake({}, async call => { if (call.args[0] === "--version") await delay(40); });
  await assert.rejects(runner.installer.prepare(f.request({ timeoutMs: 65 })), /timed out/);
  assert.equal(installs(runner.calls).length, 0);
  if (runner.calls.length > 1) assert.ok(runner.calls[1]!.options.timeout! < runner.calls[0]!.options.timeout!);
});
test("abort is propagated to the executor and prevents later installs", async t => {
  const f = await fixture(t, packageFiles()), controller = new AbortController();
  const runner = fake({}, call => { assert.equal(call.options.signal, controller.signal); controller.abort(); });
  await assert.rejects(runner.installer.prepare(f.request({ signal: controller.signal })), /aborted/); assert.equal(runner.calls.length, 1);
});
test("offline stdlib venv smoke test verifies a real interpreter; pip install is intercepted", async t => {
  if (process.platform === "win32") return t.skip("POSIX Python test");
  try { await run("python3", ["-I", "--version"], { timeout: 5_000 }); } catch { return t.skip("python3 unavailable"); }
  const f = await fixture(t, { "requirements.txt": "# deliberately empty, no network\n" });
  let intercepted = false;
  const offline: Run = async (binary, args, options) => {
    if (args.includes("pip") && args.includes("install")) { intercepted = true; return "offline test: no installer executed"; }
    assert.ok(args.includes("-c") || args.includes("venv") || args.includes("--version"));
    return run(binary, args, { ...options, env: { ...options?.env, PIP_NO_INDEX: "1" } });
  };
  const result = await new DependenciesInstaller(offline).prepare(f.request({ timeoutMs: 30_000 }));
  assert.equal(result.venv, join(f.checkout, ".venv")); assert.equal(intercepted, true);
  const sitePackages = (await run(join(result.venv!, "bin/python"), ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"])).trim();
  const outside = join(f.temp, "shared-site-packages"); await mkdir(outside);
  await rm(sitePackages, { recursive: true }); await symlink(outside, sitePackages);
  intercepted = false;
  await assert.rejects(new DependenciesInstaller(offline).prepare(f.request({ timeoutMs: 30_000 })), /installation path escapes/);
  assert.equal(intercepted, false);
});
test("uv discovers a matching already-installed base Python without downloads, rather than choosing mismatched global python3", async t => {
  const f = await fixture(t, { "pyproject.toml": '[project]\nname="example"\nrequires-python=">=3.12,<3.13"\n', ".python-version": "3.12", "uv.lock": "" });
  const runner = fake({}, call => {
    if (call.binary === "python3") throw new Error("global Python 3.14 must not be selected");
    if (call.binary === "uv" && call.args[0] === "python") return "/uv-installed/cpython3.12/bin/python3";
    if (call.binary === "/uv-installed/cpython3.12/bin/python3") return JSON.stringify({ version: "3.12.6", executable: call.binary, prefix: "/uv-installed/cpython3.12", base_prefix: "/uv-installed/cpython3.12" });
  });
  await runner.installer.prepare(f.request());
  assert.deepEqual(runner.calls.slice(0, 2).map(call => call.args), [["--version"], ["python", "find", "--system", "--no-python-downloads", "--project", f.checkout]]);
  const install = installs(runner.calls)[0]!;
  assert.ok(install.args.includes("/uv-installed/cpython3.12/bin/python3")); assert.equal(install.options.env?.UV_NO_MANAGED_PYTHON, undefined);
  const missing = fake({}, call => { if (call.binary === "uv" && call.args[0] === "python") throw new Error("No interpreter found"); });
  await assert.rejects(missing.installer.prepare(f.request()), /No interpreter found/); assert.equal(installs(missing.calls).length, 0);
});
test("uv without Python declarations retains the installed python3 fallback", async t => {
  const f = await fixture(t, { "pyproject.toml": '[project]\nname="example"\n', "uv.lock": "" }), runner = fake();
  await runner.installer.prepare(f.request());
  assert.ok(runner.calls.some(call => call.binary === "python3")); assert.ok(!runner.calls.some(call => call.binary === "uv" && call.args[0] === "python"));
});
test("requirements validation uses each include spelling, not symlink-target directories or a canonical-only dedup cache", async t => {
  const f = await fixture(t, { "requirements.txt": "-r files/common.txt\n-r alias.txt\n", "files/common.txt": "-r inner.txt\n", "files/inner.txt": "" });
  await symlink(join(f.checkout, "files/common.txt"), join(f.checkout, "alias.txt"));
  await writeFile(join(f.temp, "outside.txt"), ""); await symlink(join(f.temp, "outside.txt"), join(f.checkout, "inner.txt"));
  const runner = fake(); await assert.rejects(runner.installer.prepare(f.request()), /symlink/); assert.equal(installs(runner.calls).length, 0);
  await f.put("requirements.txt", "--index-url=https://example.test -r../outside.txt");
  await assert.rejects(fake().installer.prepare(f.request()), /Ambiguous nested/);
});
test("Poetry optional dev include-groups are explicitly included", async t => {
  const f = await fixture(t, { "pyproject.toml": '[tool.poetry]\nname="example"\n[tool.poetry.group.dev]\noptional=true\ninclude-groups=["test"]\n[tool.poetry.group.test.dependencies]\npytest="*"\n', "poetry.lock": "" }), runner = fake();
  await runner.installer.prepare(f.request()); assert.deepEqual(installs(runner.calls)[0]?.args, ["install", "--no-interaction", "--no-plugins", "--with", "dev"]);
});
test("pnpm runtime-management declarations fail before probes; workspace PM management cannot override CLI guards", async t => {
  for (const extra of [
    { ".npmrc": "use-node-version=18.0.0\n" },
    { "pnpm-workspace.yaml": "useNodeVersion: 18.0.0\n" },
    { "package.json": JSON.stringify({ pnpm: { executionEnv: { nodeVersion: "18.0.0" } } }) },
    { "package.json": JSON.stringify({ devEngines: { runtime: { name: "node", version: "18.0.0", onFail: "download" } } }) },
  ]) {
    const f = await fixture(t, { ...packageFiles("pnpm"), ...extra }), runner = fake();
    await assert.rejects(runner.installer.prepare(f.request()), /runtime-management/); assert.equal(runner.calls.length, 0);
  }
  const f = await fixture(t, { ...packageFiles("pnpm"), "pnpm-workspace.yaml": "managePackageManagerVersions: true\npmOnFail: download\nmodulesDir: /outside\nvirtualStoreDir: /outside\n" }), runner = fake();
  environment(t, { npm_config_modules_dir: "/shared", npm_config_virtual_store_dir: "/shared", npm_config_use_node_version: "18.0.0" });
  await runner.installer.prepare(f.request());
  const pnpmCalls = runner.calls.filter(call => call.binary === "pnpm");
  assert.deepEqual(pnpmCalls.map(call => call.args[0]), ["--version", "install"]);
  for (const call of pnpmCalls) {
    assert.ok(call.args.includes("--config.manage-package-manager-versions=false")); assert.ok(call.args.includes("--config.pm-on-fail=ignore")); assert.ok(call.args.includes("--config.use-node-version="));
    assert.ok(!call.args.includes("--manage-package-manager-versions=false")); assert.ok(!call.args.includes("--use-node-version="));
    assert.ok(call.args.includes("--modules-dir=node_modules")); assert.ok(call.args.includes("--virtual-store-dir=node_modules/.pnpm"));
    assert.ok(call.args.includes(`--lockfile-dir=${f.checkout}`));
  }
});
test("Yarn destinations override inherited/project redirects and reject symlinked local folders", async t => {
  const classic = await fixture(t, { ...packageFiles("yarn"), "yarn.lock": "# yarn lockfile v1\n", ".yarnrc": "--modules-folder ../outside\n" }), runner = fake({ yarn: "1.22.22" });
  await runner.installer.prepare(classic.request());
  const call = installs(runner.calls)[0]!; assert.equal(call.args[call.args.indexOf("--modules-folder") + 1], join(classic.checkout, "node_modules"));
  const modern = await fixture(t, packageFiles("yarn")), berry = fake();
  environment(t, { YARN_PNP_UNPLUGGED_FOLDER: "/outside", YARN_VIRTUAL_FOLDER: "/outside", YARN_INSTALL_STATE_PATH: "/outside" });
  await berry.installer.prepare(modern.request());
  assert.equal(installs(berry.calls)[0]!.options.env?.YARN_PNP_UNPLUGGED_FOLDER, join(modern.checkout, ".yarn/unplugged"));
  await symlink(modern.temp, join(modern.checkout, ".yarn"));
  await assert.rejects(fake().installer.prepare(modern.request()), /symlinked dependency destination/);
});
test("venv sysconfig installation paths must all remain local even when sys.prefix is correct", async t => {
  const f = await fixture(t, { "requirements.txt": "" }); await createVenv(f.checkout);
  for (const key of ["purelib", "platlib", "scripts", "data"]) {
    const runner = fake({}, call => {
      if (call.binary.includes("/.venv/") && call.args[1] === "-c") {
        const prefix = join(f.checkout, ".venv"), paths = { purelib: prefix, platlib: prefix, scripts: prefix, data: prefix, [key]: "/outside" };
        return JSON.stringify({ version: "3.12.6", executable: call.binary, prefix, base_prefix: "/installed", paths });
      }
    });
    await assert.rejects(runner.installer.prepare(f.request()), /installation path escapes/); assert.equal(installs(runner.calls).length, 0);
  }
});
test("Go metadata rewrites happen only in disposable alternate files and fail without changing checkout locks", async t => {
  const original = "module example.test/project\ngo 1.23\n", sum = "original checksum\n";
  const f = await fixture(t, { "go.mod": original, "go.sum": sum });
  let scratch: string | undefined;
  const runner = fake({}, async call => {
    if (call.binary === "go" && call.args[0] === "mod") {
      scratch = call.args.find(arg => arg.startsWith("-modfile="))!.slice("-modfile=".length);
      assert.equal(await readFile(scratch, "utf8"), original);
      await writeFile(scratch, "changed metadata\n"); await writeFile(scratch.replace(/\.mod$/, ".sum"), "changed sums\n");
    }
  });
  await assert.rejects(runner.installer.prepare(f.request()), /left unchanged/);
  assert.equal(await readFile(join(f.checkout, "go.mod"), "utf8"), original); assert.equal(await readFile(join(f.checkout, "go.sum"), "utf8"), sum);
  await assert.rejects(lstat(dirname(scratch!)), /ENOENT/);
});
test("Poetry declared plugins never bootstrap tooling; bare Python versions are not npm ranges", async t => {
  const f = await fixture(t, { "pyproject.toml": '[tool.poetry]\nname="example"\n[tool.poetry.requires-plugins]\npoetry-plugin-export=">=1.8"\n', "poetry.lock": "" }), runner = fake();
  await assert.rejects(runner.installer.prepare(f.request()), /never bootstraps/); assert.equal(installs(runner.calls).length, 0);
  await f.put("pyproject.toml", '[tool.poetry]\nname="example"\n[tool.poetry.dependencies]\npython="3.12"\n');
  await assert.rejects(fake().installer.prepare(f.request()), /requires 3.12/);
  await f.put("pyproject.toml", '[tool.poetry]\nname="example"\n[tool.poetry.dependencies]\npython="3.12.*"\n');
  await fake().installer.prepare(f.request());
});
