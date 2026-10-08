# Herdr Jira plugin

Press **Ctrl+B, then Shift+J**, paste a Jira key or browse URL, optionally edit **Branch**, leave **Harness: Pi** selected, and start work in a new worktree of the repository in your focused Herdr pane.

- Fetches the remote default branch's latest commit without changing your current checkout.
- Defaults the branch to the normalized ticket ID, e.g. `MAIL-1234`; you can edit it before launch.
- Validates ticket/branch syntax as you type and enables Start only when both are valid.
- Shows the resolved base and five phases: fetch **1/5**, worktree **2/5**, dependencies **3/5**, Pi startup **4/5**, instructions **5/5**, with total elapsed time in the existing status area.
- Automatically prepares unambiguous JavaScript, Python, or Go dependencies before Pi starts, including JS/Python development dependencies.
- Starts an interactive Pi session and asks it to read Jira through your existing MCP integration before coding.
- Reopens a previously dispatched ticket workspace rather than creating duplicates or repeating prompts.
- No polling, tunnels, Jira credentials, or Jira writes in the plugin.

## Requirements

- macOS or Linux, Node.js 22+, npm, Git, Herdr **0.9.3+**, and `pi` on the Herdr server's PATH.
- A running Herdr session and an accessible Git working tree with an `origin` remote (or an explicit repo override).
- Pi's model authentication, Jira MCP, and Herdr Pi integration configured for new interactive sessions.
- A compatible runtime and package manager on PATH (or `setup.python` for an installed interpreter). For an exact `packageManager: "pnpm@…"` pin, missing/mismatched pnpm is selected through an installed, up-to-date **Corepack**, which may download that version into a temporary cache. Other managers and all runtimes must already be installed; the plugin never changes global tool installations.
- Python handoff requires the installed `@earendil-works/pi-coding-agent` extension API and Pi's active built-in Bash tool. Startup requires a verified idle **bash, zsh, or sh** pane. Replacement/disabled Bash tools, fish/PowerShell launch panes, remote/container routing, and shared/global venvs are not supported.

The manifest declares popup placement. Herdr 0.9.3 accepts it even though `plugin pane open --help` does not list `--placement popup`; do not add that unsupported CLI flag.

