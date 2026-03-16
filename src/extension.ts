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

    // -------------------------------------------------------------------------
    // Initialise / reinitialise the provider from config
    // -------------------------------------------------------------------------

    const init = async (): Promise<void> => {
        // Tear down any existing connection
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
            // No config file present — remain dormant
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

    // -------------------------------------------------------------------------
    // Re-initialise when the config file is created or changed
    // -------------------------------------------------------------------------

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

        // stageFile receives a SourceControlResourceState from context menu,
        // or a plain Uri when called with arguments
        vscode.commands.registerCommand(
            'remoteGit.stageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveResourceUri(arg);
                if (uri) {
                    const relativePath = decodeURIComponent(uri.path.replace(/^\//, ''));
                    provider?.stageFile(relativePath);
                }
            },
        ),

        vscode.commands.registerCommand(
            'remoteGit.unstageFile',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveResourceUri(arg);
                if (uri) {
                    const relativePath = decodeURIComponent(uri.path.replace(/^\//, ''));
                    provider?.unstageFile(relativePath);
                }
            },
        ),

        vscode.commands.registerCommand(
            'remoteGit.discardChanges',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveResourceUri(arg);
                if (uri) {
                    const relativePath = decodeURIComponent(uri.path.replace(/^\//, ''));
                    provider?.discardChanges(relativePath);
                }
            },
        ),

        vscode.commands.registerCommand(
            'remoteGit.openDiff',
            (arg: vscode.Uri | vscode.SourceControlResourceState) => {
                const uri = resolveResourceUri(arg);
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

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Normalises the argument that VSCode passes to SCM commands:
 *   - When invoked from a resource state's `command.arguments`, we receive a Uri directly.
 *   - When invoked from a context menu, we receive the SourceControlResourceState object.
 */
function resolveResourceUri(
    arg: vscode.Uri | vscode.SourceControlResourceState | undefined,
): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    // SourceControlResourceState
    return (arg as vscode.SourceControlResourceState).resourceUri;
}
