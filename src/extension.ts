import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadConfig } from './config';
import { SSHClient } from './sshClient';
import { RemoteGitProvider } from './remoteGitProvider';
import { LocalGitProvider } from './localGitProvider';

let remoteProvider: RemoteGitProvider | undefined;
let localProvider: LocalGitProvider | undefined;
let ssh: SSHClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // -------------------------------------------------------------------------
    // Initialise / reinitialise both providers
    // -------------------------------------------------------------------------

    const init = async (): Promise<void> => {
        remoteProvider?.dispose();
        localProvider?.dispose();
        ssh?.disconnect();
        remoteProvider = undefined;
        localProvider = undefined;
        ssh = undefined;

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

        // -- Remote provider --------------------------------------------------
        ssh = new SSHClient(config);
        try {
            await ssh.connect();
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `Remote Git: SSH connection to ${config.host} failed — ${String(err)}`,
            );
            return;
        }
        remoteProvider = new RemoteGitProvider(context, ssh, config, workspaceRoot);

        // -- Local provider (only when a local .git clone exists) -------------
        if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
            localProvider = new LocalGitProvider(context, workspaceRoot);
        }
    };

    await init();

    // -------------------------------------------------------------------------
    // Re-initialise when config changes
    // -------------------------------------------------------------------------

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.vscode/remote-git.json'),
    );
    watcher.onDidCreate(() => init());
    watcher.onDidChange(() => init());
    watcher.onDidDelete(() => {
        remoteProvider?.dispose();
        localProvider?.dispose();
        ssh?.disconnect();
        remoteProvider = undefined;
        localProvider = undefined;
        ssh = undefined;
    });
    context.subscriptions.push(watcher);

    // -------------------------------------------------------------------------
    // Remote Git commands
    // -------------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('remoteGit.refresh', () =>
            remoteProvider?.refresh(),
        ),
        vscode.commands.registerCommand('remoteGit.commit', () =>
            remoteProvider?.commit(),
        ),
        vscode.commands.registerCommand('remoteGit.push', () =>
            remoteProvider?.push(),
        ),
        vscode.commands.registerCommand('remoteGit.pull', () =>
            remoteProvider?.pull(),
        ),
        vscode.commands.registerCommand('remoteGit.stageAll', () =>
            remoteProvider?.stageAll(),
        ),
        vscode.commands.registerCommand('remoteGit.viewLog', () =>
            remoteProvider?.viewLog(),
        ),
        vscode.commands.registerCommand('remoteGit.checkoutBranch', () =>
            remoteProvider?.checkoutBranch(),
        ),
        vscode.commands.registerCommand('remoteGit.createBranch', () =>
            remoteProvider?.createBranch(),
        ),
        vscode.commands.registerCommand(
            'remoteGit.stageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    remoteProvider?.stageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.unstageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    remoteProvider?.unstageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.discardChanges',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    remoteProvider?.discardChanges(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.openDiff',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    remoteProvider?.openDiff(uri);
                }
            },
        ),
    );

    // -------------------------------------------------------------------------
    // Local Git commands
    // -------------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('localGit.refresh', () =>
            localProvider?.refresh(),
        ),
        vscode.commands.registerCommand('localGit.commit', () =>
            localProvider?.commit(),
        ),
        vscode.commands.registerCommand('localGit.push', () =>
            localProvider?.push(),
        ),
        vscode.commands.registerCommand('localGit.pull', () =>
            localProvider?.pull(),
        ),
        vscode.commands.registerCommand('localGit.stageAll', () =>
            localProvider?.stageAll(),
        ),
        vscode.commands.registerCommand('localGit.viewLog', () =>
            localProvider?.viewLog(),
        ),
        vscode.commands.registerCommand('localGit.checkoutBranch', () =>
            localProvider?.checkoutBranch(),
        ),
        vscode.commands.registerCommand('localGit.createBranch', () =>
            localProvider?.createBranch(),
        ),
        vscode.commands.registerCommand(
            'localGit.stageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    localProvider?.stageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'localGit.unstageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    localProvider?.unstageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'localGit.discardChanges',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    localProvider?.discardChanges(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'localGit.openDiff',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    localProvider?.openDiff(uri);
                }
            },
        ),
    );
}

export function deactivate(): void {
    remoteProvider?.dispose();
    localProvider?.dispose();
    ssh?.disconnect();
    remoteProvider = undefined;
    localProvider = undefined;
    ssh = undefined;
}

// -------------------------------------------------------------------------

function resolveUri(
    arg: vscode.Uri | vscode.SourceControlResourceState | undefined,
): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    return (arg as vscode.SourceControlResourceState).resourceUri;
}
