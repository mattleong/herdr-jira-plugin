import { constants } from "node:fs";
import { open, readFile, realpath, lstat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, delimiter, dirname } from "node:path";
import { devNull, homedir, tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import * as semver from "semver";
import { WorkflowError, detailsOf, diagnosticText, safeText } from "./errors.js";
import { run, type Run } from "./process.js";
import { setupManagers, type SetupManager, type SetupRequest, type SetupResult } from "./setup-types.js";

type Data = Record<string, unknown>;
const jsManagers = ["npm", "pnpm", "yarn", "bun"] as const;
const locks: Record<typeof jsManagers[number], string[]> = {
  npm: ["npm-shrinkwrap.json", "package-lock.json"], pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"], bun: ["bun.lock", "bun.lockb"],
};
const devRequirements = ["requirements-dev.txt", "dev-requirements.txt", "requirements/dev.txt"];
const maxFile = 16 * 1024 * 1024, maxLog = 2 * 1024 * 1024;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => object(current)[key], value);
const nonempty = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : Object.keys(object(value)).length > 0;
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); };
function fail(message: string): never { throw new WorkflowError(message); }
function sanitize(value: string): string {
  return diagnosticText(value).replace(/((?:authorization|password|_authToken|api[_-]?key|access[_-]?token)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s]+/gi, "$1[redacted]");
}
function numericVersion(text: string, label: string): string {
  const match = text.trim().match(/^v?(\d+(?:\.\d+){0,2})$/);
  if (!match) fail(`${label} must specify a numeric installed version; aliases and downloads are not supported.`);
  return match[1]!;
}
function checkRange(version: string, constraint: unknown, label: string): void {
  if (constraint === undefined) return;
  if (typeof constraint !== "string" || !semver.validRange(constraint)) fail(`Unsupported ${label} constraint: ${safeText(String(constraint))}.`);
  if (!semver.satisfies(version, constraint)) fail(`${label} requires ${constraint}, but installed version is ${version}. Install/select the required runtime or tool yourself.`);
}
function checkPython(version: string, constraint: unknown, label: string, poetry = false): void {
  if (constraint === undefined) return;
  if (typeof constraint !== "string" || !constraint.trim()) fail(`Unsupported ${label} constraint.`);
  if (poetry && /^(?:(?:\^|~(?![=]))\d+(?:\.\d+){0,2}|\d+(?:\.\d+){0,1}\.\*|\*)$/.test(constraint.trim())) {
    checkRange(version, constraint, label); return;
  }
  // Poetry bare versions are exact releases, unlike npm's partial-version ranges.
  const spec = poetry && /^\d+(?:\.\d+){0,2}$/.test(constraint.trim()) ? `==${constraint.trim()}` : constraint;
  for (const part of spec.split(",")) {
    const match = part.trim().match(/^(>=|<=|==|!=|>|<|~=)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/);
    if (!match || (match[3] && !["==", "!="].includes(match[1]!))) fail(`Unsupported ${label} constraint: ${safeText(constraint)}.`);
    const [, operator, digits, wildcard] = match;
    const components = digits!.split(".");
    const target = [...components, ...Array(3 - components.length).fill("0")].join(".");
    if (!semver.valid(target)) fail(`Unsupported ${label} constraint: ${safeText(constraint)}.`);
    let matches: boolean;
    if (wildcard) {
      matches = version.split(".").slice(0, components.length).join(".") === digits;
      if (operator === "!=") matches = !matches;
    } else if (operator === "~=") {
      if (components.length < 2) fail(`Unsupported ${label} constraint: ${safeText(constraint)}.`);
      const upper = components.length === 2 ? `${Number(components[0]) + 1}.0.0` : `${components[0]}.${Number(components[1]) + 1}.0`;
      matches = semver.gte(version, target) && semver.lt(version, upper);
    } else {
      const comparison = semver.compare(version, target);
      matches = operator === "==" ? comparison === 0 : operator === "!=" ? comparison !== 0 : operator === ">=" ? comparison >= 0 : operator === "<=" ? comparison <= 0 : operator === ">" ? comparison > 0 : comparison < 0;
    }
    if (!matches) fail(`${label} requires ${constraint}, but installed Python is ${version}. Select an installed interpreter with setup.python; Python will not be downloaded.`);
  }
}