## Install locally

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
herdr plugin link /Users/matleo/dev/herdr-jira-plugin
```

`plugin link` does not build the source. Rebuild after changes. To invoke without a shortcut:

```sh
herdr plugin action invoke local.jira.start
```

Add this binding to `~/.config/herdr/config.toml` (or your `HERDR_CONFIG_PATH`). Back up the file first and check for existing bindings. `prefix+shift+j` is unused in Herdr 0.9.3's defaults.

```toml
# Ctrl+B, then Shift+J. Keep default pane navigation unchanged.
[[keys.command]]
key = "prefix+shift+j"
type = "plugin_action"
command = "local.jira.start"
description = "Start Jira ticket"
```

If upgrading from the old shortcut, remove the plugin's `prefix+j` binding and its accompanying `focus_pane_down = "prefix+down"` override. This restores Herdr's default **Ctrl+B, then j** for pane-down.

Then run `herdr server reload-config`. On this development machine, the plugin is linked and this binding has been installed; the previous config was backed up alongside it as `config.toml.before-jira-*`.

## Form controls

The compact 64 × 13 popup shows the repository, a labeled ticket field, an editable Branch field, and a keyboard-operable Harness dropdown beside Start work. The popup paints a flat dark background rather than inheriting Herdr’s gradient. Focused controls use an accent color; invalid input keeps Start dimmed and inactive. Set `NO_COLOR` to disable ANSI styling. Enlarge small terminals to at least 44 × 11 interior cells before submitting; input is retained during resize.

- Paste a key (`MAIL-1234`) or an HTTPS Jira browse URL (`https://company.atlassian.net/browse/MAIL-1234`).
- **Branch** follows the normalized ticket ID until you edit it (marked `Branch*`). Manual edits survive ticket changes. A previously tracked ticket loads its saved branch automatically; that branch cannot be renamed through this form.
- **Ctrl+R on Branch:** restore the ticket-ID default and automatic following. **Ctrl+U:** clear the focused input.
- Branches accept literal Git names such as `feature/MAIL-1234`, preserving case, up to 240 UTF-8 bytes. Spaces, Git expressions, full refs, and invalid ref characters are rejected. Syntax validation does not check whether the Jira ticket exists.
- **Tab / Shift+Tab:** move between Ticket, Branch, Harness, and Start work.
- **Enter / Space on Harness:** expand or collapse the dropdown. Arrow keys select; Enter confirms. Pi is the only available option in this version.
- **Enter on Ticket, Branch, or Start work:** launch only when ticket/branch syntax is valid and saved-branch lookup has finished.
- **Ctrl+D after an error:** view full captured diagnostics. **↑/↓, Page Up/Down, Home/End:** scroll. **Ctrl+Y:** copy details. **Escape:** return to the form without losing input.
- **Escape:** collapse an expanded dropdown, otherwise cancel. **Ctrl+C:** cancel.
- **After dependency setup fails:** **Retry setup** reruns setup in the same worktree without fetching/creating again. **Ctrl+O** opens the preserved workspace. **Ctrl+S Start Pi anyway** explicitly bypasses dependencies for this launch only; Pi receives a warning to verify the environment/dependencies.
- Ctrl+S appears in the existing blank row below Branch only for a dependency setup error, never during work or in the details overlay. Editing Ticket/Branch/Harness or resetting Branch revokes recovery approval.
- **Ctrl+O after a partial-launch error:** close the popup and open the preserved workspace to handle Pi's login/trust/approval UI. Invalid checkout/pane identity or unverified Python environment binding cannot be bypassed with Ctrl+S.
- After resolving a startup screen, invoke the action again with the same ticket and choose **Resume launch**. It verifies the existing Pi before continuing; it does not blindly repeat a start or prompt.

Setup errors show a short, sanitized cause directly in the form, including when reopening a failed attempt. Error details preserve captured stdout/stderr (within the subprocess output limit), strip terminal controls, and redact URL credentials and common credential query parameters. Review diagnostics before sharing; arbitrary secret formats cannot all be detected. Copying is explicit, using `pbcopy` on macOS, `wl-copy` on Wayland, or `xclip` on X11; install the applicable utility on Linux. Clipboard failures leave the original details available for inspection.

Cancellation is disabled while a launch operation is in progress, because interruption can leave an uncertain Git/Herdr mutation. Commands have bounded timeouts. Normal terminal exit/signals abort the owned installer; a forced kill can still leave installer child processes and state/locks behind. Inspect the recorded PID **and installer children** before removing a lock or retrying. Locks are never stolen automatically.

Preview the form without Herdr, Git mutations, or an agent:

```sh
npm run preview
```

## Configuration

Find the user configuration directory:

```sh
herdr plugin config-dir local.jira
```

Optionally create `config.json` there:

```json
{
  "defaultJiraSite": "company.atlassian.net",
  "piArgs": [],
  "startupTimeoutMs": 30000,
  "fetchTimeoutMs": 60000,
  "setupTimeoutMs": 300000,
  "repos": {
    "/absolute/path/to/repository/.git": {
      "remote": "origin",
      "baseBranch": "main",
      "setup": {
        "manager": "requirements",
        "directory": "backend",
        "python": "/usr/local/bin/python3.12",
        "requirements": ["backend/requirements.txt", "backend/requirements-dev.txt"]
      }
    }
  }
}
```

All fields are optional. Without `baseBranch`, the plugin asks the configured remote for its current default branch. Without `remote`, it uses `origin`; it does not guess among other remotes. Repository keys are canonical absolute Git **common-directory** paths, shared by linked worktrees. Find one with:

