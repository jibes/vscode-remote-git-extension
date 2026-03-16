import * as vscode from 'vscode';
import { SSHClient } from './sshClient';
import { RemoteGitConfig } from './config';

/**
 * Provides file content for the remote-git:// URI scheme used in diff editors.
 *
 * URI format:
 *   remote-git://<host>/<relative-path>?ref=<REF>
 *
 * Supported refs:
 *   HEAD     — content from `git show HEAD:<path>`
 *   WORKING  — content from `cat <remotePath>/<path>` (live working tree)
 *   INDEX    — content from `git show :<path>` (staged/index content)
 *   <sha>    — content from `git show <sha>:<path>`
 */
export class RemoteGitContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly ssh: SSHClient,
        private readonly config: RemoteGitConfig,
    ) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params = new URLSearchParams(uri.query);
        const ref = params.get('ref') ?? 'HEAD';
        // uri.path starts with '/', drop it to get the relative path
        const relativePath = decodeURIComponent(uri.path.replace(/^\//, ''));

        if (!relativePath) {
            return '';
        }

        try {
            if (ref === 'WORKING') {
                const absPath = `${this.config.remotePath}/${relativePath}`;
                const result = await this.ssh.exec(`cat ${shellQuote(absPath)}`);
                return result.code === 0 ? result.stdout : '';
            }

            if (ref === 'INDEX') {
                // Staged content from git index
                const result = await this.ssh.git(`show :${shellQuote(relativePath)}`);
                return result.code === 0 ? result.stdout : '';
            }

            // HEAD or specific commit SHA
            const result = await this.ssh.git(`show ${ref}:${shellQuote(relativePath)}`);
            return result.code === 0 ? result.stdout : '';
        } catch {
            return '';
        }
    }

    /**
     * Signals that the content for a URI has changed (e.g. after a stage/unstage).
     */
    invalidate(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

/**
 * Build a remote-git:// URI for use with the content provider.
 */
export function remoteGitUri(host: string, relativePath: string, ref: string): vscode.Uri {
    return vscode.Uri.parse(
        `remote-git://${host}/${encodeURIComponent(relativePath)}?ref=${encodeURIComponent(ref)}`,
    );
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
