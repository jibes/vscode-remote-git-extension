import * as fs from 'fs';
import * as path from 'path';

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
 * Loads Remote Git config from .vscode/remote-git.json.
 * Falls back to .vscode/remote-sync.json for connection details if present,
 * allowing shared base settings without duplication.
 */
export function loadConfig(workspaceRoot: string): RemoteGitConfig | null {
    const gitConfigPath = path.join(workspaceRoot, '.vscode', 'remote-git.json');
    const syncConfigPath = path.join(workspaceRoot, '.vscode', 'remote-sync.json');

    let merged: RawConfig = {};

    // Load remote-sync.json first as base connection info
    if (fs.existsSync(syncConfigPath)) {
        try {
            const syncData: RawConfig = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
            merged.host = syncData.host;
            merged.port = syncData.port;
            merged.username = syncData.username;
            merged.remotePath = syncData.remotePath;
            merged.identityFile = syncData.identityFile;
        } catch {
            // Ignore malformed sync config
        }
    }

    // remote-git.json overrides everything
    if (fs.existsSync(gitConfigPath)) {
        try {
            const gitData: RawConfig = JSON.parse(fs.readFileSync(gitConfigPath, 'utf8'));
            merged = { ...merged, ...gitData };
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
        remotePath: merged.remotePath.replace(/\/$/, ''), // strip trailing slash
        autoLocalPull: merged.autoLocalPull ?? true,
        identityFile: merged.identityFile,
        pollInterval: merged.pollInterval ?? 5000,
    };
}
