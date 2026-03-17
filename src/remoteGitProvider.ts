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

// -------------------------------------------------------------------------
// Tree node types (classes so instanceof checks work in command handlers)
// -------------------------------------------------------------------------

export class GroupNode {
    constructor(
        public readonly group: 'staged' | 'changes' | 'untracked',
        public readonly files: FileStatus[],
    ) {}
}

export class FileNode {
    readonly resourceUri: vscode.Uri;

    constructor(
        public readonly file: FileStatus,
        host: string,
    ) {
        this.resourceUri = vscode.Uri.parse(
            `remote-git://${host}/${encodeURIComponent(file.relativePath)}` +
            `?group=${file.group}&status=${encodeURIComponent(file.statusCode)}`,
        );
    }
}

export type TreeNode = GroupNode | FileNode;

// -------------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------------

export class RemoteGitProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private stagedFiles: FileStatus[] = [];
    private changesFiles: FileStatus[] = [];
    private untrackedFiles: FileStatus[] = [];

    private readonly statusBar: vscode.StatusBarItem;
    private readonly contentProvider: RemoteGitContentProvider;
    private readonly disposables: vscode.Disposable[] = [];
    private logChannel: vscode.OutputChannel | undefined;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;

    constructor(
        private readonly ssh: SSHClient,
        private readonly config: RemoteGitConfig,
        private readonly workspaceRoot: string,
    ) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        this.statusBar.command = 'remoteGit.viewLog';
        this.statusBar.show();

        this.contentProvider = new RemoteGitContentProvider(ssh, config);
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider('remote-git', this.contentProvider),
            vscode.window.registerFileDecorationProvider(this._makeDecorationProvider()),
        );

        this._startPolling();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node instanceof GroupNode) {
            const labels = {
                staged: 'Staged Changes',
                changes: 'Changes',
                untracked: 'Untracked',
            };
            const item = new vscode.TreeItem(
                labels[node.group],
                vscode.TreeItemCollapsibleState.Expanded,
            );
            item.contextValue = node.group;
            item.description = String(node.files.length);
            return item;
        }

        // FileNode
        const { file, resourceUri } = node;
        const basename = path.basename(file.relativePath);
        const item = new vscode.TreeItem(basename, vscode.TreeItemCollapsibleState.None);
        if (file.statusCode === 'D') {
            // strikethrough was added to TreeItemLabel in VS Code 1.63 but may be
            // absent from older @types/vscode; assign via cast so it still applies at runtime.
            (item as { label: unknown }).label = { label: basename, strikethrough: true };
        }
        item.resourceUri = resourceUri;
        item.description =
            path.dirname(file.relativePath) === '.' ? '' : path.dirname(file.relativePath);
        item.tooltip = `${file.relativePath} — ${statusLabel(file.statusCode)}`;
        item.command = {
            command: 'remoteGit.openDiff',
            title: 'Open Changes',
            arguments: [resourceUri],
        };
        item.contextValue = `file-${file.group}`;
        return item;
    }

    getChildren(node?: TreeNode): TreeNode[] {
        if (!node) {
            const roots: GroupNode[] = [];
            if (this.stagedFiles.length)   { roots.push(new GroupNode('staged', this.stagedFiles)); }
            if (this.changesFiles.length)  { roots.push(new GroupNode('changes', this.changesFiles)); }
            if (this.untrackedFiles.length){ roots.push(new GroupNode('untracked', this.untrackedFiles)); }
            return roots;
        }
        if (node instanceof GroupNode) {
            return node.files.map(f => new FileNode(f, this.config.host));
        }
        return [];
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
        if (this.disposed) { return; }

        try {
            const [statusResult, branchResult] = await Promise.all([
                this.ssh.git('status --porcelain'),
                this.ssh.git('rev-parse --abbrev-ref HEAD'),
            ]);

            if (this.disposed) { return; }

            if (statusResult.code !== 0) {
                this._setStatus('$(error) Remote Git: not a git repo');
                return;
            }

            const files = parseGitStatus(statusResult.stdout);
            this.stagedFiles   = files.filter(f => f.group === 'staged');
            this.changesFiles  = files.filter(f => f.group === 'changes');
            this.untrackedFiles = files.filter(f => f.group === 'untracked');

            const branch = branchResult.stdout.trim() || 'HEAD';
            const count = files.length;
            this._setStatus(`$(git-branch) ${branch}${count > 0 ? ` (${count})` : ''}`);

            this._onDidChangeTreeData.fire();
        } catch {
            this._setStatus('$(error) Remote Git: disconnected');
        }
    }

    private _setStatus(text: string): void {
        this.statusBar.text = text;
    }

    // -------------------------------------------------------------------------
    // Decoration provider (colours + badges on file items)
    // -------------------------------------------------------------------------

    private _makeDecorationProvider(): vscode.FileDecorationProvider {
        return {
            provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
                if (uri.scheme !== 'remote-git') { return undefined; }
                const params = new URLSearchParams(uri.query);
                const statusCode = params.get('status');
                if (!statusCode) { return undefined; }
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

    async unstageAll(): Promise<void> {
        const paths = this.stagedFiles.map(f => f.relativePath);
        await this.ssh.git('restore --staged .');
        for (const p of paths) { this._invalidatePath(p, 'INDEX'); }
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
            this._invalidatePath(relativePath, 'WORKING');
            await this.refresh();
        }
    }

    async discardAll(): Promise<void> {
        const count = this.changesFiles.length;
        const label = count === 1 ? '1 file' : `${count} files`;
        const answer = await vscode.window.showWarningMessage(
            `Discard all changes in ${label}? This cannot be undone.`,
            { modal: true },
            'Discard All Changes',
        );
        if (answer === 'Discard All Changes') {
            const paths = this.changesFiles.map(f => f.relativePath);
            await this.ssh.git('restore .');
            for (const p of paths) { this._invalidatePath(p, 'WORKING'); }
            await this.refresh();
        }
    }

    async openDiff(resourceUri: vscode.Uri): Promise<void> {
        const params = new URLSearchParams(resourceUri.query);
        const group = params.get('group') ?? 'changes';
        const relativePath = decodeURIComponent(resourceUri.path.replace(/^\//, ''));
        const host = resourceUri.authority;

        const leftUri  = remoteGitUri(host, relativePath, 'HEAD');
        const rightUri = remoteGitUri(host, relativePath, group === 'staged' ? 'INDEX' : 'WORKING');
        const title    = group === 'staged'
            ? `${path.basename(relativePath)} (Staged)`
            : `${path.basename(relativePath)} (Working Tree)`;

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    async commit(): Promise<void> {
        const message = await vscode.window.showInputBox({
            prompt: 'Commit message',
            placeHolder: 'Message (Enter to commit on remote)',
            ignoreFocusOut: true,
        });

        if (message === undefined) { return; } // cancelled
        if (!message.trim()) {
            vscode.window.showErrorMessage('Remote Git: enter a commit message first');
            return;
        }

        await vscode.window.withProgress(
            { location: { viewId: 'remoteGit.changesView' }, title: 'Committing on remote…' },
            async () => {
                const stagedPaths = this.stagedFiles.map(f => f.relativePath);
                const result = await this.ssh.git(`commit -m ${shellQuote(message)}`);
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Remote Git commit failed: ${result.stderr.trim()}`);
                    return;
                }
                for (const p of stagedPaths) { this._invalidatePath(p, 'HEAD'); }
                vscode.window.showInformationMessage('Remote Git: commit successful');
                if (this.config.autoLocalPull) { this._tryLocalPull(); }
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
        if (!this.logChannel) {
            this.logChannel = vscode.window.createOutputChannel(
                `Remote Git Log — ${this.config.host}`,
            );
        }
        this.logChannel.clear();
        this.logChannel.append(result.stdout);
        this.logChannel.show(/* preserveFocus */ true);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private _invalidatePath(relativePath: string, ref: string): void {
        this.contentProvider.invalidate(remoteGitUri(this.config.host, relativePath, ref));
    }

    private _tryLocalPull(): void {
        const localGitDir = path.join(this.workspaceRoot, '.git');
        if (!fs.existsSync(localGitDir)) { return; }

        execFile(
            'git',
            ['-C', this.workspaceRoot, 'pull', '--rebase', '--autostash'],
            (err, _stdout, stderr) => {
                if (!err) { return; }
                const output = stderr.trim();
                const isConflict = output.includes('CONFLICT') || output.includes('conflict');
                if (isConflict) {
                    vscode.window.showWarningMessage(
                        'Remote Git: rebase conflict on local pull — resolve conflicts ' +
                        'then run `git rebase --continue`, or `git rebase --abort` to cancel.',
                    );
                } else {
                    vscode.window.showWarningMessage(
                        `Remote Git: local pull --rebase failed — ${output || err.message}`,
                    );
                }
            },
        );
    }

    dispose(): void {
        this.disposed = true;
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.disposables.forEach(d => d.dispose());
        this.logChannel?.dispose();
        this.contentProvider.dispose();
        this.statusBar.dispose();
    }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

export function parseGitStatus(output: string): FileStatus[] {
    const files: FileStatus[] = [];

    for (const rawLine of output.split('\n')) {
        if (rawLine.length < 4) { continue; }

        const x = rawLine[0];
        const y = rawLine[1];
        const rawPath = rawLine.slice(3).trim();

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