/** One instance is safe to reuse: all deadlines, diagnostics and environment state are per attempt. */
export class DependenciesInstaller {
  constructor(private readonly execute: Run = run) {}

  async prepare(request: SetupRequest): Promise<SetupResult> {
    const deadline = Date.now() + request.timeoutMs;
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) fail("Dependency setup timeout must be positive.");
    // Exclusive/no-follow is intentional: retries must allocate a fresh private log.
    const log = await open(request.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = 0;
    const append = async (text: string): Promise<void> => {
      if (written >= maxLog) return;
      const bytes = Buffer.from(sanitize(text));
      const slice = bytes.subarray(0, maxLog - written);
      written += slice.length;
      await log.write(slice);
    };
    const remaining = (): number => {
      if (request.signal?.aborted) fail("Dependency setup aborted.");
      const time = deadline - Date.now();
      if (time <= 0) fail("Dependency setup timed out (total setup deadline reached).");
      return time;
    };
    try {
      await append("Dependency setup\n");
      remaining();
      const config = request.config ?? {};
      if (config.manager !== undefined && config.manager !== "auto" && config.manager !== "none" && !setupManagers.includes(config.manager)) fail("Unsupported dependency setup manager.");
      if (config.manager === "none") { await append("Setup disabled by configuration.\n"); return { summary: "Dependency setup disabled by configuration." }; }
      const checkout = await realpath(request.checkout);
      if (config.directory !== undefined && (typeof config.directory !== "string" || isAbsolute(config.directory))) fail("Setup directory must be checkout-relative.");
      const requestedRoot = resolve(checkout, config.directory ?? ".");
      if (!inside(checkout, requestedRoot)) fail("Setup directory escapes the checkout.");
      const root = await realpath(requestedRoot);
      if (!inside(checkout, root) || !(await lstat(root)).isDirectory()) fail("Setup directory must be a directory inside the checkout (no symlink escape).");
      const file = async (name: string, base = root): Promise<string | undefined> => {
        remaining();
        const path = resolve(base, name);
        if (!inside(checkout, path)) fail(`Setup file escapes checkout: ${name}.`);
        let actual: string;
        try { actual = await realpath(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
        if (!inside(checkout, actual)) fail(`Setup file escapes checkout through a symlink: ${name}.`);
        const stat = await lstat(actual);
        if (!stat.isFile() || stat.size > maxFile) fail(`Setup file is not a bounded regular file: ${name}.`);
        return await readFile(actual, "utf8");
      };
      const json = (source: string, name: string): Data => {
        try {
          const value: unknown = JSON.parse(source);
          if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${name}: expected an object.`);
          return value as Data;
        } catch { return fail(`Invalid ${name}.`); }
      };
      const toml = (source: string, name: string): Data => { try { return object(parseToml(source)); } catch { return fail(`Invalid ${name}; check its TOML syntax.`); } };
      const packageSource = await file("package.json"), pySource = await file("pyproject.toml");
      const pkg = packageSource === undefined ? undefined : json(packageSource, "package.json");
      const py = pySource === undefined ? undefined : toml(pySource, "pyproject.toml");
      const explicit = config.manager && config.manager !== "auto" ? config.manager : undefined;
      if (config.requirements !== undefined && explicit !== "requirements") fail("setup.requirements is only valid with setup.manager = requirements.");
      const availableLocks = new Map<SetupManager, string[]>();
      for (const manager of jsManagers) {
        const present: string[] = [];
        for (const name of locks[manager]) if (await file(name) !== undefined) present.push(name);
        if (present.length) availableLocks.set(manager, present);
      }
      const uvLock = await file("uv.lock"), poetryLock = await file("poetry.lock"), requirements = await file("requirements.txt");
      const goMod = await file("go.mod"), goWork = await file("go.work");
      const candidates: SetupManager[] = [...availableLocks.keys()];
      if (uvLock !== undefined) candidates.push("uv");
      if (poetryLock !== undefined || nonempty(at(py, "tool", "poetry"))) candidates.push("poetry");
      if (requirements !== undefined) candidates.push("requirements");
      if (goMod !== undefined) candidates.push("go");
      let manager = explicit;
      if (!manager) {
        if (candidates.length > 1) fail(`Ambiguous dependency managers at this root: ${candidates.join(", ")}. Set setup.manager and, if needed, setup.directory.`);
        manager = candidates[0];
        if (!manager) {
          if (goWork !== undefined) fail("A go.work-only layout is unsupported. Set setup.directory to the intended module containing go.mod.");
          if (pkg || py) fail("No unambiguous supported dependency setup: package.json requires a matching lockfile; pyproject.toml requires uv.lock, poetry.lock or requirements files. Set setup.manager/directory explicitly.");
          const summary = "No recognized dependency setup at this root; nothing installed.";
          await append(`${summary}\n`); return { summary };
        }
        if ((pkg && !jsManagers.includes(manager as typeof jsManagers[number])) || (py && jsManagers.includes(manager as typeof jsManagers[number])) || (py && manager === "go") || (goWork !== undefined && manager !== "go")) {
          fail("Mixed dependency manifests at this root require an explicit setup.manager (and optionally setup.directory); no ecosystem will be silently skipped.");
        }
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      const command = async (binary: string, args: string[], label: string, environment = env): Promise<string> => {
        // CLI configuration outranks pnpm-workspace.yaml; env-only guards do not.
        // The config. prefix also keeps these guards valid for pnpm's install parser.
        if (binary === "pnpm") args = [...args, "--config.manage-package-manager-versions=false", "--config.use-node-version=", "--modules-dir=node_modules", "--virtual-store-dir=node_modules/.pnpm", `--lockfile-dir=${root}`];
        remaining();
        request.progress?.(label);
        await append(`\n$ ${binary} ${args.join(" ")}\n`);
        let stdout = "", stderr = "", outputSize = 0, streamed = false;
        const capture = (text: string, stream: "stdout" | "stderr"): void => {
          streamed = true;
          const chunk = Buffer.from(text).subarray(0, Math.max(0, maxLog - outputSize)).toString("utf8");
          outputSize += Buffer.byteLength(chunk);
          if (stream === "stdout") stdout += chunk; else stderr += chunk;
        };
        try {
          const result = await this.execute(binary, args, { cwd: root, timeout: remaining(), env: environment, signal: request.signal, onOutput: capture });
          if (!streamed) capture(result, "stdout");
          await append(`${stdout ? `stdout:\n${stdout}\n` : ""}${stderr ? `stderr:\n${stderr}\n` : ""}`);
          remaining();
          return result;
        } catch (error) {
          await append(`${stdout ? `stdout:\n${stdout}\n` : ""}${stderr ? `stderr:\n${stderr}\n` : ""}failed:\n${detailsOf(error)}\n`);
          const summary = `${label} failed: ${safeText(error instanceof Error ? error.message : String(error))} Install required tools/runtimes yourself; setup never bootstraps them.`;
          throw new WorkflowError(summary, false, `${summary}\n\n${detailsOf(error)}`);
        }
      };
      const toolVersion = async (tool: string): Promise<string> => {
        const text = (await command(tool, ["--version"], `Checking ${tool}`)).trim();
        const version = text.match(/(?:^|[\s(v])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[\s)])/m)?.[1];
        if (!version || !semver.valid(version)) fail(`Could not determine installed ${tool} version: ${safeText(text)}.`);
        return version;
      };
      if (jsManagers.includes(manager as typeof jsManagers[number])) {
        const js = manager as typeof jsManagers[number];
        if (!pkg) fail(`${js} requires package.json at the selected setup directory.`);
        if (!availableLocks.has(js)) fail(`${js} requires a matching committed lockfile; setup will not generate one.`);
        let pin: string | undefined;
        if (pkg.packageManager !== undefined) {
          if (typeof pkg.packageManager !== "string") fail("packageManager must be an exact manager@version pin.");
          const match = pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[^\s]+)?$/);
          if (!match || !semver.valid(match[2])) fail("packageManager must be an exact supported manager@version pin (ranges/tags cannot trigger downloads).");
          if (match[1] !== js && !explicit) fail(`packageManager selects ${match[1]} but its matching lockfile is absent or conflicting.`);
          if (match[1] === js) pin = match[2];
        }
        const localDestination = async (name: string): Promise<string> => {
          let path = root;
          for (const segment of name.split("/")) {
            path = join(path, segment);
            try { if ((await lstat(path)).isSymbolicLink()) fail(`Refusing symlinked dependency destination: ${name}.`); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          return path;
        };
        if (js === "pnpm") {
          const workspace = await file("pnpm-workspace.yaml") ?? "", npmrc = await file(".npmrc") ?? "";
          if (at(pkg, "pnpm", "executionEnv") !== undefined || at(pkg, "devEngines", "runtime") !== undefined || /(?:use[-_]?node[-_]?version|executionEnv|nodeVersion|runtime)\s*[\"']?\s*[:=]/i.test(`${workspace}\n${npmrc}`)) fail("pnpm runtime-management declarations are unsupported; use an installed Node satisfying engines.node/.nvmrc instead of automatic runtime downloads.");
          await localDestination("node_modules/.pnpm");
        }
        try {
          const modules = await lstat(join(root, "node_modules"));
          if (modules.isSymbolicLink() || !modules.isDirectory()) fail("Refusing shared/symlinked node_modules; dependencies must be local to this checkout.");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const key of Object.keys(env)) if (/^(?:npm_config_(?:omit|only|production|prefix|global|workspace|workspaces|userconfig|location|dry_run|package_lock_only|lockfile_only|manage_package_manager_versions|use_node_version)|yarn_(?:production|ignore_path|yarn_path|rc_filename)|node_options)$/i.test(key)) delete env[key];
        Object.assign(env, {
          NODE_ENV: "development", npm_config_production: "false", npm_config_omit: "", npm_config_only: "", npm_config_include: "dev", npm_config_prefix: root, npm_config_global: "false", npm_config_dry_run: "false", npm_config_package_lock_only: "false",
          COREPACK_ENABLE_NETWORK: "0", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_ENABLE_PROJECT_SPEC: "0", COREPACK_ENABLE_STRICT: "0",
          npm_config_manage_package_manager_versions: "false", npm_config_use_node_version: "", npm_config_package_manager_strict: "false", YARN_IGNORE_PATH: "true",
        });
        let classicYarn = false;
        if (js === "yarn") {
          const lock = (await file("yarn.lock"))!;
          classicYarn = /^# yarn lockfile v1\s*$/m.test(lock);
          if (classicYarn === /^__metadata:\s*$/m.test(lock)) fail("Unrecognized or ambiguous Yarn lockfile generation.");
          const yarnConfig = `${await file(".yarnrc.yml") ?? ""}\n${await file(".yarnrc") ?? ""}`;
          if (/^\s*(?:[\"']?yarnPath[\"']?\s*:|[\"']?yarn-path[\"']?\s)/m.test(yarnConfig)) fail("A project yarnPath/yarn-path override is unsupported; select the matching installed Yarn without a binary override.");
          if (classicYarn) env.YARN_PRODUCTION = "false";
          else Object.assign(env, {
            YARN_PNP_UNPLUGGED_FOLDER: await localDestination(".yarn/unplugged"),
            YARN_VIRTUAL_FOLDER: await localDestination(".yarn/__virtual__"),
            YARN_INSTALL_STATE_PATH: await localDestination(".yarn/install-state.gz"),
          });
        }
        const nvm = await file(".nvmrc"), nodeFile = await file(".node-version");
        if (js !== "bun" || at(pkg, "engines", "node") !== undefined || nvm !== undefined || nodeFile !== undefined) {
          const node = await toolVersion("node");
          checkRange(node, at(pkg, "engines", "node"), "engines.node");
          if (nvm !== undefined) checkRange(node, numericVersion(nvm, ".nvmrc"), ".nvmrc");
          if (nodeFile !== undefined) checkRange(node, numericVersion(nodeFile, ".node-version"), ".node-version");
        }
        const version = await toolVersion(js);
        if (pin && !semver.eq(version, pin)) fail(`packageManager requires ${js}@${pin}, but installed ${js} is ${version}. Install/select that version yourself; setup will not download it.`);
        checkRange(version, at(pkg, "engines", js), `engines.${js}`);
        let args: string[];
        if (js === "npm") args = ["ci", "--include=dev", "--prefix", root, "--global=false"];
        else if (js === "pnpm") args = ["install", "--frozen-lockfile", "--prod=false"];
        else if (js === "yarn") {
          if (classicYarn ? semver.major(version) !== 1 : semver.major(version) < 2) fail("Installed Yarn generation does not match yarn.lock (classic v1 versus modern metadata). Install the matching Yarn version yourself.");
          args = classicYarn ? ["install", "--frozen-lockfile", "--production=false", "--modules-folder", join(root, "node_modules"), "--cwd", root] : ["install", "--immutable"];
        } else {
          const configs: Array<[string, string]> = [];
          const bunSource = await file("bunfig.toml");
          if (bunSource !== undefined) configs.push(["bunfig.toml", bunSource]);
          // Bun loads a user file in addition to the project's file. Never dump credential-bearing configs.
          for (const path of new Set([join(env.HOME || homedir(), ".bunfig.toml"), ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, ".bunfig.toml")] : [])])) {
            try {
              const actual = await realpath(path), stat = await lstat(actual);
              if (!stat.isFile() || stat.size > maxFile) fail("Global Bun configuration is not a bounded regular file.");
              configs.push(["global .bunfig.toml", await readFile(actual, "utf8")]);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          for (const [name, source] of configs) {
            const bun = toml(source, name);
            if (at(bun, "install", "production") === true || at(bun, "install", "dev") === false) fail(`${name} disables dev dependencies (install.production=true or install.dev=false); change that configuration before automatic setup.`);
            if (at(bun, "install", "dryRun") === true) fail(`${name} enables install.dryRun; automatic setup cannot claim dependencies were installed.`);
          }
          args = ["install", "--frozen-lockfile"];
        }
        await command(js, args, `Installing ${js} dependencies (including dev)`);
        return { summary: `${js} dependencies installed, including dev dependencies, using the existing lockfile.` };
      }
      if (manager === "go") {
        if (goMod === undefined) fail("Go setup requires go.mod; configure setup.directory for go.work-only layouts.");
        Object.assign(env, { GOTOOLCHAIN: "local", GOWORK: "off", GOENV: "off", GOFLAGS: "" });
        const text = await command("go", ["version"], "Checking Go");
        const match = text.match(/\bgo(\d+\.\d+(?:\.\d+)?)\b/);
        if (!match) fail(`Could not determine installed Go version: ${safeText(text)}.`);
        const version = semver.coerce(match[1])!.version;
        for (const [directive, pattern] of [["go", /^\s*go\s+(\S+)/m], ["toolchain", /^\s*toolchain\s+(\S+)/m]] as const) {
          const value = goMod.match(pattern)?.[1];
          if (!value || (directive === "toolchain" && value === "default")) continue;
          const number = numericVersion(directive === "toolchain" ? value.replace(/^go/, "") : value, `go.mod ${directive}`);
          if (semver.lt(version, semver.coerce(number)!.version)) fail(`go.mod ${directive} requires Go ${number}; installed Go is ${version}. GOTOOLCHAIN=local prevents downloads.`);
        }
        // download ignores -mod=readonly. Give it private alternate metadata, never the checkout's files.
        const goSum = await file("go.sum"), scratch = await mkdtemp(join(tmpdir(), "herdr-jira-go-"));
        const modfile = join(scratch, "setup.mod"), sumfile = join(scratch, "setup.sum");
        try {
          await writeFile(modfile, goMod, { mode: 0o600, flag: "wx" });
          if (goSum !== undefined) await writeFile(sumfile, goSum, { mode: 0o600, flag: "wx" });
          await command("go", ["mod", "download", `-modfile=${modfile}`], "Downloading Go module dependencies");
          const metadata = async (path: string): Promise<string | undefined> => {
            try {
              const stat = await lstat(path);
              if (!stat.isFile() || stat.size > maxFile) fail("Go produced unsafe or oversized alternate module metadata.");
              return await readFile(path, "utf8");
            } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
          };
          if (await metadata(modfile) !== goMod || await metadata(sumfile) !== goSum) fail("Go dependency metadata needs updating. The checkout's go.mod/go.sum were left unchanged; update and commit them explicitly before setup.");
        } finally { await rm(scratch, { recursive: true, force: true }); }
        remaining();
        return { summary: "Go module dependencies downloaded with the installed local toolchain; module metadata preserved." };
      }
      // Never inherit an active environment or installer destination. Keep index/auth/cert settings.
      const inheritedEnvs = Object.entries(env).filter(([key, value]) => /^(?:VIRTUAL_ENV|CONDA_PREFIX(?:_\d+)?)$/i.test(key) && value).map(([, value]) => resolve(value!));
      env.PATH = (env.PATH ?? "").split(delimiter).filter(path => !inheritedEnvs.some(prefix => inside(prefix, resolve(path)))).join(delimiter);
      for (const key of Object.keys(env)) {
        if (/^(?:VIRTUAL_ENV|VIRTUAL_ENV_PROMPT|CONDA_PREFIX(?:_\d+)?|CONDA_DEFAULT_ENV|CONDA_SHLVL|PYTHON.*|__PYVENV_LAUNCHER__|_PYTHON_.*)$/i.test(key) || (/^PIP_/i.test(key) && !/^PIP_(?:INDEX_URL|EXTRA_INDEX_URL|NO_INDEX|FIND_LINKS|TRUSTED_HOST|CERT|CLIENT_CERT|PROXY|KEYRING_PROVIDER|CACHE_DIR|NO_CACHE_DIR|TIMEOUT|DEFAULT_TIMEOUT|RETRIES|NO_INPUT|REQUIRE_HASHES|PRE|ONLY_BINARY|NO_BINARY|PREFER_BINARY)$/i.test(key)) || (/^UV_/i.test(key) && !/^UV_(?:INDEX(?:_|$)|DEFAULT_INDEX$|EXTRA_INDEX_URL$|FIND_LINKS$|KEYRING_PROVIDER$|NATIVE_TLS$|HTTP_|CACHE_DIR$|OFFLINE$)/i.test(key)) || (/^POETRY_/i.test(key) && !/^POETRY_(?:HTTP_BASIC_|PYPI_TOKEN_|REPOSITORIES_)/i.test(key))) delete env[key];
      }
      Object.assign(env, { PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: devNull, PIP_USER: "false", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_PYTHON_DOWNLOADS: "never", POETRY_VIRTUALENVS_CREATE: "true", POETRY_VIRTUALENVS_IN_PROJECT: "true" });
      const pythonFile = await file(".python-version");
      const pythonVersion = pythonFile === undefined ? undefined : numericVersion(pythonFile, ".python-version");
      let configuredPython = config.python ?? "python3";
      if (!configuredPython || /[\r\n\0]/.test(configuredPython) || (!isAbsolute(configuredPython) && /[/\\]/.test(configuredPython))) fail("setup.python must name an installed executable or an absolute interpreter path.");
      if (manager === "uv") {
        if (!py || uvLock === undefined) fail("uv setup requires pyproject.toml and uv.lock; setup will not generate a lockfile.");
        await toolVersion("uv");
        if (!config.python && (pythonVersion !== undefined || at(py, "project", "requires-python") !== undefined)) {
          // --system excludes active/local virtualenvs, not already-installed uv-managed base Pythons.
          configuredPython = (await command("uv", ["python", "find", "--system", "--no-python-downloads", "--project", root], "Locating an installed project Python")).trim();
          if (!isAbsolute(configuredPython) || /[\r\n\0]/.test(configuredPython)) fail("uv did not find a valid installed base Python; select one with setup.python. No Python will be downloaded.");
        }
      }
      // -I ignores PYTHON* injection; realpath(prefix) proves the interpreter's actual environment.
      const probe = "import json,os,sys,sysconfig; print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'executable':os.path.abspath(sys.executable),'prefix':os.path.realpath(sys.prefix),'base_prefix':os.path.realpath(sys.base_prefix),'paths':{k:os.path.realpath(sysconfig.get_path(k)) for k in ('purelib','platlib','scripts','data')}}))";
      type Python = { version: string; executable: string; prefix: string; base_prefix: string; paths: Data };
      const pythonInfo = async (binary: string): Promise<Python> => {
        const data = json(await command(binary, ["-I", "-c", probe], "Checking installed Python"), "Python interpreter response");
        if (!semver.valid(String(data.version)) || !["executable", "prefix", "base_prefix"].every(key => typeof data[key] === "string" && isAbsolute(data[key] as string))) fail("Python did not report a valid interpreter and environment.");
        return data as Python;
      };
      const python = await pythonInfo(configuredPython);
      if (semver.major(python.version) !== 3) fail("Python setup requires an installed Python 3 interpreter.");
      if (python.prefix !== python.base_prefix) fail("The selected Python is itself in a virtual environment. Select an installed base interpreter with setup.python; inherited/shared environments are never reused.");
      checkPython(python.version, at(py, "project", "requires-python"), "project.requires-python");
      checkPython(python.version, at(py, "tool", "poetry", "dependencies", "python"), "tool.poetry.dependencies.python", true);
      if (pythonVersion !== undefined) checkRange(python.version, pythonVersion, ".python-version");
      const venv = join(root, ".venv"), venvPython = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      const verifyDirectory = async (): Promise<boolean> => {
        let stat;
        try { stat = await lstat(venv); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(venv) !== venv || !inside(checkout, venv)) fail("Refusing symlinked or outside-checkout .venv; use a real project-local environment.");
        const bin = join(venv, process.platform === "win32" ? "Scripts" : "bin");
        if (!inside(venv, await realpath(bin))) fail("Virtual environment executable directory escapes .venv.");
        const venvConfig = await file(".venv/pyvenv.cfg");
        if (!venvConfig || !/^include-system-site-packages\s*=\s*false\s*$/im.test(venvConfig) || /^include-system-site-packages\s*=\s*true\s*$/im.test(venvConfig)) fail("Local .venv must disable system-site-packages; shared environment packages are not allowed.");
        return true;
      };
      const verifyVenv = async (): Promise<void> => {
        if (!await verifyDirectory()) fail("Installer did not create the project-local .venv.");
        const info = await pythonInfo(venvPython);
        if (info.prefix !== venv || info.base_prefix === info.prefix) fail("The .venv interpreter does not actually belong to the canonical project-local virtual environment.");
        for (const key of ["purelib", "platlib", "scripts", "data"]) {
          const path = object(info.paths)[key];
          if (typeof path !== "string" || !isAbsolute(path) || !inside(venv, path)) fail(`Virtual environment ${key} installation path escapes .venv or cannot be verified.`);
        }
        if (!semver.eq(info.version, python.version)) fail(`Local .venv Python ${info.version} differs from selected interpreter ${python.version}; recreate it with the selected installed interpreter.`);
      };
      const existing = await verifyDirectory();
      if (existing) await verifyVenv();
      if (manager === "uv") {
        Object.assign(env, { UV_PROJECT_ENVIRONMENT: venv, UV_PYTHON: python.executable, UV_PYTHON_DOWNLOADS: "never" });
        const args = ["sync", "--locked", "--no-python-downloads", "--project", root, "--python", python.executable];
        if (nonempty(at(py, "dependency-groups", "dev")) || nonempty(at(py, "tool", "uv", "dev-dependencies"))) args.push("--dev");
        if (nonempty(at(py, "project", "optional-dependencies", "dev"))) args.push("--extra", "dev");
        await command("uv", args, "Installing uv dependencies (including declared dev)");
        await verifyVenv();
      } else if (manager === "poetry") {
        if (!py || poetryLock === undefined) fail("Poetry setup requires pyproject.toml and poetry.lock; setup will not generate a lockfile.");
        if (nonempty(at(py, "tool", "poetry", "requires-plugins"))) fail("Poetry project plugin prerequisites are unsupported; setup never bootstraps missing tooling/plugins.");
        const version = await toolVersion("poetry");
        const group = nonempty(at(py, "tool", "poetry", "group", "dev")), standardGroup = nonempty(at(py, "dependency-groups", "dev"));
        if (group && semver.lt(version, "1.2.0")) fail("Declared Poetry dev group requires installed Poetry >=1.2.");
        if (standardGroup && semver.lt(version, "2.2.0")) fail("Standard dependency-groups require installed Poetry >=2.2.");
        if (!existing) await command(python.executable, ["-I", "-m", "venv", venv], "Creating project-local Python environment");
        await verifyVenv();
        Object.assign(env, { VIRTUAL_ENV: venv, PATH: `${join(venv, process.platform === "win32" ? "Scripts" : "bin")}${delimiter}${env.PATH ?? ""}` });
        const verifyPoetry = async (): Promise<void> => {
          const selected = (await command("poetry", ["env", "info", "--path"], "Verifying Poetry environment")).trim();
          if (!isAbsolute(selected) || await realpath(selected) !== venv) fail("Poetry selected an outside/shared environment instead of the project-local .venv.");
        };
        await verifyPoetry();
        const args = ["install", "--no-interaction", "--no-plugins"];
        if (group || standardGroup) args.push("--with", "dev");
        if (nonempty(at(py, "project", "optional-dependencies", "dev")) || nonempty(at(py, "tool", "poetry", "extras", "dev"))) args.push("--extras", "dev");
        await command("poetry", args, "Installing Poetry dependencies (including declared dev)");
        await verifyPoetry(); await verifyVenv();
      } else {
        let paths: string[];
        if (config.requirements !== undefined) {
          if (!Array.isArray(config.requirements) || !config.requirements.length || !config.requirements.every(name => typeof name === "string" && !!name && !isAbsolute(name))) fail("setup.requirements must contain checkout-relative files.");
          paths = [];
          for (const name of config.requirements) {
            if (await file(name, checkout) === undefined) fail(`Configured requirements file is missing: ${name}.`);
            paths.push(await realpath(resolve(checkout, name)));
          }
        } else {
          if (requirements === undefined) fail("Requirements setup needs requirements.txt or explicit setup.requirements files.");
          const dev: string[] = [];
          for (const name of devRequirements) if (await file(name) !== undefined) dev.push(name);
          if (dev.length > 1) fail(`Ambiguous conventional dev requirements: ${dev.join(", ")}. Set setup.manager=requirements and explicit setup.requirements files.`);
          paths = [join(root, "requirements.txt"), ...dev.map(name => join(root, name))];
        }
        // pip includes can otherwise read remote/outside files that escaped the top-level override check.
        const visited = new Set<string>(), visiting = new Set<string>();
        let requirementBytes = 0;
        const validateRequirements = async (path: string): Promise<void> => {
          const source = await file(path);
          if (source === undefined) fail("A requirements/constraints include is missing.");
          const canonical = await realpath(path), identity = `${canonical}\0${dirname(path)}`;
          if (visiting.has(canonical)) fail("Cyclic requirements/constraints includes are unsupported.");
          if (visited.has(identity)) return;
          requirementBytes += Buffer.byteLength(source);
          if (visited.size + visiting.size >= 128 || visiting.size >= 32 || requirementBytes > maxFile) fail("Requirements includes exceed setup's bounded validation limit.");
          visiting.add(canonical);
          for (const original of source.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
            const line = original.replace(/\s+#.*$|^#.*$/g, "").trim().replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
              const value = env[key];
              if (!value || /\s/.test(value)) fail("Requirements environment expansion is missing or ambiguous; use explicit bounded requirements files.");
              return value;
            });
            if (!line) continue;
            if (/^(?:--(?:target|prefix|root|user|python|isolated)|-t)(?:[=\s]|$)/.test(line)) fail("Requirements attempt an unsafe pip installation target override.");
            const include = line.match(/^(?:--(?:requirement|constraint)(?:=|\s+)|-[rc]\s*)(.+)$/);
            if (include) {
              let name = include[1]!.trim();
              const quoted = name.match(/^([\"'])(.*)\1$/);
              if (quoted) name = quoted[2]!;
              else if (/\s/.test(name)) fail("Ambiguous requirements include; use one local file per -r/-c option.");
              if (/^[a-z][a-z0-9+.-]*:/i.test(name) || !name || name.includes("${")) fail("Remote or unresolved requirements includes are unsupported; use checkout-local files.");
              await validateRequirements(resolve(dirname(path), name));
            } else if (/(?:^|\s)(?:--(?:requirement|constraint)(?:=|\s|$)|-[rc])/.test(line)) fail("Ambiguous nested requirements option; use a separate -r/-c line.");
          }
          visiting.delete(canonical); visited.add(identity);
        };
        for (const path of paths) await validateRequirements(path);
        if (!existing) await command(python.executable, ["-I", "-m", "venv", venv], "Creating project-local Python environment");
        await verifyVenv();
        env.VIRTUAL_ENV = venv;
        env.PIP_REQUIRE_VIRTUALENV = "true";
        await command(venvPython, ["-I", "-m", "pip", "--version"], "Checking virtual environment pip");
        await append("pip configuration files disabled to prevent outside-environment install targets; index/auth environment settings retained.\n");
        await command(venvPython, ["-I", "-m", "pip", "install", ...paths.flatMap(path => ["-r", path])], "Installing requirements (including declared dev)");
        await verifyVenv();
      }
      remaining();
      return { summary: `${manager} dependencies installed, including declared dev dependencies, in project-local .venv.`, venv };
    } catch (error) {
      await append(`\nSetup failed: ${detailsOf(error)}\n`);
      throw error;
    } finally { await log.close(); }
  }
}

export const prepareDependencies = (request: SetupRequest): Promise<SetupResult> => new DependenciesInstaller().prepare(request);
