import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { removeTree } from '../../src/core/index.js';
import { createSampleApp, history, type SampleApp } from '../helpers/sample-app.js';
import { repoNodeModules, repoRoot } from '../helpers/temp-repo.js';

const RUN_TIMEOUT_MS = 600_000;

interface Manifest {
  readonly bin: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
}

let workDir: string | undefined;
let packageDir: string;
let binFile: string;
let packedFiles: string[];
let app: SampleApp | undefined;

function runBin(args: readonly string[]) {
  return spawnSync(process.execPath, [binFile, ...args], { encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS });
}

const STALE_FILE = 'dist/stale-leftover.js';

beforeAll(() => {
  // A stale build that packing must replace: a bin that exits 42 and a file no source produces.
  const dist = path.join(repoRoot, 'dist');
  removeTree(dist);
  fs.mkdirSync(path.join(dist, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'cli', 'main.js'), '#!/usr/bin/env node\nprocess.exit(42);\n');
  fs.writeFileSync(path.join(repoRoot, STALE_FILE), 'export {};\n');
  workDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'chimpd-pack-'));
  // npm is a script on Windows, so it is started through the shell everywhere.
  const packed = JSON.parse(
    execSync(`npm pack --json --pack-destination "${workDir}"`, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  ) as { filename: string; files: { path: string }[] }[];
  packedFiles = (packed[0]?.files ?? []).map((file) => file.path).sort();
  // A relative name, because GNU tar reads the drive colon of a Windows path as a remote host.
  execFileSync('tar', ['-xzf', packed[0]?.filename ?? ''], { cwd: workDir, stdio: 'pipe' });
  packageDir = path.join(workDir, 'package');
  // The packed copy resolves its dependencies through this link, as an installed package would through its own.
  fs.symlinkSync(repoNodeModules, path.join(packageDir, 'node_modules'), 'junction');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Manifest;
  binFile = path.join(packageDir, manifest.bin['chimpd'] ?? '');
}, RUN_TIMEOUT_MS);

afterAll(() => {
  app?.cleanup();
  if (workDir === undefined) return;
  const link = path.join(workDir, 'package', 'node_modules');
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    try {
      fs.unlinkSync(link);
    } catch {
      fs.rmdirSync(link);
    }
  }
  removeTree(workDir);
});

it('packs the built CLI, its library entry point and nothing from the sources or tests', () => {
  expect(packedFiles).toContain('dist/cli/main.js');
  expect(packedFiles).toContain('dist/index.js');
  expect(packedFiles).toContain('dist/index.d.ts');
  expect(packedFiles).toContain('dist/stryker-adapter/worker.js');
  expect(packedFiles).toContain('dist/fault-recon/runtime.js');
  expect(packedFiles).toContain('package.json');
  expect(packedFiles.filter((file) => file.startsWith('src/') || file.startsWith('test/'))).toEqual([]);
  expect(fs.readFileSync(binFile, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
});

it('builds a fresh dist when it packs, replacing a stale one', () => {
  expect(packedFiles).not.toContain(STALE_FILE);
  expect(fs.readFileSync(binFile, 'utf8')).not.toContain('process.exit(42)');
});

it('answers --help and rejects bad arguments from the packed bin', () => {
  const help = runBin(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('Usage: chimpd run --level poke|prod|shake');
  const bad = runBin(['run', '--level', 'gentle']);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain("chimpd: --level must be poke, prod or shake, not 'gentle'");
});

it(
  'runs from the packed tarball on the sample app and exits 1 with the surviving mutant',
  () => {
    app = createSampleApp();
    history.boundaryChange(app);
    const run = runBin(['run', '--level', 'poke', '--json', '--seed', '11', '--cwd', app.dir]);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as {
      schemaVersion: number;
      status: string;
      exitCode: number;
      seed: number;
      findings: { kind: string; file: string; mutation: { replacement: string } | null }[];
    };
    expect(report).toMatchObject({ schemaVersion: 1, status: 'completed', exitCode: 1, seed: 11 });
    expect(report.findings.map((finding) => [finding.kind, finding.file, finding.mutation?.replacement])).toEqual([
      ['survived', 'src/discount.ts', 'orderTotal > 120'],
    ]);
    expect(run.status).toBe(1);
    expect(app.git('status', '--porcelain')).toBe('');
  },
  RUN_TIMEOUT_MS,
);

it('reports a missing base ref from the packed bin as a tool error', () => {
  const target = app?.dir ?? repoRoot;
  const run = runBin(['run', '--level', 'poke', '--base', 'origin/does-not-exist', '--cwd', target]);
  expect(run.status).toBe(2);
  expect(run.stdout).toContain("Error: base ref 'origin/does-not-exist' does not resolve to a commit");
});
