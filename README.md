# Remote Git — VSCode Extension

A native-feeling Source Control panel that operates against a **remote `.git` directory over SSH**. No local clone required. When a local clone is present it acts as a parallel interface, keeping local history in sync after each commit.

---

## How It Works

The extension registers as a standard VSCode SCM provider. Every git operation (status, stage, commit, push, pull, log, branch) runs on the server via SSH:

```
ssh user@host "git -C /var/www/projectname <command>"
```

Git status is polled on a short interval so the SCM panel stays current. Clicking any file opens a VSCode diff editor — both sides are streamed from the server on demand.

---

## Setup

### 1. Install dependencies

```bash
cd vscode-remote-git-extension
npm install
npm run compile
```

### 2. Create `.vscode/remote-git.json` in your project

```json
{
  "host": "your.server.com",
  "port": 22,
  "username": "ubuntu",
  "remotePath": "/var/www/projectname",
  "autoLocalPull": true
}
```

Commit this file to the repository so the whole team shares the same connection settings.

### 3. SSH authentication

The extension tries the following private keys (in order):

1. `identityFile` from the config (if specified)
2. `~/.ssh/id_ed25519`
3. `~/.ssh/id_ecdsa`
4. `~/.ssh/id_rsa`

If no key is found it prompts for a password. Using `ssh-agent` is recommended for keyless UX.

---

## Integration with Remote Sync

If `.vscode/remote-sync.json` is present (e.g. from a Mutagen sync extension), Remote Git reads `host`, `port`, `username`, and `remotePath` from that file automatically. You only need `.vscode/remote-git.json` if the git remote path differs from the sync path, or to override individual fields.

---

## SCM Panel

```
REMOTE GIT  [ fix login validation     ]  [✓ Commit]
│
├── Staged Changes
│   └── index.php              M
│
├── Changes
│   ├── src/Auth.php           M
│   ├── templates/login.php    M
│   └── config/routes.php      M
│
└── Untracked
    └── src/NewHelper.php      ?
```

### Title bar actions

| Icon | Action |
|------|--------|
| $(refresh) | Refresh status |
| $(add) | Stage all changes |
| $(arrow-down) | Pull (--rebase) |
| $(arrow-up) | Push |
| … menu | View log, Checkout branch, Create branch |

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
| Right (unstaged) | `cat <remotePath>/<file>` (live working tree) |
| Right (staged) | `git show :<file>` (index content) |

---

## Supported Operations

| Action | Remote command |
|--------|----------------|
| Stage file | `git add <path>` |
| Stage all | `git add -A` |
| Unstage file | `git restore --staged <path>` |
| Discard changes | `git restore <path>` |
| Commit | `git commit -m "<message>"` |
| Push | `git push` |
| Pull | `git pull --rebase` |
| View log | `git log --oneline --graph --decorate -50` |
| Checkout branch | `git checkout <branch>` |
| Create branch | `git checkout -b <branch>` |

---

## Post-Commit Local Sync

After every remote commit, if a local `.git` directory is detected, the extension runs:

```bash
git -C <workspaceRoot> pull --rebase
```

This advances local history so blame, log, and history browsing reflect the latest commits. Conflicts are structurally impossible — Mutagen has already synced file contents, so the local working tree already matches the incoming commit.

Set `"autoLocalPull": false` in `.vscode/remote-git.json` to disable.

---

## Configuration Reference

`.vscode/remote-git.json`:

```json
{
  "host": "your.server.com",       // required
  "port": 22,                       // optional, default 22
  "username": "ubuntu",             // required
  "remotePath": "/var/www/project", // required — must be an absolute path
  "autoLocalPull": true,            // optional, default true
  "identityFile": "~/.ssh/id_rsa",  // optional — override SSH key path
  "pollInterval": 5000              // optional — ms between status polls
}
```

VSCode settings (`settings.json`):

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteGit.pollInterval` | `5000` | Poll interval in milliseconds |
| `remoteGit.autoLocalPull` | `true` | Auto pull local clone after remote commit |

---

## Architecture

```
src/
├── extension.ts          — Activation, command registration, lifecycle
├── config.ts             — Loads remote-git.json / remote-sync.json
├── sshClient.ts          — SSH connection wrapper (ssh2)
├── remoteGitProvider.ts  — VSCode SCM provider, polling, git operations
└── diffContentProvider.ts — TextDocumentContentProvider for remote-git:// URIs
```