```sh
git rev-parse --path-format=absolute --git-common-dir
```

The fetch uses a temporary operation-specific ref, captures the commit SHA, then removes that temporary ref. It does not pull, merge, stash, reset, fetch tags/submodules, prune, or update your checked-out/local default branch. Uncommitted files stay in the source checkout and are not copied.

`piArgs` accepts only `--model`, `--provider`, and `--thinking`, each followed by a value. This avoids accidentally selecting print mode, resuming unrelated work, supplying an initial prompt, or disabling integrations. Example: `["--model", "provider/model", "--thinking", "high"]`. No credentials belong here.

A pasted URL supplies its Jira hostname. A bare key uses `defaultJiraSite`, or asks Pi to resolve its default MCP site. Set `defaultJiraSite` if you use keys and URLs interchangeably: an unqualified key and a known-site URL are intentionally not silently equated. For compatibility with existing state, the same key on different Jira sites remains ambiguous within one repo, even with different custom branches; a collision requires manual resolution.

## Dependency setup

Without an override, setup examines the new checkout root and runs only a single unambiguous supported ecosystem. Conflicting managers, mixed ecosystems, missing required lockfiles, and unsupported layouts stop with diagnostics rather than guessing. A repository with no recognized dependency metadata needs no install. For a monorepo, explicitly choose `setup.directory` and `setup.manager`; automatic recursive installs are not performed.

| Ecosystem | Detection / behavior |
| --- | --- |
| npm | `package.json` plus `package-lock.json`/`npm-shrinkwrap.json`; `npm ci --include=dev` |
| pnpm | `package.json` plus `pnpm-lock.yaml`; frozen install with development dependencies; exact pins use installed pnpm when matching, otherwise private Corepack selection |
| Yarn | `package.json` plus `yarn.lock`; classic frozen or modern immutable install, development dependencies included |
| Bun | `package.json` plus `bun.lock`/`bun.lockb`; frozen install, rejects production-only config |
| uv | `pyproject.toml` plus `uv.lock`; locked sync into project-local `.venv`, including declared dev group/extras |
| Poetry | `pyproject.toml` plus `poetry.lock`; verifies project-local `.venv`, includes declared dev group/extras |
| requirements | `requirements.txt` plus one conventional `requirements-dev.txt`, `dev-requirements.txt`, or `requirements/dev.txt`; ambiguity requires explicit files |
| Go | `go.mod`; `go mod download` with `GOTOOLCHAIN=local`; `go.work`-only layouts need an explicit module directory |

Python uses only installed base interpreters and verifies project-local `.venv` ownership; it never reuses the form's active/shared environment or installs into system Python. uv can find an already-installed compatible interpreter. Poetry/requirements default to `python3`; use `setup.python` to select another installed interpreter. Conventional declared `dev` groups/extras are included, not every optional extra.

A private, per-launch Pi extension activates the venv **inside Pi's process**, so terminal prompt hooks cannot undo activation between commands. Before sending ticket instructions, the plugin verifies bare `python` through Pi's built-in Bash tool using its effective shell settings, then matches a private receipt to the live Pi PID, pane, cwd and venv. No checkout `activate` script is sourced, terminal exports injected, or global Pi settings changed. The parent terminal shell is left unchanged. Binding failures never authorize installer Retry/Skip; startup recovery only verifies the existing Pi and its receipt, without restarting it.

`setupTimeoutMs` bounds the entire dependency attempt (default 300000 ms; range 3001–1800000). `startupTimeoutMs` also bounds binding preparation and verification. Config fields are optional and existing configs remain valid. Per-repo `setup` accepts **only**:

