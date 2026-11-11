import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  git,
  isDeclarationFile,
  isTestFile,
  isTypeScriptFile,
  mergeBase,
  resolveSha,
  type ScopeKind,
  type ScopeMode,
  type ScopeRange,
} from '../core/index.js';
import { parseUnifiedDiff, type EntryType, type Hunk } from './parse-diff.js';
import { analyzeSource, type LineSpan, type SourceShape } from './source-shape.js';

export { parseUnifiedDiff, unquoteGitPath } from './parse-diff.js';
export type { FileDiff, Hunk } from './parse-diff.js';

export interface DiffScopeOptions {
  readonly repoRoot: string;
  readonly mode: ScopeMode;
  readonly base?: string;
  readonly ignoreWhitespace?: boolean;
}

export type IgnoredReason =
  | 'not-typescript'
  | 'declaration-file'
  | 'deleted'
  | 'binary'
  | 'submodule'
  | 'symlink';

export interface IgnoredFile {
  readonly file: string;
  readonly reason: IgnoredReason;
}

export interface ScopeNote {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface DiffScope {
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  /** True when the working tree has uncommitted changes or untracked files. */
  readonly dirty: boolean;
  readonly ranges: readonly ScopeRange[];
  readonly changedSourceFiles: readonly string[];
  readonly changedTestFiles: readonly string[];
  readonly ignoredFiles: readonly IgnoredFile[];
  readonly notes: readonly ScopeNote[];
}

export const DEFAULT_BASE = 'origin/main';

const KIND_ORDER: Record<ScopeKind, number> = { changed: 0, 'enclosing-function': 1, 'deletion-expanded': 2 };

interface Candidate {
  readonly file: string;
  readonly entryType: EntryType;
  readonly deleted: boolean;
  readonly binary: boolean;
  /** null means the whole file is new. */
  readonly hunks: readonly Hunk[] | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRanges(a: ScopeRange, b: ScopeRange): number {
  return (
    compareText(a.file, b.file) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  );
}

function rangeKey(range: ScopeRange): string {
  return `${range.file}:${range.startLine}:${range.endLine}:${range.kind}:${range.staticRegion}`;
}

function lineRange(file: string, span: LineSpan, kind: ScopeKind, staticRegion: boolean): ScopeRange {
  return { file, startLine: span.startLine, endLine: span.endLine, kind, staticRegion };
}

function changedRanges(file: string, hunk: Hunk, shape: SourceShape): ScopeRange[] {
  const ranges: ScopeRange[] = [];
  const last = Math.min(hunk.newStart + hunk.newLines - 1, shape.lineCount);
  let runStart = hunk.newStart;
  for (let line = hunk.newStart; line <= last; line += 1) {
    const staticRegion = shape.isStaticLine(line);
    if (line === last || shape.isStaticLine(line + 1) !== staticRegion) {
      ranges.push({ file, startLine: runStart, endLine: line, kind: 'changed', staticRegion });
      runStart = line + 1;
    }
  }
  return ranges;
}

function expandedRanges(file: string, hunk: Hunk, shape: SourceShape): ScopeRange[] {
  const spans = new Map<string, LineSpan>();
  const last = Math.min(hunk.newStart + hunk.newLines - 1, shape.lineCount);
  for (let line = hunk.newStart; line <= last; line += 1) {
    const span = shape.enclosingFunction(line);
    if (span !== null) spans.set(`${span.startLine}:${span.endLine}`, span);
  }
  return [...spans.values()].map((span) => lineRange(file, span, 'enclosing-function', false));
}

function scopeFile(file: string, hunks: readonly Hunk[], shape: SourceShape, mode: ScopeMode) {
  const ranges: ScopeRange[] = [];
  const notes: ScopeNote[] = [];
  for (const hunk of hunks) {
    if (hunk.newLines > 0) {
      ranges.push(...changedRanges(file, hunk, shape));
      if (mode === 'enclosing-functions') ranges.push(...expandedRanges(file, hunk, shape));
      continue;
    }
    const target = shape.deletionTargetAfter(hunk.newStart);
    if (typeof target === 'string') {
      const what = target === 'empty-class' ? 'class members' : 'top-level code';
      notes.push({ file, line: Math.max(hunk.newStart, 1), message: `deleted ${what}, nothing to mutate` });
    } else {
      ranges.push(lineRange(file, target, 'deletion-expanded', target.staticRegion));
    }
  }
  return { ranges, notes };
}

async function ignoredReason(repoRoot: string, candidate: Candidate): Promise<IgnoredReason | null> {
  if (candidate.entryType !== 'file') return candidate.entryType;
  if (candidate.deleted) return 'deleted';
  if (candidate.binary) return 'binary';
  if (!isTypeScriptFile(candidate.file)) return 'not-typescript';
  if (isDeclarationFile(candidate.file)) return 'declaration-file';
  // A link checked out on a platform with symlink support is a link on disk, whatever the index says.
  const stat = await lstat(path.join(repoRoot, candidate.file));
  return stat.isSymbolicLink() ? 'symlink' : null;
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

async function trackedCandidates(repoRoot: string, mergeBaseSha: string, ignoreWhitespace: boolean) {
  const args = ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--relative'];
  if (ignoreWhitespace) args.push('-w');
  args.push('--src-prefix=a/', '--dst-prefix=b/', mergeBaseSha, '--');

  const candidates: Candidate[] = [];
  for (const diff of parseUnifiedDiff(await git(repoRoot, args))) {
    const file = diff.newPath ?? diff.oldPath;
    if (file === null) continue;
    const deleted = diff.newPath === null;
    const hasContentChange = diff.hunks.length > 0 || diff.binary || deleted || diff.entryType !== 'file';
    if (!hasContentChange) continue;
    candidates.push({ file, entryType: diff.entryType, deleted, binary: diff.binary, hunks: diff.hunks });
  }
  return candidates;
}

async function untrackedCandidates(repoRoot: string): Promise<Candidate[]> {
  const listed = splitNul(await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
  return listed.map((entry) => ({
    file: entry.replace(/\/$/, ''),
    // Git lists an untracked nested repository as a directory instead of descending into it.
    entryType: entry.endsWith('/') ? 'submodule' : 'file',
    deleted: false,
    binary: false,
    hunks: null,
  }));
}

export async function scopeDiff(options: DiffScopeOptions): Promise<DiffScope> {
  const { repoRoot, mode } = options;
  const base = options.base ?? DEFAULT_BASE;
  const mergeBaseSha = await mergeBase(repoRoot, base);
  const head = await resolveSha(repoRoot, 'HEAD');
  const status = await git(repoRoot, ['status', '--porcelain', '-z']);

  const candidates = [
    ...(await trackedCandidates(repoRoot, mergeBaseSha, options.ignoreWhitespace ?? true)),
    ...(await untrackedCandidates(repoRoot)),
  ];

  const ranges = new Map<string, ScopeRange>();
  const notes: ScopeNote[] = [];
  const changedSourceFiles: string[] = [];
  const changedTestFiles: string[] = [];
  const ignoredFiles: IgnoredFile[] = [];

  for (const candidate of candidates) {
    const { file } = candidate;
    const reason = await ignoredReason(repoRoot, candidate);
    if (reason !== null) {
      ignoredFiles.push({ file, reason });
      continue;
    }
    if (isTestFile(file)) {
      changedTestFiles.push(file);
      continue;
    }
    changedSourceFiles.push(file);
    const shape = analyzeSource(file, await readFile(path.join(repoRoot, file), 'utf8'));
    const hunks = candidate.hunks ?? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: shape.lineCount }];
    const scoped = scopeFile(file, hunks, shape, mode);
    for (const range of scoped.ranges) ranges.set(rangeKey(range), range);
    notes.push(...scoped.notes);
  }

  return {
    base,
    mergeBase: mergeBaseSha,
    head,
    dirty: status.length > 0,
    ranges: [...ranges.values()].sort(compareRanges),
    changedSourceFiles: changedSourceFiles.sort(),
    changedTestFiles: changedTestFiles.sort(),
    ignoredFiles: ignoredFiles.sort((a, b) => compareText(a.file, b.file)),
    notes: notes.sort((a, b) => compareText(a.file, b.file) || a.line - b.line),
  };
}
