import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realClearTimeout, realNow, realSetTimeout } from '../core/index.js';
import type { StartMessage, StrykerOptions, WorkerMessage } from './worker.js';

export type WorkerOutcome = 'completed' | 'failed' | 'killed';

export interface WorkerRun {
  readonly outcome: WorkerOutcome;
  readonly elapsedMs: number;
  readonly error: string | null;
}

export interface WorkerRequest {
  readonly cwd: string;
  readonly options: StrykerOptions;
  readonly killAfterMs: number;
  readonly entry?: string;
  onMessage(message: WorkerMessage): void;
}

export function workerPath(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));
}

// Only the uncompiled worker needs this, and only on Node versions that strip types behind a flag.
// The variable reaches Stryker's own child processes, which load the same file as a plugin.
function workerEnvironment(entry: string): NodeJS.ProcessEnv {
  const stripsTypes = (process.features as { typescript?: unknown }).typescript;
  if (!entry.endsWith('.ts') || stripsTypes) return process.env;
  const existing = process.env.NODE_OPTIONS ?? '';
  return { ...process.env, NODE_OPTIONS: `${existing} --experimental-strip-types`.trim() };
}

// Stryker runs its test runners and checkers in processes of its own, so the whole tree has to go.
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runWorker(request: WorkerRequest): Promise<WorkerRun> {
  const startedAt = realNow();
  return new Promise((resolve) => {
    const entry = request.entry ?? workerPath();
    const child = fork(entry, [], {
      cwd: request.cwd,
      execArgv: [],
      env: workerEnvironment(entry),
      // A process group of its own lets one signal reach every descendant on POSIX.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });

    let outcome: WorkerOutcome | null = null;
    let error: string | null = null;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });

    const timer = realSetTimeout(() => {
      outcome ??= 'killed';
      killTree(child);
    }, Math.max(0, request.killAfterMs));

    child.on('message', (message: WorkerMessage) => {
      if (outcome === 'killed') return;
      if (message.type === 'done') outcome = 'completed';
      else if (message.type === 'error') {
        outcome = 'failed';
        error = message.message;
      } else request.onMessage(message);
    });

    child.on('error', (cause) => {
      outcome ??= 'failed';
      error ??= cause.message;
    });

    child.on('close', (code) => {
      realClearTimeout(timer);
      if (outcome === null) {
        outcome = 'failed';
        error = `the Stryker process exited with code ${String(code)} before reporting a result: ${stderr.trim()}`;
      }
      resolve({ outcome, elapsedMs: realNow() - startedAt, error });
    });

    child.send({ type: 'start', options: request.options } satisfies StartMessage);
  });
}