- `manager`: `auto` (default), `none` (explicitly disable), `npm`, `pnpm`, `yarn`, `bun`, `uv`, `poetry`, `requirements`, or `go`.
- `directory`: contained checkout-relative project root (default `.`).
- `python`: one installed executable name or absolute executable path, not a shell command.
- `requirements`: explicit **checkout-relative** files with `manager: "requirements"`; include all desired dev files. Paths cannot escape the checkout, including through symlinks.

No arbitrary hook-command configuration is accepted. Runtime/package-manager declarations are checked where supported; unsupported version declarations stop rather than triggering a download. Exact pnpm pins are the only manager-download exception: if installed pnpm is missing, cannot be probed, or has a different version, setup runs `corepack pnpm@<exact-pin>` with a private temporary `COREPACK_HOME`. It preserves supported SHA integrity metadata, verifies the reported version, then uses that same cached manager for the frozen install. Acquisition shares the setup timeout/cancellation and diagnostics. The cache is removed after success/failure, so later mismatches download again. Corepack must already be installed (it is not bundled with Node 25+); missing/outdated Corepack, unavailable releases, registry or signature errors stop setup without falling back to a wrong version. Ranges, tags and custom manager URLs are not downloaded.

pnpm's own version switching is disabled with both legacy and pnpm 11+ guards, preventing package-manager lockfile updates during probes. Corepack auto-pinning, default-version updates, project `.corepack.env` loading and download prompts are disabled; inherited integrity-check bypasses are not used. Global pnpm, manifests and lockfiles are not changed by manager selection. There are no `corepack enable`/`prepare`/`use`, `nvm install`, `uv python install`, global package installs, global config edits, or secrets/config copying. Project Yarn binary overrides, pnpm runtime-management declarations, and Poetry plugin prerequisites stop with guidance rather than bootstrapping tools. Go downloads use disposable alternate metadata and fail if committed `go.mod`/`go.sum` need updates.

**Security:** dependency installation may run repository/package lifecycle scripts and Python build backends automatically, before Pi's ticket prompt. Only launch trusted repositories. Installs run with your user permissions, network access, and applicable inherited registry/auth settings; a worktree is not a sandbox, and plugin restrictions cannot constrain malicious install scripts. The plugin does not install missing runtimes or globally install managers; exact pinned pnpm may be downloaded privately through Corepack. Repository scripts remain arbitrary code.

Each attempt has a unique mode-0600 log under `HERDR_PLUGIN_STATE_DIR`, with bounded output (2 MiB) and URL/common credential redaction. Space is reserved for the final failure reason and bounded diagnostics, and omitted output is marked explicitly. Incomplete records cut by output limits are omitted rather than exposing credential fragments. Ctrl+D includes full captured diagnostics and the log path. Logs may still contain secrets that redaction cannot recognize: inspect before sharing. Installer output is never copied into the Pi prompt.

## Safety and recovery

State is stored as versioned JSON in the `HERDR_PLUGIN_STATE_DIR` supplied by Herdr. Lock errors include the exact local path; do not assume it is the config directory. The plugin uses atomic writes, a per-repository/ticket-ID lock (including across Jira sites), and a separate per-repository/branch lock. Existing state keys are retained for compatibility.

