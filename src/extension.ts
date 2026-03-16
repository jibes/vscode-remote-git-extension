import * as vscode from 'vscode';
import { loadConfig } from './config';
import { SSHClient } from './sshClient';
import { RemoteGitProvider } from './remoteGitProvider';

let provider: RemoteGitProvider | undefined;
let ssh: SSHClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    const init = async (): Promise<void> => {
        provider?.dispose();
        ssh?.disconnect();
        provider = undefined;
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

        ssh = new SSHClient(config);
        try {
            await ssh.connect();
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `Remote Git: SSH connection to ${config.host} failed — ${String(err)}`,
            );
            return;
        }

        provider = new RemoteGitProvider(context, ssh, config, workspaceRoot);
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
        vscode.commands.registerCommand('remoteGit.push', () =>
            provider?.push(),
        ),
        vscode.commands.registerCommand('remoteGit.pull', () =>
            provider?.pull(),
        ),
        vscode.commands.registerCommand('remoteGit.stageAll', () =>
            provider?.stageAll(),
        ),
        vscode.commands.registerCommand('remoteGit.viewLog', () =>
            provider?.viewLog(),
        ),
        vscode.commands.registerCommand('remoteGit.checkoutBranch', () =>
            provider?.checkoutBranch(),
        ),
        vscode.commands.registerCommand('remoteGit.createBranch', () =>
            provider?.createBranch(),
        ),
        vscode.commands.registerCommand(
            'remoteGit.stageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    provider?.stageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.unstageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    provider?.unstageFile(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.discardChanges',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    provider?.discardChanges(decodeURIComponent(uri.path.replace(/^\//, '')));
                }
            },
        ),
        vscode.commands.registerCommand(
            'remoteGit.openDiff',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveUri(arg);
                if (uri) {
                    provider?.openDiff(uri);
                }
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
