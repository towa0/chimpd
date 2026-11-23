import { describe, expect, it } from 'vitest';
import * as core from '../../src/core/index.js';
import type { MutantStatus } from '../../src/core/index.js';
import {
  BASE_SCORES,
  levelOf,
  MAX_PRIOR,
  mutationFindingKind,
  priorOf,
  severityOf,
  type FindingKind,
} from '../../src/severity/index.js';

describe('severity prior', () => {
  it('is the same function the core module exports', () => {
    expect(core.priorOf).toBe(priorOf);
    expect(core.MAX_PRIOR).toBe(MAX_PRIOR);
  });
});

describe('severity scale', () => {
  it('adds the prior to the base score of the finding kind', () => {
    expect(severityOf('survived', 0)).toEqual({ score: 55, level: 'medium', base: 55, prior: 0 });
    expect(severityOf('survived', priorOf('src/payments/refund.ts'))).toEqual({
      score: 70,
      level: 'high',
      base: 55,
      prior: 15,
    });
  });

  it('puts mutation and fault findings on one ordering', () => {
    const order = (Object.keys(BASE_SCORES) as FindingKind[]).sort(
      (a, b) => severityOf(b, 0).score - severityOf(a, 0).score,
    );
    expect(order).toEqual([
      'hang-no-timeout',
      'abort-mishandled',
      'refusal-mishandled',
      'error-status-ignored',
      'survived',
      'error-status-mishandled',
      'timeout-exceeds-budget',
      'invalid-ignore',
      'malformed-json-mishandled',
      'no-coverage',
      'fire-and-forget',
    ]);
  });

  it('lets a sensitive location lift a lesser kind above an unremarkable greater one', () => {
    expect(severityOf('no-coverage', priorOf('src/db/saveInvoice.ts')).score).toBeGreaterThan(
      severityOf('survived', priorOf('src/display.ts')).score,
    );
  });

  it('keeps the score within 0 to 100 whatever prior it is handed', () => {
    expect(severityOf('hang-no-timeout', 1000)).toMatchObject({ score: 95, prior: MAX_PRIOR });
    expect(severityOf('fire-and-forget', -5)).toMatchObject({ score: 40, prior: 0 });
  });

  it('maps scores to levels at 70 and 50', () => {
    expect([levelOf(100), levelOf(70), levelOf(69), levelOf(50), levelOf(49), levelOf(0)]).toEqual([
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'low',
    ]);
  });

  it('treats only survived and uncovered mutants as findings', () => {
    const statuses: MutantStatus[] = [
      'Killed',
      'Survived',
      'NoCoverage',
      'CompileError',
      'RuntimeError',
      'Timeout',
      'Ignored',
      'Pending',
      'NotTested',
    ];
    expect(statuses.map(mutationFindingKind)).toEqual([
      null,
      'survived',
      'no-coverage',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
