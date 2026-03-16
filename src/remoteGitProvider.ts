import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { SSHClient } from './sshClient';
import { RemoteGitConfig } from './config';
import { RemoteGitContentProvider, remoteGitUri } from './diffContentProvider';

export interface FileStatus {
    relativePath: string;
    /** Single-char git status code: M A D R C U ? */
    statusCode: string;
    group: 'staged' | 'changes' | 'untracked';
}

export class RemoteGitProvider implements vscode.Disposable {
    private readonly scm: vscode.SourceControl;
    private readonly stagedGroup: vscode.SourceControlResourceGroup;
    private readonly changesGroup: vscode.SourceControlResourceGroup;
    private readonly untrackedGroup: vscode.SourceControlResourceGroup;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly contentProvider: RemoteGitContentProvider;
    // Fix: own disposables list so they're cleaned up when THIS provider is
    // disposed, not when the extension deactivates. Avoids duplicate scheme
    // registrations when init() recreates the provider on config reload.
    private readonly disposables: vscode.Disposable[] = [];
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;

    constructor(
        private readonly ssh: SSHClient,
        private readonly config: RemoteGitConfig,
        private readonly workspaceRoot: string,
    ) {
        this.scm = vscode.scm.createSourceControl(
            'remote-git',
            `Remote Git (${config.host})`,
        );
        this.scm.acceptInputCommand = {
            command: 'remoteGit.commit',
            title: 'Commit',
        };
        this.scm.inputBox.placeholder = 'Message (Ctrl+Enter to commit on remote)';

        this.stagedGroup = this.scm.createResourceGroup('staged', 'Staged Changes');
        this.changesGroup = this.scm.createResourceGroup('changes', 'Changes');
        this.untrackedGroup = this.scm.createResourceGroup('untracked', 'Untracked');

        this.stagedGroup.hideWhenEmpty = true;
        this.changesGroup.hideWhenEmpty = true;
        this.untrackedGroup.hideWhenEmpty = true;

        this.statusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            10,
        );
        this.statusBar.command = 'remoteGit.checkoutBranch';
        this.statusBar.show();

