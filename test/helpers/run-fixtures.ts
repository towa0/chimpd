import type { MutantRecord } from '../../src/core/index.js';
import type { CallSite, CallSiteResult, FaultRunResult } from '../../src/fault-run/index.js';
import type { Finding, RunResult } from '../../src/orchestrator/index.js';
import type { RunPlan } from '../../src/plan/index.js';
import { severityOf } from '../../src/severity/index.js';
import type { BatchReport, MutationResult } from '../../src/stryker-adapter/index.js';

export function mutant(overrides: Partial<MutantRecord> = {}): MutantRecord {
  return {
    file: 'src/a.ts',
    start: { line: 2, column: 7 },
    end: { line: 2, column: 20 },
    mutatorName: 'EqualityOperator',
    replacement: 'total > 100',
    status: 'Survived',
    statusReason: null,
    coveredBy: ['test/a.test.ts#a'],
    killedBy: [],
    static: false,
    sourceHash: 'hash',
    scopeKind: 'changed',
    ...overrides,
  };
}

export function batch(overrides: Partial<BatchReport> = {}): BatchReport {
  return {
    index: 0,
    files: ['src/a.ts'],
    outcome: 'completed',
    elapsedMs: 10,
    planned: 1,
    tested: 1,
    error: null,
    strykerStartMs: 6,
    mutantsMs: 4,
    mutantsRun: 1,
    concurrency: 1,
    ...overrides,
  };
}

export function mutationResult(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    mutants: [],
    tests: [{ id: 'test/a.test.ts#a', name: 'a', file: 'test/a.test.ts' }],
    batches: [batch()],
    notTested: { reason: 'budget', mutants: 0, unplannedFiles: [] },
    staticSkipped: { count: 0, reason: 'static mutants are skipped because ignoreStatic is on' },
    outOfScope: 0,
    excludedByPreset: 0,
    checker: { enabled: false, reason: 'test', typescriptVersion: null, typescriptPath: null },
    targetConfigIgnored: null,
    strykerVersion: '10.1.1',
    dryRunNetMs: 5,
    timings: { batchesStarted: 1, strykerStartMs: 6, dryRunNetMs: 5, mutantsMs: 4, mutantsRun: 1 },
    ...overrides,
  };
}

export function site(overrides: Partial<CallSite> = {}): CallSite {
  return {
    key: 'src/a.ts:5:10',
    file: 'src/a.ts',
    line: 5,
    column: 10,
    functionName: 'load',
    path: 'fetch',
    frames: [{ file: 'src/a.ts', line: 5, column: 10, functionName: 'load' }],
    reachedFrom: [],
    scopeKind: 'changed',
    prior: 0,
    reachedBy: [{ test: { id: 't1', file: 'test/a.test.ts', name: 'loads' }, durationMs: 5, calls: 1, reachedFrom: [] }],
    unattributedCalls: 0,
    ...overrides,
  };
}

export function siteResult(overrides: Partial<CallSiteResult> = {}): CallSiteResult {
  return {
    site: site(),
    kind: 'blackhole',
    verdict: 'handled-timeout',
    findingKind: null,
    reason: 'every held request was aborted and its test passed',
    tests: [{ test: { id: 't1', file: 'test/a.test.ts', name: 'loads' }, observations: [], injected: null, problem: null }],
    ...overrides,
  };
}

export function faultRun(overrides: Partial<FaultRunResult> = {}): FaultRunResult {
  return {
    status: 'completed',
    statusReason: null,
    results: [],
    skipped: [],
    conflicts: [],
    outOfScopeSites: 0,
    spentMs: 10,
    timings: { discoveryMs: 8, faultRuns: 0, faultRunsMs: 0 },
    ...overrides,
  };
}

