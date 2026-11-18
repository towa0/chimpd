import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { repoRoot } from '../helpers/temp-repo.js';

it('keeps AGENTS.local.md ignored by git', () => {
  const ignored = execFileSync('git', ['check-ignore', 'AGENTS.local.md'], { cwd: repoRoot, encoding: 'utf8' });
  expect(ignored.trim()).toBe('AGENTS.local.md');
});
