# Herdr Jira plugin

Press **Ctrl+B, then J**, paste a Jira key or browse URL, leave **Harness: Pi** selected, and start work in a new worktree of the repository in your focused Herdr pane.

- Fetches the remote default branch's latest commit without changing your current checkout.
- Names the branch **exactly the ticket ID**, e.g. `MAIL-1234`.
- Starts an interactive Pi session and asks it to read Jira through your existing MCP integration before coding.
- Reopens a previously dispatched ticket workspace rather than creating duplicates or repeating prompts.
- No polling, tunnels, Jira credentials, or Jira writes in the plugin.

## Requirements

- macOS or Linux, Node.js 22+, npm, Git, Herdr **0.9.3+**, and `pi` on the Herdr server's PATH.
- A running Herdr session and an accessible Git working tree with an `origin` remote (or an explicit repo override).
- Pi's model authentication, Jira MCP, and Herdr Pi integration configured for new interactive sessions.

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

Add to the appropriate tables in `~/.config/herdr/config.toml` (or your `HERDR_CONFIG_PATH`). Back up the file first; do not duplicate an existing `[keys]` table.

```toml
[keys]
# Herdr's default prefix is Ctrl+B.
# Reassign the original prefix+j pane-down binding to avoid a conflict.
focus_pane_down = "prefix+down"

[[keys.command]]
key = "prefix+j"
type = "plugin_action"
command = "local.jira.start"
description = "Start Jira ticket"
```

Then run `herdr server reload-config`. On this development machine, the plugin is linked and this binding has been installed; the previous config was backed up alongside it as `config.toml.before-jira-*`.

## Form controls

The compact 64 × 12 popup shows the repository name, a labeled ticket field, and a keyboard-operable Harness dropdown beside the Start work button. Focused controls use an accent color; set `NO_COLOR` to disable ANSI styling. The footer switches to recovery help when a preserved workspace is available. On very small terminals, enlarge the form to at least 44 × 10 interior cells before submitting; your input is retained during resize.

- Paste a key (`MAIL-1234`) or an HTTPS Jira browse URL (`https://company.atlassian.net/browse/MAIL-1234`).
- **Tab / Shift+Tab:** move between Ticket, Harness, and Start work.
- **Enter / Space on Harness:** expand or collapse the dropdown. Arrow keys select; Enter confirms. Pi is the only available option in this version.
- **Enter on Ticket or Start work:** launch.
- **Escape:** collapse an expanded dropdown, otherwise cancel. **Ctrl+C:** cancel.
- **Ctrl+O after a partial-launch error:** close the popup and open the preserved workspace to handle Pi's login/trust/approval UI.
- After resolving a startup screen, invoke the action again with the same ticket and choose **Resume launch**. It verifies the existing Pi before continuing; it does not blindly repeat a start or prompt.

Cancellation is disabled while a launch operation is in progress, because interruption can leave an uncertain Git/Herdr mutation. Commands have bounded timeouts. Forcing the process closed leaves recovery state/locks for inspection.

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
  "repos": {
    "/absolute/path/to/repository/.git": {
      "remote": "origin",
      "baseBranch": "main"
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

A pasted URL supplies its Jira hostname. A bare key uses `defaultJiraSite`, or asks Pi to resolve its default MCP site. Set `defaultJiraSite` if you use keys and URLs interchangeably: an unqualified key and a known-site URL are intentionally not silently equated. The same key on different sites cannot share the exact-ID branch in one repo; a collision requires manual resolution.

## Safety and recovery

State is stored as versioned JSON in the `HERDR_PLUGIN_STATE_DIR` supplied by Herdr. Lock errors include the exact local path; do not assume it is the config directory. The plugin uses atomic writes and a per-repository/ticket-ID lock, including across Jira sites.

- Existing branches not owned by plugin state are **not** checked out or reset.
- Branch reservation uses Git's create-only compare-and-swap; another process cannot silently substitute an existing branch.
- Create/start/prompt intent is saved before the operation. The created checkout's repo, branch, and base are verified before starting Pi.
- Partial launches preserve the branch/worktree. Nothing is automatically deleted or forcibly cleaned.
- A prompt timeout or crash after submission intent is **uncertain delivery**, not permission to resend. Subsequent invocation opens the workspace for inspection without resubmission.
- Successful submission is not proof that coding started or finished. Check Pi's actual response.
- Saved workspace/pane IDs are checked against Git/worktree/terminal identity. A record from another Herdr socket/session is rejected.
- If the process dies holding a `.lock`, inspect its PID and any in-flight operation before manually removing the lock. The plugin never steals a lock based only on age.
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

Tests cover ticket/URL parsing, harness selection, bracketed paste chunking, form navigation, config validation, actual local-remote Git fetching, dirty-checkout preservation, linked-worktree identity, atomic branch reservation/state/locks, duplicate dispatch, collisions, partial startup, changed checkout identity, and uncertain prompt delivery. Herdr is mocked in automated launch tests; Git integration tests use disposable local repos.

Local runtime checks performed during implementation: manifest popup opening, PTY form interaction, and the production launcher’s fetch → exact-ID worktree → interactive Pi startup → duplicate reuse flow in disposable repositories, followed by cleanup. The final prompt call was intercepted in the launcher smoke test; no ticket task was submitted. **A real-ticket Jira MCP read and full coding handoff remain to be checked with a user-selected ticket.**

To uninstall locally:

```sh
herdr plugin unlink local.jira
```

Remove the shortcut and restore pane-down if desired. Unlinking does not remove your source, ticket worktrees, plugin settings, or state. For launch-action errors, inspect `herdr plugin log list --plugin local.jira`.

See [PLAN.md](PLAN.md) for context and scope. Other harnesses, automatic Jira triggers, dashboards, remote-machine routing, and auto-cleanup are deferred.