        this.contentProvider = new RemoteGitContentProvider(ssh, config);
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider('remote-git', this.contentProvider),
            vscode.window.registerFileDecorationProvider(this._makeDecorationProvider()),
        );

        this._startPolling();
    }

    // -------------------------------------------------------------------------
    // Polling
    // -------------------------------------------------------------------------

    private _startPolling(): void {
        this.refresh().catch(() => undefined);
        this.pollTimer = setInterval(() => {
            if (!this.disposed) {
                this.refresh().catch(() => undefined);
            }
        }, this.config.pollInterval);
    }

    async refresh(): Promise<void> {
        if (this.disposed) {
            return;
        }

        try {
            const [statusResult, branchResult] = await Promise.all([
                this.ssh.git('status --porcelain'),
                this.ssh.git('rev-parse --abbrev-ref HEAD'),
            ]);

            // Fix: check disposed again after async — the provider may have
            // been torn down while waiting for the SSH response.
            if (this.disposed) {
                return;
            }

            if (statusResult.code !== 0) {
                this._setStatus('$(error) Remote Git: not a git repo');
                return;
            }

            const files = parseGitStatus(statusResult.stdout);

            this.stagedGroup.resourceStates = files
                .filter(f => f.group === 'staged')
                .map(f => this._makeResourceState(f));

            this.changesGroup.resourceStates = files
                .filter(f => f.group === 'changes')
                .map(f => this._makeResourceState(f));

            this.untrackedGroup.resourceStates = files
                .filter(f => f.group === 'untracked')
                .map(f => this._makeResourceState(f));

            const branch = branchResult.stdout.trim() || 'HEAD';
            const count = files.length;
            this._setStatus(`$(git-branch) ${branch}${count > 0 ? ` (${count})` : ''}`);
        } catch {
            this._setStatus('$(error) Remote Git: disconnected');
        }
    }

    private _setStatus(text: string): void {
        this.statusBar.text = text;
    }

    // -------------------------------------------------------------------------
    // Resource states
    // -------------------------------------------------------------------------

    private _makeResourceState(file: FileStatus): vscode.SourceControlResourceState {
        const resourceUri = vscode.Uri.parse(
            `remote-git://${this.config.host}/${encodeURIComponent(file.relativePath)}` +
            `?group=${file.group}&status=${encodeURIComponent(file.statusCode)}`,
        );

        return {
            resourceUri,
            command: {
                command: 'remoteGit.openDiff',
                title: 'Open Changes',
                arguments: [resourceUri],
            },
            decorations: {
                tooltip: `${file.relativePath} — ${statusLabel(file.statusCode)}`,
                strikeThrough: file.statusCode === 'D',
                faded: file.group === 'untracked',
            },
        };
    }

    private _makeDecorationProvider(): vscode.FileDecorationProvider {
        return {
            provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
                if (uri.scheme !== 'remote-git') {
                    return undefined;
                }
                const params = new URLSearchParams(uri.query);
                const statusCode = params.get('status');
                if (!statusCode) {
                    return undefined;
                }
                return {
                    badge: statusCode,
                    color: statusColor(statusCode),
                    tooltip: statusLabel(statusCode),
                };
            },
        };
    }

    // -------------------------------------------------------------------------
    // Git operations
    // -------------------------------------------------------------------------

    async stageFile(relativePath: string): Promise<void> {
        await this.ssh.git(`add -- ${shellQuote(relativePath)}`);
        this._invalidatePath(relativePath, 'INDEX');
        await this.refresh();
    }

    async stageAll(): Promise<void> {
        await this.ssh.git('add -A');
        await this.refresh();
    }

    async unstageFile(relativePath: string): Promise<void> {
        await this.ssh.git(`restore --staged -- ${shellQuote(relativePath)}`);
        this._invalidatePath(relativePath, 'INDEX');
        await this.refresh();
    }

    async discardChanges(relativePath: string): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            `Discard changes in ${path.basename(relativePath)}? This cannot be undone.`,
            { modal: true },
            'Discard Changes',
        );
        if (answer === 'Discard Changes') {
            await this.ssh.git(`restore -- ${shellQuote(relativePath)}`);
            // Fix: invalidate WORKING so any open diff view refreshes its
            // right-hand side to show the now-restored content.
            this._invalidatePath(relativePath, 'WORKING');
            await this.refresh();
        }
    }

    async openDiff(resourceUri: vscode.Uri): Promise<void> {
        const params = new URLSearchParams(resourceUri.query);
        const group = params.get('group') ?? 'changes';
        const relativePath = decodeURIComponent(resourceUri.path.replace(/^\//, ''));
        const host = resourceUri.authority;

        const leftUri = remoteGitUri(host, relativePath, 'HEAD');
        const rightUri = remoteGitUri(
            host,
            relativePath,
            group === 'staged' ? 'INDEX' : 'WORKING',
        );
        const title = group === 'staged'
            ? `${path.basename(relativePath)} (Staged)`
            : `${path.basename(relativePath)} (Working Tree)`;

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    async commit(): Promise<void> {
        const message = this.scm.inputBox.value.trim();
        if (!message) {
            vscode.window.showErrorMessage('Remote Git: enter a commit message first');
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Committing on remote…' },
            async () => {
                // Snapshot staged paths before committing so we can invalidate HEAD
                const stagedPaths = this.stagedGroup.resourceStates.map(
                    r => decodeURIComponent(r.resourceUri.path.replace(/^\//, '')),
                );

                const result = await this.ssh.git(`commit -m ${shellQuote(message)}`);
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Remote Git commit failed: ${result.stderr.trim()}`);
                    return;
                }

                this.scm.inputBox.value = '';
                // Fix: invalidate HEAD for every file that was just committed so
                // open "HEAD vs WORKING" diff editors refresh their left side.
                for (const p of stagedPaths) {
                    this._invalidatePath(p, 'HEAD');
                }
                vscode.window.showInformationMessage('Remote Git: commit successful');

                if (this.config.autoLocalPull) {
                    this._tryLocalPull();
                }
                await this.refresh();
            },
        );
    }

    async push(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Pushing…' },
            async () => {
                const result = await this.ssh.git('push');
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Remote Git push failed: ${result.stderr.trim()}`);
                    return;
                }
                vscode.window.showInformationMessage('Remote Git: push successful');
                await this.refresh();
            },
        );
    }

    async pull(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Pulling…' },
            async () => {
                const result = await this.ssh.git('pull --rebase');
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Remote Git pull failed: ${result.stderr.trim()}`);
                    return;
                }
                vscode.window.showInformationMessage('Remote Git: pull successful');
                await this.refresh();
            },
        );
    }

    async viewLog(): Promise<void> {
        const result = await this.ssh.git('log --oneline --graph --decorate -50');
        if (result.code !== 0) {
            vscode.window.showErrorMessage('Remote Git: failed to retrieve log');
            return;
        }

        const doc = await vscode.workspace.openTextDocument({
            content: result.stdout,
            language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    async checkoutBranch(): Promise<void> {
        // Fix: handle fetch failure — warn but still show the cached branch list
        // rather than silently showing a potentially stale list.
        const fetchResult = await this.ssh.git('fetch --prune');
        if (fetchResult.code !== 0) {
            vscode.window.showWarningMessage(
                `Remote Git: fetch failed — branch list may be stale (${fetchResult.stderr.trim()})`,
            );
        }

        const [localResult, remoteResult] = await Promise.all([
            this.ssh.git('branch --format=%(refname:short)'),
            this.ssh.git('branch -r --format=%(refname:short)'),
        ]);

        const localBranches = localResult.stdout
            .split('\n')
            .map(b => b.trim())
            .filter(Boolean);

        const localSet = new Set(localBranches);

        const remoteOnlyNames = remoteResult.stdout
            .split('\n')
            .map(b => b.trim())
            .filter(b => b && !b.endsWith('/HEAD'))
            .map(b => b.replace(/^[^/]+\//, ''))
            .filter(b => !localSet.has(b));

        const items: vscode.QuickPickItem[] = [
            ...localBranches.map(b => ({
                label: b,
                description: 'local',
                iconPath: new vscode.ThemeIcon('git-branch'),
            })),
            ...remoteOnlyNames.map(b => ({
                label: b,
                description: 'remote',
                iconPath: new vscode.ThemeIcon('cloud'),
            })),
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select branch to checkout',
            matchOnDescription: true,
        });

        if (!selected) {
            return;
        }

        const checkoutResult = await this.ssh.git(`checkout ${shellQuote(selected.label)}`);
        if (checkoutResult.code !== 0) {
            vscode.window.showErrorMessage(
                `Remote Git checkout failed: ${checkoutResult.stderr.trim()}`,
            );
        } else {
            vscode.window.showInformationMessage(`Remote Git: switched to ${selected.label}`);
            await this.refresh();
        }
    }

    async createBranch(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'New branch name',
            validateInput: v =>
                /^[a-zA-Z0-9_\-./]+$/.test(v) ? null : 'Invalid branch name',
        });

        if (!name) {
            return;
        }

        const result = await this.ssh.git(`checkout -b ${shellQuote(name)}`);
        if (result.code !== 0) {
            vscode.window.showErrorMessage(
                `Remote Git create branch failed: ${result.stderr.trim()}`,
            );
        } else {
            vscode.window.showInformationMessage(`Remote Git: created and switched to ${name}`);
            await this.refresh();
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Tells the content provider to re-fetch this path/ref combination. */
    private _invalidatePath(relativePath: string, ref: string): void {
        this.contentProvider.invalidate(
            remoteGitUri(this.config.host, relativePath, ref),
        );
    }

    private _tryLocalPull(): void {
        const localGitDir = path.join(this.workspaceRoot, '.git');
        if (!fs.existsSync(localGitDir)) {
            return;
        }

        execFile(
            'git',
            ['-C', this.workspaceRoot, 'pull', '--rebase'],
            (err) => {
                if (err) {
                    vscode.window.showWarningMessage(
                        `Remote Git: local pull --rebase failed — ${err.message}`,
                    );
                }
            },
        );
    }

    // -------------------------------------------------------------------------

    dispose(): void {
        this.disposed = true;
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        // Fix: dispose our own registrations (content provider + decoration provider)
        // so they don't outlive this provider instance on config reload.
        this.disposables.forEach(d => d.dispose());
        this.contentProvider.dispose();
        this.statusBar.dispose();
        this.scm.dispose();
    }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

export function parseGitStatus(output: string): FileStatus[] {
    const files: FileStatus[] = [];

    for (const rawLine of output.split('\n')) {
        if (rawLine.length < 4) {
            continue;
        }

        const x = rawLine[0];
        const y = rawLine[1];
        const rawPath = rawLine.slice(3).trim();

        // Staged renames in porcelain v1 look like "old/path -> new/path"
        const filePath = rawPath.includes(' -> ')
            ? rawPath.split(' -> ')[1].trim()
            : rawPath;

        if (x === '?' && y === '?') {
            files.push({ relativePath: filePath, statusCode: '?', group: 'untracked' });
            continue;
        }

        if (x !== ' ' && x !== '?') {
            files.push({ relativePath: filePath, statusCode: x, group: 'staged' });
        }

        if (y !== ' ' && y !== '?') {
            files.push({ relativePath: filePath, statusCode: y, group: 'changes' });
        }
    }

    return files;
}

function statusLabel(code: string): string {
    const labels: Record<string, string> = {
        M: 'Modified', A: 'Added', D: 'Deleted',
        R: 'Renamed', C: 'Copied', U: 'Unmerged', '?': 'Untracked',
    };
    return labels[code] ?? code;
}

function statusColor(code: string): vscode.ThemeColor | undefined {
    const colorMap: Record<string, string> = {
        M: 'gitDecoration.modifiedResourceForeground',
        A: 'gitDecoration.addedResourceForeground',
        D: 'gitDecoration.deletedResourceForeground',
        R: 'gitDecoration.renamedResourceForeground',
        U: 'gitDecoration.conflictingResourceForeground',
        '?': 'gitDecoration.untrackedResourceForeground',
    };
    return colorMap[code] ? new vscode.ThemeColor(colorMap[code]) : undefined;
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
