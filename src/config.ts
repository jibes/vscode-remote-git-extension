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
    privateKeyPath?: string;
    pollInterval: number;
}

interface RawConfig {
    host?: string;
    port?: number;
    username?: string;
    remotePath?: string;
    autoLocalPull?: boolean;
    privateKeyPath?: string;
    identityFile?: string;  // accepted alias; normalised to privateKeyPath on merge
    pollInterval?: number;
}

export interface VSCodeSettings {
    pollInterval?: number;
    autoLocalPull?: boolean;
}

/**
 * Loads Remote Git config using a four-level priority chain:
 *  1. .vscode/remote-git.json   — explicit, wins over everything
 *  2. .vscode/remote-sync.json  — Mutagen/Remote Sync extension settings
 *  3. .vscode/sftp.json         — SFTP extension (natizyskunk.sftp) settings
 *  4. Local git remote (origin) — SSH URL parsed from `git remote get-url origin`
 *
 * Higher-priority sources override individual fields; they don't have to be
 * complete — e.g. remote-git.json can just override `remotePath` while
 * host/username come from the git remote.
 */
export function loadConfig(
    workspaceRoot: string,
    vsSettings?: VSCodeSettings,
): RemoteGitConfig | null {
    log(`loadConfig: workspaceRoot=${workspaceRoot}`);

    // Layer 4 (lowest): local git remote SSH URL
    const originUrl = readLocalGitRemoteUrl(workspaceRoot);
    log(`loadConfig: layer 4 (git remote) origin = ${originUrl ?? '(none)'}`);
    let merged: RawConfig = originUrl ? parseSSHUrl(originUrl) ?? {} : {};
    log(`loadConfig: layer 4 → ${JSON.stringify(merged)}`);

    // Layer 3: sftp.json
    merged = applyLayer(merged, path.join(workspaceRoot, '.vscode', 'sftp.json'), 'sftp.json');

    // Layer 2: remote-sync.json
    merged = applyLayer(merged, path.join(workspaceRoot, '.vscode', 'remote-sync.json'), 'remote-sync.json');

    // Layer 1 (highest): remote-git.json — our own format, merge all fields
    const gitConfigPath = path.join(workspaceRoot, '.vscode', 'remote-git.json');
    if (fs.existsSync(gitConfigPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(gitConfigPath, 'utf8')) as RawConfig;
            merged = { ...merged, ...raw };
            log(`loadConfig: layer 1 (remote-git.json) applied → ${JSON.stringify(raw)}`);
        } catch (err) {
            throw new Error(`Failed to parse .vscode/remote-git.json: ${err}`);
        }
    }

    if (!merged.host || !merged.username || !merged.remotePath) {
        const missing = (['host', 'username', 'remotePath'] as const)
            .filter(k => !merged[k])
            .join(', ');
        log(`loadConfig: incomplete — missing required fields: ${missing}`);
        return null;
    }

    const config: RemoteGitConfig = {
        host:          merged.host,
        port:          merged.port ?? 22,
        username:      merged.username,
        remotePath:    merged.remotePath.replace(/\/$/, ''),
        autoLocalPull: merged.autoLocalPull ?? vsSettings?.autoLocalPull ?? true,
        privateKeyPath: merged.privateKeyPath ?? merged.identityFile,
        pollInterval:  merged.pollInterval ?? vsSettings?.pollInterval ?? 5000,
    };
    log(`loadConfig: resolved → ${JSON.stringify(config)}`);
    return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads a third-party config file (sftp.json, remote-sync.json) and merges
 * the SSH connection fields it understands into `base`.  Both `privateKeyPath`
 * and `identityFile` are accepted; `privateKeyPath` takes precedence.
 */
function applyLayer(base: RawConfig, filePath: string, label: string): RawConfig {
    if (!fs.existsSync(filePath)) { return base; }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RawConfig;
        const fields = pickConnectionFields(raw);
        log(`loadConfig: ${label} applied → ${JSON.stringify(fields)}`);
        return { ...base, ...fields };
    } catch {
        log(`loadConfig: ${label} — parse error, skipping`);
        return base;
    }
}

/** Extracts SSH connection fields, normalising privateKeyPath/identityFile → privateKeyPath. */
function pickConnectionFields(raw: RawConfig): RawConfig {
    const out: RawConfig = {};
    if (raw.host)       { out.host = raw.host; }
    if (raw.port)       { out.port = raw.port; }
    if (raw.username)   { out.username = raw.username; }
    if (raw.remotePath) { out.remotePath = raw.remotePath; }
    const key = raw.privateKeyPath ?? raw.identityFile;
    if (key)            { out.privateKeyPath = key; }
    return out;
}

export function readLocalGitRemoteUrl(workspaceRoot: string): string | null {
    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) { return null; }
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
 *   [user@]host:relative/path       (SCP-style, stored as ~/relative/path)
 *
 * Returns null for non-SSH URLs (https://, git://, file://, …).
 */
export function parseSSHUrl(url: string): RawConfig | null {
    const localUser = os.userInfo().username;

    const sshMatch = url.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/[^?#]*)/);
    if (sshMatch) {
        const result: RawConfig = {
            username:   sshMatch[1] ?? localUser,
            host:       sshMatch[2],
            port:       sshMatch[3] ? parseInt(sshMatch[3], 10) : undefined,
            remotePath: sshMatch[4].replace(/\.git$/, '') || '/',
        };
        log(`parseSSHUrl: ssh:// → ${JSON.stringify(result)}`);
        return result;
    }

    if (url.includes('://')) {
        log(`parseSSHUrl: skipping non-SSH scheme URL`);
        return null;
    }

    const scpMatch = url.match(/^(?:([^@/]+)@)?([^:/]+):(.+)/);
    if (scpMatch) {
        const rawPath = scpMatch[3].replace(/\.git$/, '').trim();
        const result: RawConfig = {
            username:   scpMatch[1] ?? localUser,
            host:       scpMatch[2],
            remotePath: rawPath.startsWith('/') ? rawPath : `~/${rawPath}`,
        };
        log(`parseSSHUrl: SCP → ${JSON.stringify(result)}`);
        return result;
    }

    log(`parseSSHUrl: no match for URL ${url}`);
    return null;
}
