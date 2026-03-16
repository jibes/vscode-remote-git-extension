import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RemoteGitConfig } from './config';

export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

const KEY_CANDIDATES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

export class SSHClient {
    private client: ssh2.Client | null = null;
    private _connected = false;
    private connectPromise: Promise<void> | null = null;

    constructor(private readonly config: RemoteGitConfig) {}

    get connected(): boolean {
        return this._connected;
    }

    async connect(): Promise<void> {
        if (this._connected) {
            return;
        }
        // Deduplicate concurrent connect calls
        if (!this.connectPromise) {
            this.connectPromise = this._doConnect().finally(() => {
                this.connectPromise = null;
            });
        }
        return this.connectPromise;
    }

    private async _doConnect(): Promise<void> {
        const connectConfig = await this._buildConnectConfig();

        return new Promise<void>((resolve, reject) => {
            const client = new ssh2.Client();

            client.on('ready', () => {
                this.client = client;
                this._connected = true;
                resolve();
            });

            client.on('error', (err) => {
                this._connected = false;
                reject(err);
            });

            client.on('close', () => {
                this._connected = false;
                this.client = null;
            });

            client.connect(connectConfig);
        });
    }

    private async _buildConnectConfig(): Promise<ssh2.ConnectConfig> {
        const base: ssh2.ConnectConfig = {
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
            readyTimeout: 15000,
        };

        // Try configured identity file first, then common key locations
        const keyPaths = this.config.identityFile
            ? [this.config.identityFile]
            : KEY_CANDIDATES.map(k => path.join(os.homedir(), '.ssh', k));

        for (const keyPath of keyPaths) {
            if (fs.existsSync(keyPath)) {
                try {
                    base.privateKey = fs.readFileSync(keyPath);
                    return base;
                } catch {
                    // Key unreadable, try next
                }
            }
        }

        // Fall back to password auth
        const password = await vscode.window.showInputBox({
            prompt: `SSH password for ${this.config.username}@${this.config.host}`,
            password: true,
            ignoreFocusOut: true,
        });

        if (password === undefined) {
            throw new Error('Authentication cancelled');
        }

        base.password = password;
        return base;
    }

    /**
     * Executes an arbitrary shell command on the remote server.
     */
    async exec(command: string): Promise<ExecResult> {
        if (!this._connected) {
            await this.connect();
        }

        return new Promise<ExecResult>((resolve, reject) => {
            if (!this.client) {
                reject(new Error('SSH client not connected'));
                return;
            }

            this.client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('data', (data: Buffer) => {
                    stdout += data.toString('utf8');
                });

                stream.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString('utf8');
                });

                stream.on('close', (code: number) => {
                    resolve({ stdout, stderr, code: code ?? 0 });
                });
            });
        });
    }

    /**
     * Executes a git command scoped to the configured remotePath.
     * Equivalent to: git -C <remotePath> <args>
     */
    async git(args: string): Promise<ExecResult> {
        return this.exec(`git -C ${shellQuote(this.config.remotePath)} ${args}`);
    }

    disconnect(): void {
        this._connected = false;
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
