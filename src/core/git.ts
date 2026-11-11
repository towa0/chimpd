import { execFile } from 'node:child_process';

const READ_ONLY_COMMANDS = new Set(['diff', 'log', 'merge-base', 'show', 'status']);

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

export function git(cwd: string, args: readonly string[]): Promise<string> {
  const command = args[0] ?? '';
  if (!READ_ONLY_COMMANDS.has(command)) {
    return Promise.reject(new Error(`git ${command} is not a read-only command`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr || error.message));
        else resolve(stdout);
      },
    );
  });
}

export async function resolveSha(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['log', '-1', '--format=%H', ref, '--'])).trim();
}

export async function mergeBase(cwd: string, base: string, head = 'HEAD'): Promise<string> {
  return (await git(cwd, ['merge-base', base, head])).trim();
}
