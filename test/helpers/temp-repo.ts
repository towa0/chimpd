import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const repoNodeModules = path.join(repoRoot, 'node_modules');

const WRITE_COMMANDS = new Set(['init', 'add', 'commit']);
const READ_COMMANDS = new Set(['log', 'diff', 'status', 'merge-base', 'show']);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertUnderTemp(dir: string): void {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const target = fs.realpathSync.native(dir);
  if (!isInside(tempRoot, target)) {
    throw new Error(`refusing to write git history outside the OS temp dir: ${dir}`);
  }
  if (target === repoRoot || isInside(repoRoot, target) || isInside(target, repoRoot)) {
    throw new Error(`refusing to write git history in or around the chimpd repository: ${dir}`);
  }
}

export interface TempRepoOptions {
  /** Directory copied into the new repository before `git init`. */
  readonly template?: string;
  readonly linkNodeModules?: boolean;
}

export interface TempRepo {
  readonly dir: string;
  git(...args: string[]): string;
  read(file: string): string;
  write(file: string, content: string): void;
  edit(file: string, from: string, to: string): void;
  remove(file: string): void;
  rename(from: string, to: string): void;
  lineOf(file: string, snippet: string): number;
  commit(message: string): string;
  head(): string;
  setRef(ref: string, sha: string): void;
  startBranch(name: string, sha: string): void;
  cleanup(): void;
}

function removeNodeModulesLink(workDir: string): void {
  const link = path.join(workDir, 'node_modules');
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isSymbolicLink()) {
    throw new Error(`refusing to delete ${link}: it is a real directory, not a link`);
  }
  try {
    fs.unlinkSync(link);
  } catch {
    // Windows removes a directory junction with rmdir; neither call follows the link.
    fs.rmdirSync(link);
  }
}

export function createTempRepo(options: TempRepoOptions = {}): TempRepo {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-'));
  const dir = path.join(root, 'repo');
  const globalConfig = path.join(root, 'gitconfig-global');
  const systemConfig = path.join(root, 'gitconfig-system');
  fs.mkdirSync(dir);
  fs.writeFileSync(globalConfig, '');
  fs.writeFileSync(systemConfig, '');

  if (options.template !== undefined) {
    fs.cpSync(options.template, dir, {
      recursive: true,
      filter: (source) => !['node_modules', '.chimpd'].includes(path.basename(source)),
    });
  }
  if (options.linkNodeModules === true) {
    fs.symlinkSync(repoNodeModules, path.join(dir, 'node_modules'), 'junction');
  }

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  let commits = 0;

  function environment(): NodeJS.ProcessEnv {
    // Fixed, increasing dates keep commit hashes identical across machines and runs.
    const date = `2026-01-01T00:${String(commits).padStart(2, '0')}:00Z`;
    return {
      ...inherited,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: root,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'chimpd test',
      GIT_AUTHOR_EMAIL: 'test@chimpd.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'chimpd test',
      GIT_COMMITTER_EMAIL: 'test@chimpd.invalid',
      GIT_COMMITTER_DATE: date,
    };
  }

  function git(...args: string[]): string {
    const command = args[0] ?? '';
    if (WRITE_COMMANDS.has(command)) assertUnderTemp(dir);
    else if (!READ_COMMANDS.has(command)) throw new Error(`git ${command} is not allowed in test helpers`);
    return execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args],
      { cwd: dir, env: environment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  function resolve(file: string): string {
    const target = path.resolve(dir, file);
    if (!isInside(dir, target)) throw new Error(`${file} is outside the temp repository`);
    return target;
  }

  function writeGitFile(relative: string, content: string): void {
    assertUnderTemp(dir);
    const target = path.join(dir, '.git', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const repo: TempRepo = {
    dir,
    git,
    read: (file) => fs.readFileSync(resolve(file), 'utf8'),
    write(file, content) {
      const target = resolve(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    edit(file, from, to) {
      const content = repo.read(file);
      const occurrences = content.split(from).length - 1;
      if (occurrences !== 1) throw new Error(`expected "${from}" once in ${file}, found ${occurrences}`);
      repo.write(file, content.replace(from, () => to));
    },
    remove: (file) => fs.rmSync(resolve(file)),
    rename(from, to) {
      const target = resolve(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(resolve(from), target);
    },
    lineOf(file, snippet) {
      const index = repo.read(file).split('\n').findIndex((line) => line.includes(snippet));
      if (index === -1) throw new Error(`"${snippet}" not found in ${file}`);
      return index + 1;
    },
    commit(message) {
      git('add', '-A');
      git('commit', '--quiet', '--allow-empty', '-m', message);
      commits += 1;
      return repo.head();
    },
    head: () => git('log', '-1', '--format=%H').trim(),
    // Refs are written as files so the helper never needs git commands beyond init, add, and commit.
    setRef: (ref, sha) => writeGitFile(ref, `${sha}\n`),
    startBranch(name, sha) {
      writeGitFile(`refs/heads/${name}`, `${sha}\n`);
      writeGitFile('HEAD', `ref: refs/heads/${name}\n`);
    },
    cleanup() {
      removeNodeModulesLink(dir);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };

  git('init', '--quiet', '--initial-branch=main');
  return repo;
}
