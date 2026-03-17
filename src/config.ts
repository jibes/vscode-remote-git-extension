import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { log } from './logger';

export interface RemoteGitConfig {
    host: string;
    port: number;
    username: string;
    remotePath: string;
    autoLocalPull: boolean;
    identityFile?: string;
    pollInterval: number;
}

interface RawConfig {
    host?: string;
    port?: number;
    username?: string;
    remotePath?: string;
    autoLocalPull?: boolean;
    identityFile?: string;
    pollInterval?: number;
}

/**
 * VS Code workspace-settings that can act as defaults when no config file
 * sets these values.  Injected by extension.ts so that config.ts stays free
 * of the vscode API.
 */
export interface VSCodeSettings {
    pollInterval?: number;
    autoLocalPull?: boolean;
}

/**
 * Loads Remote Git config using a four-level priority chain:
 *
 *  1. .vscode/remote-git.json          — explicit, wins over everything
 *  2. .vscode/remote-sync.json         — Mutagen/Remote Sync extension settings
 *  3. .vscode/sftp.json                — SFTP extension (natizyskunk.sftp) settings
 *  4. Local git remote (origin)        — SSH URL parsed from `git remote get-url origin`
 *
 * Higher-priority sources override individual fields; they don't have to be
 * complete — e.g. remote-git.json can just override `remotePath` while
 * host/username come from the git remote.
 *
 * `vsSettings` provides user-friendly defaults for fields that no config file
 * sets (pollInterval, autoLocalPull).  These come from VS Code workspace
 * settings and are supplied by the caller to avoid importing the vscode module
 * here.
 */
export function loadConfig(
    workspaceRoot: string,
    vsSettings?: VSCodeSettings,
): RemoteGitConfig | null {
    log(`loadConfig: workspaceRoot=${workspaceRoot}`);

    // --- Layer 4 (lowest): local git remote SSH URL --------------------------
    let merged: RawConfig = parseLocalGitRemote(workspaceRoot) ?? {};
    log(`loadConfig: layer 4 (git remote) → ${JSON.stringify(merged)}`);

    // --- Layer 3: sftp.json --------------------------------------------------
    const sftpConfigPath = path.join(workspaceRoot, '.vscode', 'sftp.json');
    if (fs.existsSync(sftpConfigPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(sftpConfigPath, 'utf8')) as {
                host?: string;
                port?: number;
                username?: string;
                remotePath?: string;
                privateKeyPath?: string;
            };
            const sftpFields: RawConfig = {};
            if (raw.host)           { sftpFields.host = raw.host; }
            if (raw.port)           { sftpFields.port = raw.port; }
            if (raw.username)       { sftpFields.username = raw.username; }
            if (raw.remotePath)     { sftpFields.remotePath = raw.remotePath; }
            if (raw.privateKeyPath) { sftpFields.identityFile = raw.privateKeyPath; }
            merged = { ...merged, ...sftpFields };
            log(`loadConfig: layer 3 (sftp.json) applied → ${JSON.stringify(sftpFields)}`);
        } catch {
            log('loadConfig: layer 3 (sftp.json) — parse error, skipping');
        }
    }

    // --- Layer 2: remote-sync.json -------------------------------------------
    const syncConfigPath = path.join(workspaceRoot, '.vscode', 'remote-sync.json');
    if (fs.existsSync(syncConfigPath)) {
        try {
            const raw: RawConfig = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
            const syncFields: RawConfig = {};
            if (raw.host)         { syncFields.host = raw.host; }
            if (raw.port)         { syncFields.port = raw.port; }
            if (raw.username)     { syncFields.username = raw.username; }
            if (raw.remotePath)   { syncFields.remotePath = raw.remotePath; }
            if (raw.identityFile) { syncFields.identityFile = raw.identityFile; }
            merged = { ...merged, ...syncFields };
            log(`loadConfig: layer 2 (remote-sync.json) applied → ${JSON.stringify(syncFields)}`);
        } catch {
            log('loadConfig: layer 2 (remote-sync.json) — parse error, skipping');
        }
    }

    // --- Layer 1 (highest): remote-git.json ----------------------------------
    const gitConfigPath = path.join(workspaceRoot, '.vscode', 'remote-git.json');
    if (fs.existsSync(gitConfigPath)) {
        try {
            const raw: RawConfig = JSON.parse(fs.readFileSync(gitConfigPath, 'utf8'));
            merged = { ...merged, ...raw };
            log(`loadConfig: layer 1 (remote-git.json) applied → ${JSON.stringify(raw)}`);
        } catch (err) {
            throw new Error(`Failed to parse .vscode/remote-git.json: ${err}`);
        }
    }

    if (!merged.host || !merged.username || !merged.remotePath) {
        const missing = [
            !merged.host       && 'host',
            !merged.username   && 'username',
            !merged.remotePath && 'remotePath',
        ].filter(Boolean).join(', ');
        log(`loadConfig: incomplete — missing required fields: ${missing}`);
        return null;
    }

    const config: RemoteGitConfig = {
        host: merged.host,
        port: merged.port ?? 22,
        username: merged.username,
        remotePath: merged.remotePath.replace(/\/$/, ''),
        autoLocalPull: merged.autoLocalPull ?? vsSettings?.autoLocalPull ?? true,
        identityFile: merged.identityFile,
        pollInterval: merged.pollInterval ?? vsSettings?.pollInterval ?? 5000,
    };
    log(`loadConfig: resolved → ${JSON.stringify(config)}`);
    return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tries to extract SSH connection details from the local git remote named
 * "origin". Returns null if there is no local .git, no origin remote, the
 * remote URL is not an SSH URL, or the host is a known git hosting service.
 */
