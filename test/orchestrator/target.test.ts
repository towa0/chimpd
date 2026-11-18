import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mutationBudgetMs } from '../../src/orchestrator/budget.js';
import { findVitestConfig, isSupportedVitest, loadTargetVitest } from '../../src/orchestrator/target.js';
import { repoRoot } from '../helpers/temp-repo.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-target-'));
  dirs.push(dir);
  return dir;
}

describe('Vitest config lookup', () => {
  it('finds a vitest config before a vite config', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'vite.config.ts'), '');
    expect(findVitestConfig(dir)).toBe(path.join(dir, 'vite.config.ts'));
    fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), '');
    expect(findVitestConfig(dir)).toBe(path.join(dir, 'vitest.config.mjs'));
  });

  it('returns null when there is no config', () => {
    expect(findVitestConfig(tempDir())).toBeNull();
  });
});

describe('Vitest version support', () => {
  it('accepts 4.1 and later 4.x, and 5.x', () => {
    expect(['4.1.0', '4.1.12', '4.9.0', '5.0.0', '5.1.0'].map(isSupportedVitest)).toEqual([true, true, true, true, true]);
  });

  it('rejects older and newer majors and unparseable versions', () => {
    expect(['3.2.4', '4.0.9', '6.0.0', 'next', ''].map(isSupportedVitest)).toEqual([false, false, false, false, false]);
  });
});

describe('loading the target Vitest', () => {
  it('loads the Vitest that the target resolves', async () => {
    const loaded = await loadTargetVitest(repoRoot);
    expect(loaded.version).toBe('5.1.0');
    expect(typeof loaded.node.createVitest).toBe('function');
  });

  it('loads Vitest 4 from a target that has it', async () => {
    const loaded = await loadTargetVitest(path.join(repoRoot, 'test/compat/vitest-4'));
    expect(loaded.version).toBe('4.1.12');
    expect(typeof loaded.node.createVitest).toBe('function');
  });

  it('says so when Vitest is not installed', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await expect(loadTargetVitest(dir)).rejects.toThrow(`Vitest is not installed in ${dir}`);
  });

  it('refuses an unsupported Vitest version', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'node_modules/vitest'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node_modules/vitest/package.json'),
      JSON.stringify({ name: 'vitest', version: '3.2.4', exports: { './package.json': './package.json' } }),
    );
    await expect(loadTargetVitest(dir)).rejects.toThrow(`Vitest 3.2.4 in ${dir} is not supported; chimpd needs Vitest >=4.1 <6`);
  });
});

describe('mutation budget', () => {
  const input = { remainingMs: 100_000, mutationShare: 0.7, mutationInScope: true, faultsInScope: true };

  it('is the share of what is left when both phases have work', () => {
    expect(mutationBudgetMs(input)).toBe(70_000);
    expect(mutationBudgetMs({ ...input, remainingMs: 1001 })).toBe(700);
  });

  it('is everything left when the fault phase has nothing in scope', () => {
    expect(mutationBudgetMs({ ...input, faultsInScope: false })).toBe(100_000);
  });

  it('is zero when there is nothing to mutate', () => {
    expect(mutationBudgetMs({ ...input, mutationInScope: false })).toBe(0);
  });
});
