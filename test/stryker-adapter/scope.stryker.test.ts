import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Intensity, MutantRecord } from '../../src/core/index.js';
import { scopeDiff } from '../../src/diff-scoper/index.js';
import { runMutation } from '../../src/stryker-adapter/index.js';
import { createSampleApp, type SampleApp } from '../helpers/sample-app.js';

const RUN_TIMEOUT_MS = 180_000;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

let app: SampleApp;

beforeAll(() => {
  app = createSampleApp();
  app.edit('src/discount.ts', 'orderTotal >= 100', 'orderTotal >= 120');
  app.commit('Raise the discount threshold');
  app.edit('src/pricing.ts', 'return Math.round(amount * rate * 100) / 100;', 'return amount > 0 ? Math.round(amount * rate * 100) / 100 : 0;');
});

afterAll(() => app.cleanup());

/** The added lines of every file, read from git itself against the base, the working tree included. */
function changedLines(): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of app.git('diff', '-U0', '--no-color', 'origin/main', '--').split('\n')) {
    if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length);
    const hunk = HUNK.exec(line);
    if (hunk === null || file === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const set = lines.get(file) ?? new Set<number>();
    for (let added = start; added < start + count; added += 1) set.add(added);
    lines.set(file, set);
  }
  return lines;
}

async function mutants(intensity: Intensity): Promise<readonly MutantRecord[]> {
  const scope = await scopeDiff({ repoRoot: app.dir, mode: intensity === 1 ? 'changed-lines' : 'enclosing-functions' });
  return (await runMutation({ targetRoot: app.dir, ranges: scope.ranges, intensity, ignoreStatic: true, budgetMs: 150_000 })).mutants;
}

function onChangedLine(mutant: MutantRecord, changed: Map<string, Set<number>>): boolean {
  return changed.get(mutant.file)?.has(mutant.start.line) === true;
}

describe('mutant locations against the changed lines of the diff', () => {
  it(
    'generates mutants only on changed lines, committed and uncommitted, when the scope is the changed lines',
    async () => {
      const changed = changedLines();
      expect(changed).toEqual(
        new Map([
          ['src/discount.ts', new Set([app.lineOf('src/discount.ts', 'orderTotal >= 120')])],
          ['src/pricing.ts', new Set([app.lineOf('src/pricing.ts', 'amount > 0 ?')])],
        ]),
      );
      const found = await mutants(1);
      expect(new Set(found.map((mutant) => mutant.file))).toEqual(new Set(['src/discount.ts', 'src/pricing.ts']));
      expect(found.filter((mutant) => !onChangedLine(mutant, changed))).toEqual([]);
      expect(found.every((mutant) => mutant.scopeKind === 'changed')).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'reaches unchanged lines only inside a changed function, marked as such, when the scope is the enclosing functions',
    async () => {
      const changed = changedLines();
      const found = await mutants(2);
      const outside = found.filter((mutant) => !onChangedLine(mutant, changed));
      expect(outside.length).toBeGreaterThan(0);
      expect(outside.every((mutant) => mutant.scopeKind === 'enclosing-function')).toBe(true);
      const functions = { 'src/discount.ts': [1, 6], 'src/pricing.ts': [3, 6] } as const;
      for (const mutant of outside) {
        const span = functions[mutant.file as keyof typeof functions];
        expect(span).toBeDefined();
        expect(mutant.start.line).toBeGreaterThanOrEqual(span[0]);
        expect(mutant.start.line).toBeLessThanOrEqual(span[1]);
      }
    },
    RUN_TIMEOUT_MS,
  );
});
