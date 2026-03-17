import * as vscode from 'vscode';
import { loadConfig } from './config';
import { SSHClient } from './sshClient';
import { RemoteGitProvider, FileNode } from './remoteGitProvider';

let provider: RemoteGitProvider | undefined;
let ssh: SSHClient | undefined;
let treeView: vscode.TreeView<unknown> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    const init = async (): Promise<void> => {
        provider?.dispose();
        treeView?.dispose();
        ssh?.disconnect();
        provider = undefined;
        treeView = undefined;
        ssh = undefined;
        vscode.commands.executeCommand('setContext', 'remoteGit.active', false);

        let config;
        try {
            config = loadConfig(workspaceRoot);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Remote Git: ${String(err)}`);
            return;
        }

        if (!config) {
            return;
        }

        ssh = new SSHClient(config);
        try {
            await ssh.connect();
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `Remote Git: SSH connection to ${config.host} failed — ${String(err)}`,
            );
            return;
        }

        provider = new RemoteGitProvider(ssh, config, workspaceRoot);
        treeView = vscode.window.createTreeView('remoteGit.changesView', {
            treeDataProvider: provider,
            showCollapseAll: true,
        });
        context.subscriptions.push(treeView);
        vscode.commands.executeCommand('setContext', 'remoteGit.active', true);
    };

    await init();

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.vscode/remote-git.json'),
    );
    watcher.onDidCreate(() => init());
    watcher.onDidChange(() => init());
    watcher.onDidDelete(() => {
        provider?.dispose();
        treeView?.dispose();
        ssh?.disconnect();
        provider = undefined;
        treeView = undefined;
        ssh = undefined;
        vscode.commands.executeCommand('setContext', 'remoteGit.active', false);
    });
    context.subscriptions.push(watcher);

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('remoteGit.refresh', () =>
            provider?.refresh(),
        ),
        vscode.commands.registerCommand('remoteGit.commit', () =>
            provider?.commit(),
        ),
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
    treeView?.dispose();
    ssh?.disconnect();
    provider = undefined;
    treeView = undefined;
    ssh = undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the remote-relative file path from either a FileNode (passed by
 * view/item/context commands) or a plain Uri (passed programmatically).
 */
function resolveFilePath(arg: FileNode | vscode.Uri | undefined): string | undefined {
    if (!arg) { return undefined; }
    if (arg instanceof FileNode) { return arg.file.relativePath; }
    if (arg instanceof vscode.Uri) { return decodeURIComponent(arg.path.replace(/^\//, '')); }
    return undefined;
}

/**
 * Extracts the remote-git:// Uri from either a FileNode or a plain Uri.
 * Used by openDiff which needs the full URI (host + ref query params).
 */
function resolveUri(arg: FileNode | vscode.Uri | undefined): vscode.Uri | undefined {
    if (!arg) { return undefined; }
    if (arg instanceof FileNode) { return arg.resourceUri; }
    if (arg instanceof vscode.Uri) { return arg; }
    return undefined;
}
