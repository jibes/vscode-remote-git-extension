import { exec } from 'child_process';

export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Thin wrapper around the local `git` binary via child_process.exec.
 * Mirrors the SSHClient.git() interface so callers can be written uniformly.
 */
export class LocalGitClient {
    constructor(readonly repoPath: string) {}

    git(args: string): Promise<ExecResult> {
        return new Promise(resolve => {
            exec(
                `git -C ${sq(this.repoPath)} ${args}`,
                { maxBuffer: 10 * 1024 * 1024 },
                (err, stdout, stderr) => {
                    // child_process sets err.code to the numeric exit code on failure
                    const raw = (err as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
                    const code = typeof raw === 'number' ? raw : err ? 1 : 0;
                    resolve({ stdout, stderr, code });
                },
            );
        });
    }
}

function sq(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
