import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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
 */
export function loadConfig(workspaceRoot: string): RemoteGitConfig | null {
    // --- Layer 4 (lowest): local git remote SSH URL --------------------------
    let merged: RawConfig = parseLocalGitRemote(workspaceRoot) ?? {};

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
        } catch {
            // Ignore malformed sftp config
        }
    }

    // --- Layer 2: remote-sync.json -------------------------------------------
    const syncConfigPath = path.join(workspaceRoot, '.vscode', 'remote-sync.json');
    if (fs.existsSync(syncConfigPath)) {
        try {
            const raw: RawConfig = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
            // Only pick connection-relevant fields; leave behaviour fields to remote-git.json
            const syncFields: RawConfig = {};
            if (raw.host)         { syncFields.host = raw.host; }
            if (raw.port)         { syncFields.port = raw.port; }
            if (raw.username)     { syncFields.username = raw.username; }
            if (raw.remotePath)   { syncFields.remotePath = raw.remotePath; }
            if (raw.identityFile) { syncFields.identityFile = raw.identityFile; }
            merged = { ...merged, ...syncFields };
        } catch {
            // Ignore malformed sync config
        }
    }

    // --- Layer 1 (highest): remote-git.json ----------------------------------
    const gitConfigPath = path.join(workspaceRoot, '.vscode', 'remote-git.json');
    if (fs.existsSync(gitConfigPath)) {
        try {
            const raw: RawConfig = JSON.parse(fs.readFileSync(gitConfigPath, 'utf8'));
            merged = { ...merged, ...raw };
        } catch (err) {
            throw new Error(`Failed to parse .vscode/remote-git.json: ${err}`);
        }
    }

    if (!merged.host || !merged.username || !merged.remotePath) {
        return null;
    }

    return {
        host: merged.host,
        port: merged.port ?? 22,
        username: merged.username,
        remotePath: merged.remotePath.replace(/\/$/, ''),
        autoLocalPull: merged.autoLocalPull ?? true,
        identityFile: merged.identityFile,
        pollInterval: merged.pollInterval ?? 5000,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tries to extract SSH connection details from the local git remote named
 * "origin". Returns null if there is no local .git, no origin remote, or the
 * remote URL is not an SSH URL (e.g. https://github.com/…).
 */
function parseLocalGitRemote(workspaceRoot: string): RawConfig | null {
    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
        return null;
    }

    let remoteUrl: string;
    try {
        remoteUrl = execFileSync(
            'git',
            ['-C', workspaceRoot, 'remote', 'get-url', 'origin'],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
    } catch {
        return null;
    }

    return parseSSHUrl(remoteUrl);
}

/**
 * Parses SSH remote URL formats into connection fields.
 *
 * Supported formats:
 *   ssh://[user@]host[:port]/path
 *   [user@]host:/absolute/path      (SCP-style, absolute only)
 *
 * Returns null for non-SSH URLs (https://, git://, file://, relative SCP paths).
 */
export function parseSSHUrl(url: string): RawConfig | null {
    // ssh://[user@]host[:port]/path
    const sshMatch = url.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/[^?#]*)/);
    if (sshMatch) {
        return {
            username: sshMatch[1] ?? 'git',
            host: sshMatch[2],
            port: sshMatch[3] ? parseInt(sshMatch[3], 10) : undefined,
            remotePath: sshMatch[4].replace(/\.git$/, '') || '/',
        };
    }

    // SCP-style [user@]host:/absolute/path  (relative paths like host:repo are skipped —
    // we can't resolve them without knowing the remote home directory)
    const scpMatch = url.match(/^(?:([^@/]+)@)?([^:/]+):(\/[^?#]*)/);
    if (scpMatch) {
        return {
            username: scpMatch[1] ?? 'git',
            host: scpMatch[2],
            remotePath: scpMatch[3].replace(/\.git$/, ''),
        };
    }

    return null; // https://, file://, etc.
}
