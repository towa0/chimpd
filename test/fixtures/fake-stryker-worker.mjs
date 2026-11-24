import { spawn } from 'node:child_process';
import fs from 'node:fs';

const mutant = (id, status) => ({
  id,
  fileName: process.env.CHIMPD_FAKE_FILE,
  start: { line: 2, column: 7 },
  end: { line: 2, column: 24 },
  mutatorName: 'EqualityOperator',
  replacement: `replacement ${id}`,
  status,
  statusReason: null,
  coveredBy: ['test/a.test.ts#a'],
  killedBy: status === 'Killed' ? ['test/a.test.ts#a'] : [],
  static: false,
});

process.once('message', (start) => {
  if (process.env.CHIMPD_FAKE_OPTIONS) fs.appendFileSync(process.env.CHIMPD_FAKE_OPTIONS, `${JSON.stringify(start.options)}\n`);
  process.stdout.write('FAKE-WORKER-STDOUT\n');
  process.stderr.write('FAKE-WORKER-STDERR\n');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.appendFileSync(process.env.CHIMPD_FAKE_PIDS, `${grandchild.pid}\n`);

  process.send({
    type: 'dry-run',
    netMs: 5,
    tests: [{ id: 'test/a.test.ts#a', name: 'a', fileName: null, timeSpentMs: 1 }],
  });
  process.send({ type: 'plan', mutants: [mutant('1', null), mutant('2', null), mutant('3', 'Ignored')] });
  process.send({ type: 'mutant', mutant: mutant('1', 'Killed') });
  setInterval(() => {}, 1000);
});