export function mutationFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: 'mutation',
    kind: 'survived',
    file: 'src/discount.ts',
    line: 3,
    column: 7,
    functionName: null,
    message: 'EqualityOperator mutant survived every test that covers it: orderTotal > 120',
    severity: severityOf('survived', 0),
    mutation: {
      mutatorName: 'EqualityOperator',
      replacement: 'orderTotal > 120',
      status: 'Survived',
      endLine: 3,
      endColumn: 24,
      coveredBy: ['test/discount.test.ts#applies'],
      statement: null,
    },
    fault: null,
    ...overrides,
  };
}

export function faultFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: 'fault',
    kind: 'hang-no-timeout',
    file: 'src/clients/ledger.ts',
    line: 12,
    column: 20,
    functionName: 'postLedgerEntry',
    message: 'the call has no timeout of its own and relies on runtime transport defaults',
    severity: severityOf('hang-no-timeout', 0),
    mutation: null,
    fault: {
      kind: 'blackhole',
      verdict: 'hang',
      path: 'http',
      tests: ['test/ledger.test.ts > posts a ledger entry'],
      reachedFrom: [],
      notFaultedFrom: [],
    },
    ...overrides,
  };
}

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'completed',
    statusReason: null,
    error: null,
    level: 'poke',
    budgetMs: 120_000,
    spentMs: 45_250,
    seed: 42,
    git: {
      base: 'origin/main',
      mergeBase: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      dirty: false,
    },
    scope: {
      mode: 'diff',
      changedSourceFiles: ['src/clients/ledger.ts', 'src/discount.ts'],
      changedTestFiles: [],
      ignoredFiles: [{ file: 'README.md', reason: 'not-typescript' }],
      notes: [],
      boundaryFiles: [],
    },
    phases: [
      { name: 'mutation', status: 'completed', statusReason: null, budgetMs: 84_000, spentMs: 30_000 },
      { name: 'faults', status: 'completed', statusReason: null, budgetMs: 90_000, spentMs: 15_000 },
    ],
    checked: { mutants: 12, invalidMutants: 0, callSites: 3 },
    findings: [faultFinding(), mutationFinding()],
    invalid: [],
    invalidExcluded: false,
    tally: { killed: 9, survived: 3, faults: [{ kind: 'blackhole', handled: 2, findings: 1, inconclusive: 0 }] },
    notTested: [],
    skipped: [],
    inconclusive: [],
    conflicts: [],
    ignored: [],
    baseline: null,
    ...overrides,
  };
}

export function runPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    status: 'planned',
    error: null,
    level: 'poke',
    seed: 7,
    git: { base: 'origin/main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40), dirty: false },
    scope: {
      mode: 'diff',
      changedSourceFiles: ['src/a.ts', 'src/b.ts'],
      changedTestFiles: ['test/a.test.ts'],
      ignoredFiles: [
        { file: 'README.md', reason: 'not-typescript' },
        { file: 'vitest.config.ts', reason: 'config-file' },
      ],
      notes: [],
      boundaryFiles: [],
    },
    scopeItems: [],
    vitestConfig: 'vitest.config.ts',
    runWouldFail: null,
    mutation: {
      files: [
        { file: 'src/a.ts', mutants: 8, moduleLevel: 2, reason: null },
        { file: 'src/b.ts', mutants: null, moduleLevel: null, reason: 'count unavailable: Unexpected token (1:5)' },
      ],
      total: null,
      batches: [['src/a.ts', 'src/b.ts']],
      ignoreStatic: true,
      staticReason: 'static mutants are only tested at Shake',
      notRun: null,
    },
    faults: {
      calls: [{ file: 'src/a.ts', line: 12, callee: 'fetch', scopeKind: 'changed' }],
      kinds: ['blackhole'],
      maxCallSites: 3,
      testsPerCallSite: 1,
      notRun: null,
    },
    budget: { totalMs: 120_000, mutationMs: 84_000, faultMs: 36_000 },
    estimate: {
      totalMs: 30_000,
      mutationMs: 18_000,
      faultMs: 12_000,
      calibrated: false,
      derivation: ['mutation: 1 batch x 10 s assumed Stryker start + 16 mutants x 0.5 s assumed each'],
    },
    ...overrides,
  };
}
