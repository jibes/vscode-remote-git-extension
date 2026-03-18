import * as vscode from 'vscode';
import { loadConfig, readLocalGitRemoteUrl } from './config';
import { SSHClient } from './sshClient';
import { RemoteGitProvider, FileNode, TreeNode } from './remoteGitProvider';
import { CommitInputViewProvider } from './commitInputView';
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Persistent tree shell
//
// The TreeView is created ONCE and never destroyed.  A thin shell provider
// delegates to the real RemoteGitProvider when connected and returns an empty
// tree otherwise.  This avoids two problems:
//   1. VS Code persists user-hidden state per view ID.  If we destroy and
//      recreate the TreeView on reconnect, VS Code keeps it hidden.
//   2. The multi-repo REPOSITORIES/CHANGES picker appears whenever two or
//      more SourceControl providers are active.  By using only a TreeView
//      (no SourceControl) we never trigger that mode.
// ---------------------------------------------------------------------------

class RemoteGitShell implements vscode.TreeDataProvider<TreeNode> {
    private _inner: RemoteGitProvider | undefined;
    private _listenerDisposable: vscode.Disposable | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    setProvider(p: RemoteGitProvider | undefined): void {
        this._listenerDisposable?.dispose();
        this._inner = p;
        if (p) {
            // Forward change events from the real provider to this shell's
            // emitter so the TreeView re-renders when git status updates.
            this._listenerDisposable = p.onDidChangeTreeData(() =>
                this._onDidChange.fire(),
            );
        }
        this._onDidChange.fire();
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        return this._inner!.getTreeItem(node);
    }

    getChildren(node?: TreeNode): TreeNode[] {
        return this._inner?.getChildren(node) ?? [];
    }
}

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

let provider: RemoteGitProvider | undefined;
let ssh: SSHClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // -------------------------------------------------------------------------
    // Debug logger — created once and reused; enabled/disabled by the setting
    // -------------------------------------------------------------------------

    let debugChannel: vscode.OutputChannel | undefined;

    const refreshLogger = (): void => {
        const enabled = vscode.workspace.getConfiguration('remoteGit').get<boolean>('debug', false);
        if (enabled) {
            if (!debugChannel) {
                debugChannel = vscode.window.createOutputChannel('Remote Git (Debug)');
                context.subscriptions.push(debugChannel);
            }
            logger.setLogFn(line => debugChannel!.appendLine(line));
            debugChannel.show(/* preserveFocus */ true);
            logger.log('Remote Git debug mode enabled');
        } else {
            logger.setLogFn(undefined);
        }
    };
    refreshLogger();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('remoteGit.debug')) {
                refreshLogger();
            }
        }),
    );

    // Create the shell and TreeView once — they live for the extension lifetime.
    const shell = new RemoteGitShell();
    const treeView = vscode.window.createTreeView('remoteGit.changesView', {
        treeDataProvider: shell,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Commit-message input webview — rendered in the "Remote Git" accordion
    // above the Changes tree view, similar to VS Code's native SCM input box.
    const commitInput = new CommitInputViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CommitInputViewProvider.viewId, commitInput),
    );

    const setMessage = (msg: string | undefined) => {
        treeView.message = msg;
    };

    const init = async (): Promise<void> => {
        provider?.dispose();
        ssh?.disconnect();
        provider = undefined;
        ssh = undefined;
        shell.setProvider(undefined);
        commitInput.setRemoteDescription(undefined);
        setMessage('Connecting…');

        logger.log('init: starting');

        // Read VS Code workspace settings so they can fill in defaults when no
        // config file sets these fields.
        const vsSettings = vscode.workspace.getConfiguration('remoteGit');

        let config;
        try {
            config = loadConfig(workspaceRoot, {
                pollInterval:  vsSettings.get<number>('pollInterval'),
                autoLocalPull: vsSettings.get<boolean>('autoLocalPull'),
            });
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Remote Git: ${String(err)}`);
            setMessage('Configuration error — check .vscode/remote-git.json');
            return;
        }

        if (!config) {
            const remoteUrl = readLocalGitRemoteUrl(workspaceRoot);
            logger.log(`init: no config resolved — git remote = ${remoteUrl ?? '(none)'}`);
            setMessage('No remote Git config found.');
            return;
        }

        logger.log(`init: config = ${JSON.stringify(config)}`);

        ssh = new SSHClient(config);
        try {
            await ssh.connect();
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `Remote Git: SSH connection to ${config.host} failed — ${String(err)}`,
            );
            setMessage(`SSH connection to ${config.host} failed`);
            return;
        }

        logger.log('init: SSH connection established');

        provider = new RemoteGitProvider(ssh, config, workspaceRoot);
        shell.setProvider(provider);
        setMessage(undefined); // clear message; tree content takes over

        // Show remote destination (user@host:path) in the accordion header.
        const port   = config.port ? `:${config.port}` : '';
        const remote = `${config.username}@${config.host}${port}:${config.remotePath}`;
        commitInput.setRemoteDescription(remote);
    };

    await init();

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.vscode/remote-git.json'),
    );
    watcher.onDidCreate(() => init());
    watcher.onDidChange(() => init());
    watcher.onDidDelete(() => {
        provider?.dispose();
        ssh?.disconnect();
        provider = undefined;
        ssh = undefined;
        shell.setProvider(undefined);
        commitInput.setRemoteDescription(undefined);
        setMessage('No remote Git config found.');
    });
    context.subscriptions.push(watcher);

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('remoteGit.refresh', () =>
            provider?.refresh(),
        ),
        vscode.commands.registerCommand('remoteGit.commit', async () => {
            if (!provider) { return; }
            const ok = await provider.commit(commitInput.currentMessage);
            if (ok) { commitInput.clearMessage(); }
        }),
        vscode.commands.registerCommand('remoteGit.stageAll', () =>
            provider?.stageAll(),
        ),
        vscode.commands.registerCommand('remoteGit.unstageAll', () =>
            provider?.unstageAll(),
        ),
        vscode.commands.registerCommand('remoteGit.discardAll', () =>
            provider?.discardAll(),
        ),
        vscode.commands.registerCommand('remoteGit.viewLog', () =>
            provider?.viewLog(),
        ),
        vscode.commands.registerCommand(
            'remoteGit.stageFile',
            (arg: FileNode | vscode.Uri) => {
                const p = resolveFilePath(arg);
                if (p) { provider?.stageFile(p); }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.unstageFile',
            (arg: FileNode | vscode.Uri) => {
                const p = resolveFilePath(arg);
                if (p) { provider?.unstageFile(p); }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.discardChanges',
            (arg: FileNode | vscode.Uri) => {
                const p = resolveFilePath(arg);
                if (p) { provider?.discardChanges(p); }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.openDiff',
            (arg: FileNode | vscode.Uri) => {
                const uri = resolveUri(arg);
                if (uri) { provider?.openDiff(uri); }
            },
        ),
    );
}

export function deactivate(): void {
    provider?.dispose();
    ssh?.disconnect();
    provider = undefined;
    ssh = undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFilePath(arg: FileNode | vscode.Uri | undefined): string | undefined {
    if (!arg) { return undefined; }
    if (arg instanceof FileNode) { return arg.file.relativePath; }
    if (arg instanceof vscode.Uri) { return decodeURIComponent(arg.path.replace(/^\//, '')); }
    return undefined;
}

function resolveUri(arg: FileNode | vscode.Uri | undefined): vscode.Uri | undefined {
    if (!arg) { return undefined; }
    if (arg instanceof FileNode) { return arg.resourceUri; }
    if (arg instanceof vscode.Uri) { return arg; }
    return undefined;
}
