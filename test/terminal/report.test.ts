import { describe, expect, it } from 'vitest';
import { renderText } from '../../src/reporter/index.js';
import { stripAnsi } from '../../src/terminal/color.js';
import { PLAIN, THEMED } from '../../src/terminal/theme.js';
import { renderFancyText } from '../../src/terminal/report.js';
import { severityOf } from '../../src/severity/index.js';
import { faultFinding, mutationFinding, runResult } from '../helpers/run-fixtures.js';

const ASCII = /^[\n\x20-\x7e]*$/;

describe('terminal report', () => {
  it('puts each finding on a line that starts with path:line:col and indents its reason under it', () => {
    const text = renderFancyText(runResult(), {}, PLAIN, 100);
    expect(text).toContain(
      [
        'Findings, most severe first:',
        'src/clients/ledger.ts:12:20 [high 70] in postLedgerEntry',
        '    hang-no-timeout: the call has no timeout of its own and relies on runtime transport defaults',
        '    faulted with blackhole under: test/ledger.test.ts > posts a ledger entry',
        'src/discount.ts:3:7 [medium 55]',
        '    survived: EqualityOperator mutant survived every test that covers it: orderTotal > 120',
      ].join('\n'),
    );
  });

  it('lists up to 20 findings, and every finding with allFindings', () => {
    const findings = Array.from({ length: 21 }, (_, index) => mutationFinding({ line: index + 1 }));
    const capped = renderFancyText(runResult({ findings }), {}, PLAIN, 100);
    expect(capped).toContain('src/discount.ts:20:7');
    expect(capped).not.toContain('src/discount.ts:21:7');
    expect(capped).toContain('  1 more finding not shown; --all-findings or --json lists every finding');
    const all = renderFancyText(runResult({ findings }), { allFindings: true }, PLAIN, 100);
    expect(all).toContain('src/discount.ts:21:7');
    expect(all).not.toContain('not shown');
  });

  it('ends with a summary of mutant and fault verdicts and the time, then the Result line', () => {
    const text = renderFancyText(runResult(), {}, PLAIN, 100);
    expect(text.endsWith('\nResult: 2 findings (exit 1)\n')).toBe(true);
    expect(text).toContain(
      [
        '+-----------------------------------------------------------+',
        '| Summary                                                   |',
        '| Mutants  killed 9, survived 3, invalid 0, not tested 0    |',
        '| Faults   blackhole: handled 2, findings 1, inconclusive 0 |',
        '| Time     45.3 s of 120.0 s                                |',
        '+-----------------------------------------------------------+',
        '',
        'Result: 2 findings (exit 1)',
      ].join('\n'),
    );
  });

  it('marks invalid mutants excluded in the summary when they are not a coverage gap', () => {
    const excluded = renderFancyText(runResult({ checked: { mutants: 7, invalidMutants: 3, callSites: 3 }, invalidExcluded: true }), {}, PLAIN, 40);
    expect(excluded).toContain('Mutants  killed 9, survived 3, invalid 3 (excluded), not tested 0');
    const gap = renderFancyText(runResult({ status: 'partial', checked: { mutants: 0, invalidMutants: 3, callSites: 3 } }), {}, PLAIN, 40);
    expect(gap).toContain('Mutants  killed 9, survived 3, invalid 3, not tested 0');
  });

  it('drops the box on a terminal too narrow for it, and keeps every line of the summary', () => {
    const text = renderFancyText(runResult(), {}, PLAIN, 40);
    expect(text).not.toContain('+---');
    expect(text).toContain('Summary\nMutants  killed 9, survived 3, invalid 0, not tested 0\nFaults   blackhole: handled 2');
  });

  it('keeps everything the plain report says apart from the findings layout and the closing summary', () => {
    const plain = renderText(runResult({ findings: [] }));
    const fancy = renderFancyText(runResult({ findings: [] }), {}, PLAIN, 100);
    const withoutSummary = fancy.slice(0, fancy.indexOf('+---'));
    expect(withoutSummary).toBe(plain.slice(0, plain.indexOf('Result:')));
  });

  it('colours severity by level: high bold magenta, medium blue, low yellow, with the label kept in the text', () => {
    const findings = [
      faultFinding(),
      mutationFinding(),
      mutationFinding({ line: 9, kind: 'no-coverage', severity: severityOf('no-coverage', -30) }),
    ];
    const coloured = renderFancyText(runResult({ level: 'prod', findings }), {}, THEMED, 100);
    expect(coloured).toContain('\u001b[1m\u001b[35m[high 70]\u001b[39m\u001b[22m');
    expect(coloured).toContain('\u001b[34m[medium 55]\u001b[39m');
    expect(coloured).toMatch(/\u001b\[33m\[low \d+\]\u001b\[39m/);
    expect(coloured).toContain('\u001b[2m    survived: EqualityOperator mutant survived every test that covers it: orderTotal > 120\u001b[22m');
    expect(stripAnsi(coloured)).toBe(renderFancyText(runResult({ level: 'prod', findings }), {}, PLAIN, 100));
  });

  it('colours section titles bold magenta, the summary by role and the box border dim', () => {
    const coloured = renderFancyText(runResult(), {}, THEMED, 100);
    expect(coloured).toContain('\u001b[1m\u001b[35mScope: ');
    expect(coloured).toContain('\u001b[1m\u001b[35mSummary\u001b[39m\u001b[22m');
    expect(coloured).toContain('\u001b[2m+-----');
    expect(coloured).toContain('\u001b[2m|\u001b[22m Mutants  ');
    expect(coloured).toContain('\u001b[32mkilled 9\u001b[39m');
    expect(coloured).toContain('\u001b[35msurvived 3\u001b[39m');
    expect(coloured).toContain('\u001b[32mhandled 2\u001b[39m');
    expect(coloured).toContain('\u001b[35mfindings 1\u001b[39m');
    expect(coloured).toContain('invalid 0, not tested 0');
    const warned = renderFancyText(
      runResult({ checked: { mutants: 7, invalidMutants: 3, callSites: 3 }, invalidExcluded: true, notTested: [{ file: 'src/a.ts', mutants: 2 }] }),
      {},
      THEMED,
      100,
    );
    expect(warned).toContain('\u001b[33minvalid 3 (excluded)\u001b[39m');
    expect(warned).toContain('\u001b[33mnot tested 2\u001b[39m');
  });

  it('colours the Result line bold by outcome: green clean, magenta findings, yellow partial, red exit 2 or error', () => {
    const line = (result: Parameters<typeof renderFancyText>[0], strict = false) =>
      renderFancyText(result, { strict }, THEMED, 100).trimEnd().split('\n').at(-1);
    expect(line(runResult({ findings: [] }))).toBe('\u001b[1m\u001b[32mResult: clean, everything in scope was checked (exit 0)\u001b[39m\u001b[22m');
    expect(line(runResult())).toBe('\u001b[1m\u001b[35mResult: 2 findings (exit 1)\u001b[39m\u001b[22m');
    const partial = runResult({ status: 'partial', findings: [], skipped: [{ source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' }] });
    expect(line(partial)).toMatch(/^\u001b\[1m\u001b\[33mResult: 0 findings, \u001b\[39m\u001b\[33mcoverage partial/);
    expect(line(partial, true)).toMatch(/^\u001b\[1m\u001b\[31mResult: /);
    expect(line(runResult({ status: 'error', error: 'base ref missing', phases: [], findings: [] }))).toMatch(/^\u001b\[1m\u001b\[31mResult: tool error/);
  });

  it('colours "coverage complete" green and "coverage partial" yellow inside a Result line of another colour', () => {
    const line = (result: Parameters<typeof renderFancyText>[0]) => renderFancyText(result, {}, THEMED, 100).trimEnd().split('\n').at(-1);
    const invalid = [{ source: 'mutation' as const, file: 'src/a.ts', line: 2, reason: 'compile error: x' }];
    expect(line(runResult({ invalid, invalidExcluded: true }))).toBe(
      '\u001b[1m\u001b[35mResult: 2 findings, \u001b[39m\u001b[32mcoverage complete\u001b[39m\u001b[35m, 1 invalid mutant excluded (exit 1)\u001b[39m\u001b[22m',
    );
    const partial = runResult({ status: 'partial', skipped: [{ source: 'mutation', file: 'src/a.ts', line: 2, reason: 'not tested: budget' }] });
    expect(line(partial)).toContain('\u001b[35mResult: 2 findings, \u001b[39m\u001b[33mcoverage partial\u001b[39m');
  });

  it('colours nothing with the plain theme', () => {
    const result = runResult({ checked: { mutants: 7, invalidMutants: 3, callSites: 3 }, invalidExcluded: true });
    expect(renderFancyText(result, {}, PLAIN, 100)).not.toContain('\u001b[');
  });

  it('uses ASCII only, with and without colour', () => {
    expect(renderFancyText(runResult(), {}, PLAIN, 100)).toMatch(ASCII);
    expect(renderFancyText(runResult(), {}, THEMED, 100)).toMatch(/^[\n\x1b\x20-\x7e]*$/);
  });

  it('says a phase did not run instead of counting zero', () => {
    const text = renderFancyText(
      runResult({
        phases: [
          { name: 'mutation', status: 'not-run', statusReason: 'no TypeScript source in scope to mutate', budgetMs: 0, spentMs: 0 },
          { name: 'faults', status: 'completed', statusReason: null, budgetMs: 120_000, spentMs: 10 },
        ],
        tally: { killed: 0, survived: 0, faults: [] },
      }),
      {},
      PLAIN,
      100,
    );
    expect(text).toContain('| Mutants  not run');
    expect(text).toContain('| Faults   no site faulted');
  });
});
