import { constants } from "node:fs";
import { access, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { WorkflowError } from "./errors.js";
import { run, type Run } from "./process.js";
import type { EnvironmentBinding, EnvironmentTarget } from "./setup-types.js";

export const pythonContamination = ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "PYTHONSTARTUP", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"] as const;
export interface EnvironmentPaths { checkout: string; venv: string; bin: string }
export interface PythonEvidence { pythonPrefix: string; pythonCwd: string; pythonExecutable: string }
export interface BashEvidence extends PythonEvidence { virtualEnv: string; pathFirst: string; noUserSite: string; contaminated: boolean }
export interface EnvironmentProof extends BashEvidence {
  version: 1; nonce: string; piPid: number; shellPid: number; piPathFirst: string;
  checkout: string; venv: string; workspaceId: string; paneId: string; terminalId: string;
}
export function safeArgument(value: string): string {
  if (!value || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new WorkflowError("Environment activation rejects empty values and control characters.");
  return value;
}
export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return !!child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}
export async function environmentPaths(checkout: string, venv: string): Promise<EnvironmentPaths> {
  safeArgument(checkout); safeArgument(venv);
  if (!isAbsolute(checkout) || !isAbsolute(venv)) throw new WorkflowError("Environment checkout and venv paths must be absolute.");
  const root = safeArgument(await realpath(checkout)), environment = safeArgument(await realpath(venv));
  if (!inside(root, environment)) throw new WorkflowError("The Python venv must remain inside the target checkout; external venv symlinks are not allowed.");
  if (!(await stat(root)).isDirectory() || !(await stat(environment)).isDirectory()) throw new WorkflowError("The checkout and Python venv must be directories.");
  const bin = join(environment, "bin");
  if (bin.includes(":")) throw new WorkflowError("The Python venv path contains ':' and cannot be represented safely in PATH.");
  if (await realpath(bin) !== bin || !(await stat(bin)).isDirectory()) throw new WorkflowError("The venv bin directory cannot be a symlink.");
  const configuration = await lstat(join(environment, "pyvenv.cfg"));
  if (!configuration.isFile() || configuration.isSymbolicLink()) throw new WorkflowError("The venv must contain a regular pyvenv.cfg file.");
  await access(join(bin, "python"), constants.X_OK);
  try { await access(join(bin, "pi"), constants.X_OK); }
  catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return { checkout: root, venv: environment, bin };
    throw error;
  }
  throw new WorkflowError("The venv provides an executable named pi and would shadow the coding harness. Remove that conflict before activation.");
}
export function candidateEnvironment(paths: EnvironmentPaths, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // /reload runs the factory again: keep one leading venv bin, not one per reload.
  const path = [paths.bin, ...(inherited.PATH ?? "").split(":").filter(entry => entry !== paths.bin)].join(":");
  const env: NodeJS.ProcessEnv = { ...inherited, VIRTUAL_ENV: paths.venv, PATH: path, PYTHONNOUSERSITE: "1" };
  for (const key of pythonContamination) delete env[key];
  return env;
}
export function assertPython(evidence: unknown, paths: EnvironmentPaths): asserts evidence is PythonEvidence {
  const value = evidence as PythonEvidence | null;
  if (!value || value.pythonPrefix !== paths.venv || value.pythonCwd !== paths.checkout || !["python", "python3"].some(name => value.pythonExecutable === join(paths.bin, name))) {
    throw new WorkflowError("Python's actual interpreter does not belong to the target venv/checkout.");
  }
}
export function assertBashEvidence(evidence: unknown, paths: EnvironmentPaths): asserts evidence is BashEvidence {
  assertPython(evidence, paths);
  const value = evidence as BashEvidence;
  // Pi may prepend its private tools bin; actual bare-python resolution is authoritative.
  if (value.virtualEnv !== paths.venv || typeof value.pathFirst !== "string" || !value.pathFirst || value.noUserSite !== "1" || value.contaminated !== false) throw new WorkflowError("Pi's Bash backend did not inherit the uncontaminated Python environment.");
}
export const pythonProbeScript = "import json,os,sys; print(json.dumps({'pythonPrefix':os.path.realpath(sys.prefix),'pythonCwd':os.path.realpath(os.getcwd()),'pythonExecutable':os.path.abspath(sys.executable),'virtualEnv':os.environ.get('VIRTUAL_ENV'),'pathFirst':os.environ.get('PATH','').split(':')[0],'noUserSite':os.environ.get('PYTHONNOUSERSITE'),'contaminated':any(k in os.environ for k in " + JSON.stringify(pythonContamination) + ")}))";
export async function inspectPython(paths: EnvironmentPaths, binary: string, env: NodeJS.ProcessEnv, timeout: number, execute: Run = run): Promise<PythonEvidence> {
  const output = await execute(binary, ["-B", "-c", pythonProbeScript], { cwd: paths.checkout, env, timeout });
  let evidence: unknown;
  try { evidence = JSON.parse(output); }
  catch { throw new WorkflowError("Python did not return valid environment evidence.", false, output); }
  assertPython(evidence, paths);
  return evidence;
}
export async function verifyCandidate(paths: EnvironmentPaths, timeout = 10_000, execute: Run = run): Promise<PythonEvidence> {
  return inspectPython(paths, join(paths.bin, "python"), candidateEnvironment(paths, process.env), timeout, execute);
}
export async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) throw new WorkflowError("The environment binding directory is not private and canonical.");
}
export async function validateBinding(target: EnvironmentTarget, binding: EnvironmentBinding): Promise<void> {
  const directory = dirname(binding.extensionPath), state = await realpath(target.stateDirectory);
  if (binding.version !== 1 || !/^[a-f0-9]{64}$/.test(binding.nonce) || !Number.isSafeInteger(binding.shellPid) || binding.shellPid <= 0 || binding.extensionPath !== join(directory, "extension.mjs") || binding.proofPath !== join(directory, "proof.json") || !inside(state, directory) || inside(target.checkout, directory) || directory === target.checkout) throw new WorkflowError("The private Pi environment binding paths or nonce are invalid.");
  await privateDirectory(directory);
  await readPrivateFile(binding.extensionPath);
}
export async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 16 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new WorkflowError("The environment receipt/extension is not a private, bounded regular file.");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function clearProof(path: string): Promise<void> {
  await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
export async function publishProof(path: string, proof: EnvironmentProof): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const text = JSON.stringify(proof) + "\n";
  if (Buffer.byteLength(text) > 16 * 1024) throw new WorkflowError("Environment receipt is too large.");
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.chmod(0o600); await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
