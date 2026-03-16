# Remote Git — VSCode Extension

Adds a **Remote Git** accordion to the VSCode Source Control sidebar that operates against a remote `.git` directory over SSH. No local clone required. The built-in VSCode git panel handles local history as normal — this extension sits alongside it.

---

## How It Works

Every git operation runs on the server via SSH:

```
ssh user@host "git -C /var/www/projectname <command>"
```

Git status is polled on a short interval so the panel stays current. Clicking any file opens a VSCode diff editor — both sides are streamed from the server on demand.

---

## Setup

### 1. Build the extension

```bash
npm install
npm run compile
# or: vsce package  →  installs remote-git-x.x.x.vsix
```

### 2. Connection config

The extension resolves connection details from three sources in priority order — higher sources win, and they can be partial (e.g. override just `remotePath` while host/username come from a lower layer):

| Priority | Source | Notes |
|----------|--------|-------|
| 1 (highest) | `.vscode/remote-git.json` | Explicit config, committed to repo |
| 2 | `.vscode/remote-sync.json` | [Remote Sync / Mutagen](https://marketplace.visualstudio.com/items?itemName=Ablaze.remote-sync) extension settings |
| 3 (fallback) | Local git remote `origin` | SSH URL parsed from `git remote get-url origin` |

**No config file needed** if your workspace is already a local clone of an SSH remote — the extension reads `origin` automatically.

`.vscode/remote-git.json` example (only fields that differ from lower layers are required):

```json
{
  "host": "your.server.com",
  "port": 22,
  "username": "ubuntu",
  "remotePath": "/var/www/projectname",
  "autoLocalPull": true,
  "identityFile": "~/.ssh/id_rsa",
  "pollInterval": 5000
}
```

Recognised SSH remote URL formats for the git remote fallback:

```
ssh://ubuntu@myserver.com:22/var/www/project
git@myserver.com:/var/www/project
ubuntu@myserver.com:/var/www/project
```

HTTPS remotes (GitHub, GitLab, etc.) are ignored and the extension stays dormant.

### 3. SSH authentication

Keys tried in order:

1. `identityFile` from config
2. `~/.ssh/id_ed25519`
3. `~/.ssh/id_ecdsa`
4. `~/.ssh/id_rsa`

Falls back to a password prompt if no key is found. `ssh-agent` is recommended.

---

## SCM Panel

The Remote Git accordion appears in the Source Control sidebar alongside the built-in git panel:

```
▼ SOURCE CONTROL          ← built-in git (local)
▼ REMOTE GIT (host)       ← this extension
  │
  ├── Staged Changes
  │   └── index.php              M
  ├── Changes
  │   ├── src/Auth.php           M
  │   └── config/routes.php      M
  └── Untracked
      └── src/NewHelper.php      ?
```

### Title bar

| Icon | Action |
|------|--------|
| `$(refresh)` | Refresh status |
| `$(add)` | Stage all changes |
| `…` menu | View log |

### Per-file inline actions (hover)

| Group | Actions |
|-------|---------|
| Changes | Open diff · Stage · Discard |
| Staged Changes | Open diff · Unstage |
| Untracked | Stage |

---

## Diff View

Clicking a file opens a standard VSCode diff editor. Both sides are fetched from the server on demand:

| Side | Source |
|------|--------|
| Left | `git show HEAD:<file>` |
| Right — unstaged | `cat <remotePath>/<file>` (live working tree) |
| Right — staged | `git show :<file>` (index content) |

---

## Supported Operations

| Action | Remote command |
|--------|----------------|
| Stage file | `git add <path>` |
| Stage all | `git add -A` |
| Unstage file | `git restore --staged <path>` |
| Discard changes | `git restore <path>` |
| Commit | `git commit -m "<message>"` |
| View log | `git log --oneline --graph --decorate -50` |

The log opens in a dedicated **Output Channel** (`Remote Git Log — <host>`) — read-only, no save prompt, refreshed on each call.

---

## Post-Commit Local Sync

After every remote commit, if a local `.git` directory is detected the extension runs:

```bash
git -C <workspaceRoot> pull --rebase
```

This advances local history so blame, log, and history browsing in GitLens or the built-in git panel reflect the latest commits. Conflicts are structurally impossible — file contents are already in sync via Mutagen before the pull happens.

Disable with `"autoLocalPull": false` in `.vscode/remote-git.json`.

---

## Configuration Reference

All fields are optional when a lower-priority source already provides them.

| Field | Default | Description |
|-------|---------|-------------|
| `host` | — | SSH hostname or IP |
| `port` | `22` | SSH port |
| `username` | — | SSH username |
| `remotePath` | — | Absolute path to the project on the server |
| `autoLocalPull` | `true` | Pull local clone after each remote commit |
| `identityFile` | auto | Path to SSH private key |
| `pollInterval` | `5000` | ms between status polls |

---

## Architecture

```
src/
├── extension.ts           — Activation, command registration, lifecycle
├── config.ts              — Three-level config (remote-git.json > remote-sync.json > git remote)
├── sshClient.ts           — SSH connection wrapper (ssh2)
├── remoteGitProvider.ts   — VSCode SCM provider, polling, git operations
└── diffContentProvider.ts — TextDocumentContentProvider for remote-git:// URIs
```
