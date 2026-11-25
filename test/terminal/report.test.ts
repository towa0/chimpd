import { describe, expect, it } from 'vitest';
import { renderText } from '../../src/reporter/index.js';
import { COLORS, PLAIN, stripAnsi } from '../../src/terminal/color.js';
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
    expect(excluded).toContain('Mutants  killed 9, survived 3, invalid 3, excluded, not tested 0');
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

  it('colours severity, verdicts and the Result line, and is the plain-palette text without the codes', () => {
    const findings = [
      faultFinding(),
      mutationFinding(),
      mutationFinding({ line: 9, kind: 'no-coverage', severity: severityOf('no-coverage', -30) }),
    ];
    const coloured = renderFancyText(runResult({ level: 'prod', findings }), {}, COLORS, 100);
    expect(coloured).toContain('\u001b[31m[high 70]\u001b[39m');
    expect(coloured).toContain('\u001b[33m[medium 55]\u001b[39m');
    expect(coloured).toMatch(/\u001b\[2m\[low \d+\]\u001b\[22m/);
    expect(coloured).toContain('\u001b[32mkilled 9\u001b[39m');
    expect(coloured).toContain('\u001b[32mhandled 2\u001b[39m');
    expect(coloured).toContain('\u001b[1m\u001b[31msurvived 3\u001b[39m\u001b[22m');
    expect(coloured).toContain('\u001b[1mScope: ');
    expect(coloured).toContain('\u001b[31m\u001b[1mResult: 3 findings (exit 1)\u001b[22m\u001b[39m');
    expect(stripAnsi(coloured)).toBe(renderFancyText(runResult({ level: 'prod', findings }), {}, PLAIN, 100));
  });

  it('uses ASCII only', () => {
    expect(renderFancyText(runResult(), {}, PLAIN, 100)).toMatch(ASCII);
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