function parseLocalGitRemote(workspaceRoot: string): RawConfig | null {
    const url = readLocalGitRemoteUrl(workspaceRoot);
    log(`parseLocalGitRemote: origin URL = ${url ?? '(none)'}`);
    return url ? parseSSHUrl(url) : null;
}

/**
 * Git hosting services that are not SSH development servers.
 * Connections to these hosts are blocked — users must supply an explicit
 * `.vscode/remote-git.json` that points at their actual dev server instead.
 */
const HOSTING_SERVICES: Record<string, string> = {
    'github.com':     'GitHub',
    'gitlab.com':     'GitLab',
    'bitbucket.org':  'Bitbucket',
    'codeberg.org':   'Codeberg',
    'git.sr.ht':      'Sourcehut',
};

/**
 * Returns the display name of a known git hosting service if the URL belongs
 * to one, or null if it is an ordinary SSH server URL.
 */
export function detectHostingService(url: string): string | null {
    for (const [host, name] of Object.entries(HOSTING_SERVICES)) {
        if (url.includes(host)) {
            return name;
        }
    }
    return null;
}

/**
 * Returns the raw `origin` remote URL from the local git repo, or null.
 * Used by the extension to surface a helpful message when a hosting-service
 * URL is detected but no dev-server config exists.
 */
export function readLocalGitRemoteUrl(workspaceRoot: string): string | null {
    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
        return null;
    }
    try {
        return execFileSync(
            'git',
            ['-C', workspaceRoot, 'remote', 'get-url', 'origin'],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
    } catch {
        return null;
    }
}

/**
 * Parses SSH remote URL formats into connection fields.
 *
 * Supported formats:
 *   ssh://[user@]host[:port]/path
 *   [user@]host:/absolute/path      (SCP-style, absolute path)
 *   [user@]host:relative/path       (SCP-style, stored as ~/relative/path;
 *                                    the shell on the remote server resolves ~)
 *
 * When no username is present the local OS username is used as the default
 * (matching the behaviour of plain `ssh host` and `git clone host:path`).
 *
 * Returns null for:
 *   - non-SSH URLs (https://, git://, file://, …)
 *   - known git hosting services (GitHub, GitLab, Bitbucket, …) — these
 *     are not SSH dev servers; require explicit .vscode/remote-git.json
 */
export function parseSSHUrl(url: string): RawConfig | null {
    const localUser = os.userInfo().username;

    // ssh://[user@]host[:port]/path
    const sshMatch = url.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/[^?#]*)/);
    if (sshMatch) {
        const host = sshMatch[2];
        if (HOSTING_SERVICES[host]) {
            log(`parseSSHUrl: blocked — ${host} is a known hosting service`);
            return null;
        }
        const result: RawConfig = {
            username: sshMatch[1] ?? localUser,
            host,
            port: sshMatch[3] ? parseInt(sshMatch[3], 10) : undefined,
            remotePath: sshMatch[4].replace(/\.git$/, '') || '/',
        };
        log(`parseSSHUrl: ssh:// → ${JSON.stringify(result)}`);
        return result;
    }

    // URLs with any other scheme (https://, git://, file://, …) — skip.
    if (url.includes('://')) {
        log(`parseSSHUrl: skipping non-SSH scheme URL`);
        return null;
    }

    // SCP-style [user@]host:path  (absolute or relative)
    const scpMatch = url.match(/^(?:([^@/]+)@)?([^:/]+):(.+)/);
    if (scpMatch) {
        const host = scpMatch[2];
        if (HOSTING_SERVICES[host]) {
            log(`parseSSHUrl: blocked — ${host} is a known hosting service`);
            return null;
        }
        const rawPath = scpMatch[3].replace(/\.git$/, '').trim();
        // Absolute path (/foo/bar): use as-is.
        // Relative path (foo/bar): prefix with ~/ — the remote shell expands it.
        const remotePath = rawPath.startsWith('/') ? rawPath : `~/${rawPath}`;
        const result: RawConfig = {
            username: scpMatch[1] ?? localUser,
            host,
            remotePath,
        };
        log(`parseSSHUrl: SCP → ${JSON.stringify(result)}`);
        return result;
    }

    log(`parseSSHUrl: no match for URL ${url}`);
    return null; // unrecognised format
}