- Existing branches not owned by plugin state are **not** checked out or reset.
- A tracked ticket’s branch is immutable; changing the field cannot silently rename it or create another workspace. Durable branch ownership also blocks reassignment to another ticket after manual ref deletion.
- Branch reservation uses Git's create-only compare-and-swap; another process cannot silently substitute an existing branch.
- Create/setup/activation/start/prompt intent is saved before the operation. Git common-directory, checkout, branch, base SHA, pane/workspace and terminal identity are revalidated before and after setup.
- Version-1 records retain the existing launch phases and keys, with an optional setup journal. Legacy `created` records may prepare only after explicit Resume; legacy startup/ready/submitting/dispatched records never install beneath an agent.
- Failed/interrupted setup requires explicit Retry or Skip, not generic Resume. A skipped `created` record never grants persistent bypass after a crash. A saved successful `created` attempt is rerun only after explicit Resume, not treated as a permanent dependency cache. Startup recovery requires the matching live Pi receipt as well as disk validation; legacy disk-only venv records cannot authorize a prompt. Private extension/receipt files remain in state for recovery and Pi `/reload`; do not delete them while that Pi is running.
- Partial launches preserve the branch/worktree. Nothing is automatically deleted or forcibly cleaned.
- A prompt timeout or crash after submission intent is **uncertain delivery**, not permission to resend. Subsequent invocation opens the workspace for inspection without resubmission.
- Successful submission is not proof that coding started or finished. Check Pi's actual response.
- Saved workspace/pane IDs are checked against Git/worktree/terminal identity. A record from another Herdr socket/session is rejected.
- If the process dies holding a `.lock`, inspect its PID, any in-flight operation, and potentially surviving installer children before manually removing the lock. The plugin never steals a lock based only on age.
- If a launch stopped before it recorded a checkout, inspect Git branches/worktrees and the JSON record. Automatic recreation is intentionally blocked. Do not delete state until you understand whether creation/start/submission happened.

Pi is instructed to read the ticket first, ask about ambiguous requirements, run checks, and leave changes uncommitted. It is instructed not to commit, push, open a PR, modify Jira, or perform destructive cleanup. These are **behavioral instructions, not enforced permissions**. Worktrees do not sandbox filesystem/network access. Repository hooks/config and Pi extensions still run with your user permissions.

The plugin does not copy untracked `.pi` files or credentials into worktrees. Prefer user-level Jira MCP configuration; project-local configuration may require explicit trust in a fresh checkout. It never approves trust/authentication screens for you.

## Development and validation

```sh
npm run check
npm test
npm run build
npm run preview
```

Tests cover ticket/URL parsing, harness selection, bracketed paste chunking, form navigation, config validation, actual local-remote Git fetching, dirty-checkout preservation, linked-worktree identity, atomic branch reservation/state/locks, duplicate dispatch, collisions, partial startup, changed checkout identity, and uncertain prompt delivery. Setup tests additionally cover manager/runtime selection, development dependencies, contained environments, private diagnostics, activation proofs, interrupted journals, retry/skip serialization, stale actions, identity revalidation, and unchanged popup geometry. Herdr is mocked in automated launch tests; Git integration tests use disposable local repos.

Dependency runtime checks: offline local dev-only packages installed successfully with npm, pnpm, Yarn Classic, Bun, uv, Poetry and requirements; manifests/lockfiles remained unchanged. A live Corepack smoke selected pnpm 12.8.1 from installed 10.34.4, verified a SHA512 pin, installed a local dev dependency, preserved manifests/lockfiles and global defaults, and removed its private cache. Both matching pnpm 10 installs and pnpm 12 two-document lockfiles were also checked. A disposable live Herdr/Pi startup verified the actual built-in Bash interpreter and `VIRTUAL_ENV`, even with a zsh prompt hook clearing activation. All owned fixtures/workspaces were cleaned; no model or ticket prompt was sent in this check.

Earlier local runtime checks: manifest popup opening, PTY form interaction, and the production launcher’s fetch → exact-ID worktree → interactive Pi startup → duplicate reuse flow in disposable repositories, followed by cleanup. The final prompt call was intercepted in the launcher smoke test; no ticket task was submitted. **A real-ticket Jira MCP read and full coding handoff remain to be checked with a user-selected ticket.**

To uninstall locally:

```sh
herdr plugin unlink local.jira
```

Remove the shortcut if desired; default pane navigation is unchanged. Unlinking does not remove your source, ticket worktrees, plugin settings, or state. For launch-action errors, inspect `herdr plugin log list --plugin local.jira`.

See [PLAN.md](PLAN.md) for context and scope. Other harnesses, automatic Jira triggers, dashboards, remote-machine routing, and auto-cleanup are deferred.
