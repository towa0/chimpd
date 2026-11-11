import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSampleApp } from './sample-app.js';
import { assertUnderTemp, createTempRepo, repoNodeModules, repoRoot, type TempRepo } from './temp-repo.js';

const repos: TempRepo[] = [];

function track<T extends TempRepo>(repo: T): T {
  repos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

describe('temp repo guards', () => {
  it('refuses directories outside the OS temp dir', () => {
    expect(() => assertUnderTemp(repoRoot)).toThrow(/outside the OS temp dir|chimpd repository/);
    expect(() => assertUnderTemp(os.homedir())).toThrow(/outside the OS temp dir/);
    expect(() => assertUnderTemp(fs.realpathSync.native(os.tmpdir()))).toThrow(/outside the OS temp dir/);
  });

  it('accepts the repository it created', () => {
    const repo = track(createTempRepo());
    expect(() => assertUnderTemp(repo.dir)).not.toThrow();
  });

  it('rejects git commands that are neither read-only nor init, add, or commit', () => {
    const repo = track(createTempRepo());
    for (const command of ['push', 'checkout', 'reset', 'rebase', 'stash', 'remote', 'config']) {
      expect(() => repo.git(command)).toThrow(`git ${command} is not allowed in test helpers`);
    }
  });

  it('rejects file operations that leave the repository', () => {
    const repo = track(createTempRepo());
    expect(() => repo.write('../escape.txt', 'x')).toThrow(/outside the temp repository/);
  });
});

describe('temp repo isolation', () => {
  it('commits with the explicit identity and no signing', () => {
    const repo = track(createTempRepo());
    repo.write('a.txt', 'one\n');
    repo.commit('Add a');
    expect(repo.git('log', '-1', '--format=%an <%ae> | %cn <%ce> | %G?').trim()).toBe(
      'chimpd test <test@chimpd.invalid> | chimpd test <test@chimpd.invalid> | N',
    );
  });

  it('produces identical commit hashes for identical scripted histories', () => {
    const build = (): string => {
      const repo = track(createTempRepo());
      repo.write('a.txt', 'one\n');
      repo.commit('Add a');
      repo.write('a.txt', 'two\n');
      return repo.commit('Change a');
    };
    expect(build()).toBe(build());
  });

  it('stores files byte for byte, without line-ending conversion', () => {
    const repo = track(createTempRepo());
    repo.write('lf.txt', 'one\ntwo\n');
    repo.write('crlf.txt', 'one\r\ntwo\r\n');
    repo.commit('Add files');
    expect(repo.git('show', 'HEAD:lf.txt')).toBe('one\ntwo\n');
    expect(repo.git('show', 'HEAD:crlf.txt')).toBe('one\r\ntwo\r\n');
  });

  it('starts a branch from an earlier commit without checkout', () => {
    const repo = track(createTempRepo());
    repo.write('a.txt', 'one\n');
    const first = repo.commit('Add a');
    repo.write('main-only.txt', 'main\n');
    const mainTip = repo.commit('Advance main');
    repo.setRef('refs/remotes/origin/main', mainTip);

    repo.startBranch('feature', first);
    repo.remove('main-only.txt');
    repo.write('a.txt', 'feature\n');
    const featureTip = repo.commit('Change a on feature');

    expect(repo.git('log', '--format=%s').trim().split('\n')).toEqual(['Change a on feature', 'Add a']);
    expect(repo.git('merge-base', 'origin/main', 'HEAD').trim()).toBe(first);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(featureTip).not.toBe(mainTip);
  });
});

describe('sample app copies', () => {
  it('resolves vitest, stryker, and typescript from inside a temp copy', () => {
    const app = track(createSampleApp());
    const require = createRequire(path.join(app.dir, 'package.json'));
    for (const specifier of ['vitest/package.json', '@stryker-mutator/core/package.json', 'typescript']) {
      const resolved = require.resolve(specifier);
      expect(fs.existsSync(resolved), specifier).toBe(true);
    }
  });

  it('keeps the node_modules link out of history', () => {
    const app = track(createSampleApp());
    expect(app.git('status', '--porcelain')).toBe('');
    expect(app.git('show', '--stat', '--format=', 'HEAD')).not.toContain('node_modules');
    expect(app.git('merge-base', 'origin/main', 'HEAD').trim()).toBe(app.baseSha);
  });

  it('removes the link, not the repository node_modules, on cleanup', () => {
    const app = createSampleApp();
    const root = path.dirname(app.dir);
    expect(fs.lstatSync(path.join(app.dir, 'node_modules')).isSymbolicLink()).toBe(true);

    app.cleanup();

    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.join(repoNodeModules, 'vitest/package.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoNodeModules, '@stryker-mutator/core/package.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoNodeModules, 'typescript/package.json'))).toBe(true);
  });

  it('refuses cleanup when node_modules is a real directory', () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo.dir, 'node_modules'));
    expect(() => repo.cleanup()).toThrow(/real directory/);
    fs.rmdirSync(path.join(repo.dir, 'node_modules'));
    repo.cleanup();
  });
});
