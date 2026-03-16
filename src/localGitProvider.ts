import * as vscode from 'vscode';
import * as path from 'path';
import { LocalGitClient } from './localGitClient';
import { parseGitStatus, FileStatus } from './remoteGitProvider';

// ---------------------------------------------------------------------------
// Content provider for local-git:// URIs (HEAD and INDEX content only).
// The working-tree side of diffs always uses a real file:// URI so the
// diff editor is live and editable.
// ---------------------------------------------------------------------------

class LocalGitContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly client: LocalGitClient) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params = new URLSearchParams(uri.query);
        const ref = params.get('ref') ?? 'HEAD';
        const relativePath = decodeURIComponent(uri.path.replace(/^\//, ''));

        if (!relativePath) {
            return '';
        }

        const gitRef = ref === 'INDEX' ? `:${sq(relativePath)}` : `${ref}:${sq(relativePath)}`;
        const result = await this.client.git(`show ${gitRef}`);
        return result.code === 0 ? result.stdout : '';
    }

    invalidate(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

function localGitUri(relativePath: string, ref: string): vscode.Uri {
    return vscode.Uri.parse(
        `local-git://repo/${encodeURIComponent(relativePath)}?ref=${encodeURIComponent(ref)}`,
    );
}

// ---------------------------------------------------------------------------
// SCM provider
// ---------------------------------------------------------------------------

export class LocalGitProvider implements vscode.Disposable {
    private readonly scm: vscode.SourceControl;
    private readonly stagedGroup: vscode.SourceControlResourceGroup;
    private readonly changesGroup: vscode.SourceControlResourceGroup;
    private readonly untrackedGroup: vscode.SourceControlResourceGroup;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly contentProvider: LocalGitContentProvider;
    private readonly client: LocalGitClient;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        readonly repoPath: string,
    ) {
        this.client = new LocalGitClient(repoPath);

        this.scm = vscode.scm.createSourceControl(
            'local-git',
            'Local Git',
            vscode.Uri.file(repoPath),
        );
        this.scm.acceptInputCommand = {
            command: 'localGit.commit',
            title: 'Commit',
        };
        this.scm.inputBox.placeholder = 'Message (Ctrl+Enter to commit locally)';

        this.stagedGroup = this.scm.createResourceGroup('staged', 'Staged Changes');
        this.changesGroup = this.scm.createResourceGroup('changes', 'Changes');
        this.untrackedGroup = this.scm.createResourceGroup('untracked', 'Untracked');

        this.stagedGroup.hideWhenEmpty = true;
        this.changesGroup.hideWhenEmpty = true;
        this.untrackedGroup.hideWhenEmpty = true;

        this.statusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            9, // slightly lower priority than remote (10)
        );
        this.statusBar.command = 'localGit.checkoutBranch';
        this.statusBar.show();

        this.contentProvider = new LocalGitContentProvider(this.client);
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider('local-git', this.contentProvider),
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
        }, 5000);
    }

    async refresh(): Promise<void> {
        if (this.disposed) {
            return;
        }

        try {
            const [statusResult, branchResult] = await Promise.all([
                this.client.git('status --porcelain'),
                this.client.git('rev-parse --abbrev-ref HEAD'),
            ]);

            if (statusResult.code !== 0) {
                this._setStatus('$(error) Local Git: not a git repo');
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
            this._setStatus(`$(git-branch) local: ${branch}${count > 0 ? ` (${count})` : ''}`);
        } catch {
            this._setStatus('$(error) Local Git: error');
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
            `local-git://repo/${encodeURIComponent(file.relativePath)}` +
            `?group=${file.group}&status=${encodeURIComponent(file.statusCode)}`,
        );

        return {
            resourceUri,
            command: {
                command: 'localGit.openDiff',
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
                if (uri.scheme !== 'local-git') {
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
        await this.client.git(`add -- ${sq(relativePath)}`);
        await this.refresh();
    }

    async stageAll(): Promise<void> {
        await this.client.git('add -A');
        await this.refresh();
    }

    async unstageFile(relativePath: string): Promise<void> {
        await this.client.git(`restore --staged -- ${sq(relativePath)}`);
        await this.refresh();
    }

    async discardChanges(relativePath: string): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            `Discard local changes in ${path.basename(relativePath)}? This cannot be undone.`,
            { modal: true },
            'Discard Changes',
        );
        if (answer === 'Discard Changes') {
            await this.client.git(`restore -- ${sq(relativePath)}`);
            await this.refresh();
        }
    }

    async openDiff(resourceUri: vscode.Uri): Promise<void> {
        const params = new URLSearchParams(resourceUri.query);
        const group = params.get('group') ?? 'changes';
        const relativePath = decodeURIComponent(resourceUri.path.replace(/^\//, ''));

        const leftUri = localGitUri(relativePath, 'HEAD');
        let rightUri: vscode.Uri;
        let title: string;

        if (group === 'staged') {
            // HEAD vs index
            rightUri = localGitUri(relativePath, 'INDEX');
            title = `${path.basename(relativePath)} (Staged, local)`;
        } else {
            // HEAD vs live file — right side is the real file so the diff is live
            rightUri = vscode.Uri.file(path.join(this.repoPath, relativePath));
            title = `${path.basename(relativePath)} (Working Tree, local)`;
        }

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    async commit(): Promise<void> {
        const message = this.scm.inputBox.value.trim();
        if (!message) {
            vscode.window.showErrorMessage('Local Git: enter a commit message first');
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Committing locally…' },
            async () => {
                const result = await this.client.git(`commit -m ${sq(message)}`);
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Local Git commit failed: ${result.stderr.trim()}`);
                    return;
                }
                this.scm.inputBox.value = '';
                vscode.window.showInformationMessage('Local Git: commit successful');
                await this.refresh();
            },
        );
    }

    async push(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Pushing locally…' },
            async () => {
                const result = await this.client.git('push');
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Local Git push failed: ${result.stderr.trim()}`);
                    return;
                }
                vscode.window.showInformationMessage('Local Git: push successful');
                await this.refresh();
            },
        );
    }

    async pull(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Pulling locally…' },
            async () => {
                const result = await this.client.git('pull --rebase');
                if (result.code !== 0) {
                    vscode.window.showErrorMessage(`Local Git pull failed: ${result.stderr.trim()}`);
                    return;
                }
                vscode.window.showInformationMessage('Local Git: pull successful');
                await this.refresh();
            },
        );
    }

    async viewLog(): Promise<void> {
        const result = await this.client.git('log --oneline --graph --decorate -50');
        if (result.code !== 0) {
            vscode.window.showErrorMessage('Local Git: failed to retrieve log');
            return;
        }
        const doc = await vscode.workspace.openTextDocument({
            content: result.stdout,
            language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    async checkoutBranch(): Promise<void> {
        await this.client.git('fetch --prune');

        const [localResult, remoteResult] = await Promise.all([
            this.client.git('branch --format=%(refname:short)'),
            this.client.git('branch -r --format=%(refname:short)'),
        ]);

        const localBranches = localResult.stdout.split('\n').map(b => b.trim()).filter(Boolean);
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

        const result = await this.client.git(`checkout ${sq(selected.label)}`);
        if (result.code !== 0) {
            vscode.window.showErrorMessage(`Local Git checkout failed: ${result.stderr.trim()}`);
        } else {
            vscode.window.showInformationMessage(`Local Git: switched to ${selected.label}`);
            await this.refresh();
        }
    }

    async createBranch(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'New local branch name',
            validateInput: v => /^[a-zA-Z0-9_\-./]+$/.test(v) ? null : 'Invalid branch name',
        });

        if (!name) {
            return;
        }

        const result = await this.client.git(`checkout -b ${sq(name)}`);
        if (result.code !== 0) {
            vscode.window.showErrorMessage(`Local Git create branch failed: ${result.stderr.trim()}`);
        } else {
            vscode.window.showInformationMessage(`Local Git: created and switched to ${name}`);
            await this.refresh();
        }
    }

    // -------------------------------------------------------------------------

    dispose(): void {
        this.disposed = true;
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.contentProvider.dispose();
        this.statusBar.dispose();
        this.scm.dispose();
    }
}

// -------------------------------------------------------------------------
// Shared helpers (mirrors remoteGitProvider)
// -------------------------------------------------------------------------

function statusLabel(code: string): string {
    const labels: Record<string, string> = {
        M: 'Modified', A: 'Added', D: 'Deleted',
        R: 'Renamed', C: 'Copied', U: 'Unmerged', '?': 'Untracked',
    };
    return labels[code] ?? code;
}

function statusColor(code: string): vscode.ThemeColor | undefined {
    const map: Record<string, string> = {
        M: 'gitDecoration.modifiedResourceForeground',
        A: 'gitDecoration.addedResourceForeground',
        D: 'gitDecoration.deletedResourceForeground',
        R: 'gitDecoration.renamedResourceForeground',
        U: 'gitDecoration.conflictingResourceForeground',
        '?': 'gitDecoration.untrackedResourceForeground',
    };
    return map[code] ? new vscode.ThemeColor(map[code]) : undefined;
}

function sq(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
